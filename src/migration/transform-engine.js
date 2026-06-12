/**
 * Field Transformation Engine
 *
 * Applies structured, configurable transforms to source records before they
 * reach the staging table. Handles:
 *   - Date / timezone conversion
 *   - Boolean normalization
 *   - Number formatting (strip currency, commas)
 *   - Status / state mapping tables
 *   - Custom JavaScript transform functions
 *   - Fallback defaults for empty fields
 */

export class TransformEngine {
  constructor(rules = []) {
    // rules: [{ sourceField, targetField, type, ...options }]
    this.rules = rules;
  }

  // ── Apply all rules to a single record ────────────────────────────────────
  apply(sourceRecord) {
    const out = { ...sourceRecord };
    for (const rule of this.rules) {
      try {
        const rawValue = sourceRecord[rule.sourceField];
        const transformed = this._applyRule(rawValue, rule, sourceRecord);
        if (transformed !== undefined) {
          out[rule.targetField ?? rule.sourceField] = transformed;
        }
      } catch (e) {
        // Leave field untransformed on error
        out[`_transform_error_${rule.sourceField}`] = e.message;
      }
    }
    return out;
  }

  applyBatch(records) {
    return records.map(r => this.apply(r));
  }

  // ── Rule dispatcher ────────────────────────────────────────────────────────
  _applyRule(value, rule, fullRecord) {
    if (value === undefined || value === null || value === '') {
      return rule.default !== undefined ? rule.default : undefined;
    }

    switch (rule.type) {
      case 'date':        return this._transformDate(value, rule);
      case 'boolean':     return this._transformBoolean(value);
      case 'number':      return this._transformNumber(value);
      case 'map':         return this._transformMap(value, rule);
      case 'trim':        return String(value).trim();
      case 'lowercase':   return String(value).toLowerCase();
      case 'uppercase':   return String(value).toUpperCase();
      case 'truncate':    return String(value).slice(0, rule.maxLength ?? 255);
      case 'prefix':      return `${rule.prefix ?? ''}${value}`;
      case 'suffix':      return `${value}${rule.suffix ?? ''}`;
      case 'regex':       return this._transformRegex(value, rule);
      case 'join':        return Array.isArray(value) ? value.join(rule.separator ?? ', ') : value;
      case 'split':       return String(value).split(rule.separator ?? ',').map(s => s.trim());
      case 'lookup':      return this._transformLookup(value, rule);
      case 'script':      return this._transformScript(value, rule, fullRecord);
      case 'conditional': return this._transformConditional(value, rule, fullRecord);
      case 'html_strip':  return String(value).replace(/<[^>]*>/g, '').trim();
      case 'glide_date':  return this._toGlideDate(value);
      case 'glide_datetime': return this._toGlideDateTime(value);
      default:            return value;
    }
  }

  // ── Date transforms ────────────────────────────────────────────────────────
  _transformDate(value, rule) {
    let date;
    if (typeof value === 'number') {
      // Unix timestamp (Jira uses milliseconds)
      date = new Date(value > 1e10 ? value : value * 1000);
    } else {
      date = new Date(value);
    }
    if (isNaN(date.getTime())) return rule.default ?? null;

    // Convert to target timezone
    if (rule.toTimezone) {
      const str = date.toLocaleString('en-US', { timeZone: rule.toTimezone });
      date = new Date(str);
    }

    const fmt = rule.outputFormat ?? 'glide_datetime';
    if (fmt === 'glide_datetime') return this._toGlideDateTime(date);
    if (fmt === 'glide_date')     return this._toGlideDate(date);
    if (fmt === 'iso')            return date.toISOString();
    return date.toISOString();
  }

  _toGlideDateTime(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return null;
    // SN expects: yyyy-MM-dd HH:mm:ss in UTC
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }

  _toGlideDate(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }

  // ── Boolean transform ──────────────────────────────────────────────────────
  _transformBoolean(value) {
    const truthy  = new Set(['true','yes','1','on','active','enabled','y']);
    const falsy   = new Set(['false','no','0','off','inactive','disabled','n','']);
    const v = String(value).toLowerCase().trim();
    if (truthy.has(v)) return 'true';
    if (falsy.has(v))  return 'false';
    return 'false';
  }

  // ── Number transform ───────────────────────────────────────────────────────
  _transformNumber(value) {
    // Strip currency symbols, commas, whitespace
    const cleaned = String(value).replace(/[$£€,\s]/g, '').trim();
    const n = Number(cleaned);
    return isNaN(n) ? null : n;
  }

  // ── Map / lookup table ─────────────────────────────────────────────────────
  // rule.map: { 'sourceValue': 'targetValue', ... }
  // rule.fallback: value to use when not found (default: original value)
  _transformMap(value, rule) {
    const map = rule.map ?? {};
    const key = String(value);
    if (key in map)           return map[key];
    if (rule.fallback !== undefined) return rule.fallback;
    return value;
  }

  // ── Regex extract / replace ────────────────────────────────────────────────
  _transformRegex(value, rule) {
    const re = new RegExp(rule.pattern, rule.flags ?? '');
    if (rule.replace !== undefined) return String(value).replace(re, rule.replace);
    const m = String(value).match(re);
    return m ? (m[rule.group ?? 0] ?? null) : null;
  }

  // ── Lookup: replace value with field from another record in the batch ──────
  _transformLookup(value, rule) {
    // Used when you have a local lookup table (map of sourceId → snSysId)
    const table = rule.lookupTable ?? {};
    return table[value] ?? rule.default ?? value;
  }

  // ── Custom JS transform ────────────────────────────────────────────────────
  _transformScript(value, rule, fullRecord) {
    // rule.fn: a function (value, record) => transformedValue
    if (typeof rule.fn === 'function') return rule.fn(value, fullRecord);
    // rule.script: string — evaluated as a function body
    if (typeof rule.script === 'string') {
      // eslint-disable-next-line no-new-func
      const fn = new Function('value', 'record', rule.script);
      return fn(value, fullRecord);
    }
    return value;
  }

  // ── Conditional ────────────────────────────────────────────────────────────
  // { type: 'conditional', condition: (v, rec) => bool, trueValue, falseValue }
  _transformConditional(value, rule, fullRecord) {
    const passes = typeof rule.condition === 'function'
      ? rule.condition(value, fullRecord)
      : value === rule.conditionValue;
    return passes ? rule.trueValue : rule.falseValue;
  }

  // ── Built-in status mapping presets ───────────────────────────────────────
  static jiraStatusToSnState() {
    return {
      type: 'map',
      map: {
        'To Do':        '-5',   // New
        'Open':         '1',    // Open
        'In Progress':  '2',    // In Progress
        'In Review':    '2',
        'Done':         '3',    // Closed
        'Closed':       '3',
        'Resolved':     '6',    // Resolved
        'Won\'t Do':    '7',    // Cancelled
        'Cancelled':    '7',
        'On Hold':      '16',   // On Hold
        'Waiting':      '16',
      },
      fallback: '1',
    };
  }

  static jiraPriorityToSnPriority() {
    return {
      type: 'map',
      map: {
        'Highest': '1',
        'High':    '2',
        'Medium':  '3',
        'Low':     '4',
        'Lowest':  '5',
        'Blocker': '1',
        'Critical':'1',
        'Major':   '2',
        'Minor':   '4',
        'Trivial': '5',
      },
      fallback: '3',
    };
  }

  static sfStatusToSnState() {
    return {
      type: 'map',
      map: {
        'New':          '1',
        'Open':         '1',
        'In Progress':  '2',
        'Pending':      '3',
        'Closed':       '3',
        'Resolved':     '6',
        'Cancelled':    '7',
        'On Hold':      '16',
        'Waiting on Customer': '16',
      },
      fallback: '1',
    };
  }

  static sfPriorityToSnPriority() {
    return {
      type: 'map',
      map: {
        'Critical': '1',
        'High':     '2',
        'Medium':   '3',
        'Low':      '4',
      },
      fallback: '3',
    };
  }
}
