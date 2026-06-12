/**
 * ServiceNow Performance Analyzer
 *
 * Analyses performance issues:
 *  - Slow query detection (missing indexes, full table scans)
 *  - Background job timing
 *  - System log analysis (node.log patterns)
 *  - Memory/session usage
 *  - Missing database indexes
 *
 * Connects to SN via Table API and optionally the Stats API.
 */

export class PerfAnalyzer {
  constructor(snConnector) {
    this.sn = snConnector;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Slow script log analysis
  // ══════════════════════════════════════════════════════════════════════════
  async findSlowScripts(opts = {}) {
    const minutesBack = opts.minutesBack ?? 60;
    const threshold   = opts.thresholdMs ?? 5000;

    const rows = await this.sn.query('syslog', {
      sysparm_query:  `messageLIKEBR^ORmessageLIKEScript^sys_created_onONLast ${minutesBack} minutes@javascript:gs.beginningOfLast60Minutes()@javascript:gs.endOfLast60Minutes()`,
      sysparm_fields: 'message,sys_created_on,source,level',
      sysparm_limit:  opts.limit ?? 200,
    });

    const slow = [];
    for (const row of rows) {
      const ms = this._extractMs(row.message);
      if (ms && ms >= threshold) {
        slow.push({
          time:    row.sys_created_on,
          source:  row.source,
          message: row.message,
          duration_ms: ms,
          severity: ms > 30000 ? 'critical' : ms > 10000 ? 'high' : 'medium',
        });
      }
    }

    slow.sort((a, b) => b.duration_ms - a.duration_ms);

    return {
      period_minutes:  minutesBack,
      threshold_ms:    threshold,
      slow_script_count: slow.length,
      top_slow:        slow.slice(0, 20),
      recommendation:  slow.length > 10
        ? 'High number of slow scripts — review Business Rules with no conditions set, or scripts with unindexed queries.'
        : slow.length > 0
        ? 'Some slow scripts detected — inspect top offenders and add limits/conditions.'
        : 'No slow scripts above threshold.',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Long-running scheduled jobs
  // ══════════════════════════════════════════════════════════════════════════
  async analyzeScheduledJobs(opts = {}) {
    const rows = await this.sn.query('syslog', {
      sysparm_query:  'messageLIKEScheduled',
      sysparm_fields: 'message,sys_created_on',
      sysparm_limit:  100,
    });

    const jobs = [];
    for (const row of rows) {
      const ms = this._extractMs(row.message);
      if (ms) {
        jobs.push({ time: row.sys_created_on, message: row.message, duration_ms: ms });
      }
    }

    jobs.sort((a, b) => b.duration_ms - a.duration_ms);
    return {
      analyzed: jobs.length,
      top_slow:  jobs.slice(0, 10),
      recommendation: 'Scheduled jobs over 30s should be broken into batches using a watermark pattern.',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Missing table index suggestions
  // ══════════════════════════════════════════════════════════════════════════
  async suggestIndexes(tableName) {
    const [fields, brs] = await Promise.all([
      this.sn.query('sys_dictionary', {
        sysparm_query: `name=${tableName}^internal_typeIN${['string','integer','reference','boolean'].join(',')}`,
        sysparm_fields: 'element,internal_type,reference',
        sysparm_limit: 200,
      }),
      this.sn.query('sys_script', {
        sysparm_query: `collection=${tableName}^active=true`,
        sysparm_fields: 'script',
        sysparm_limit: 50,
      }),
    ]);

    const existingIndexes = await this.sn.query('sys_db_index', {
      sysparm_query:  `table=${tableName}`,
      sysparm_fields: 'columns',
      sysparm_limit:  50,
    });

    const indexedCols = new Set(
      existingIndexes.flatMap(i => (i.columns ?? '').split(',').map(c => c.trim()))
    );

    // Find fields queried in BR scripts
    const queriedFields = new Set();
    for (const br of brs) {
      const script = br.script ?? '';
      const matches = [...script.matchAll(/addQuery\s*\(\s*['"](\w+)['"]/g)];
      matches.forEach(m => queriedFields.add(m[1]));
      const matches2 = [...script.matchAll(/addEncodedQuery.*?(\w+)=/g)];
      matches2.forEach(m => queriedFields.add(m[1]));
    }

    const suggestions = [];
    for (const field of queriedFields) {
      if (!indexedCols.has(field)) {
        const fieldInfo = fields.find(f => f.element === field);
        suggestions.push({
          field,
          type:         fieldInfo?.internal_type ?? 'unknown',
          reason:       `Field "${field}" is queried in Business Rules but has no index`,
          priority:     fieldInfo?.internal_type === 'reference' ? 'high' : 'medium',
          action:       `Navigate to sys_db_index and add an index on ${tableName}.${field}`,
        });
      }
    }

    return {
      table:              tableName,
      existing_indexes:   [...indexedCols],
      queried_fields:     [...queriedFields],
      index_suggestions:  suggestions,
      recommendation:     suggestions.length > 0
        ? `${suggestions.length} field(s) could benefit from an index. High-priority fields queried in BRs should be indexed first.`
        : 'No obvious missing indexes detected based on BR query patterns.',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Find error patterns in system logs
  // ══════════════════════════════════════════════════════════════════════════
  async analyzeErrors(opts = {}) {
    const rows = await this.sn.query('syslog', {
      sysparm_query:  `level=2^sys_created_onONLast ${opts.hours ?? 1} hours@javascript:gs.beginningOfLastHour()@javascript:gs.endOfLastHour()`,
      sysparm_fields: 'message,source,sys_created_on',
      sysparm_limit:  opts.limit ?? 500,
    });

    // Group by error pattern
    const patterns = {};
    for (const row of rows) {
      const key = this._normalizeError(row.message);
      if (!patterns[key]) patterns[key] = { pattern: key, count: 0, sample: row.message, sources: new Set() };
      patterns[key].count++;
      patterns[key].sources.add(row.source);
    }

    const sorted = Object.values(patterns)
      .map(p => ({ ...p, sources: [...p.sources] }))
      .sort((a, b) => b.count - a.count);

    return {
      total_errors:  rows.length,
      unique_patterns: sorted.length,
      top_errors:    sorted.slice(0, 15),
      recommendation: sorted.length > 0
        ? `Most frequent error: "${sorted[0].pattern}" (${sorted[0].count} occurrences). Address the top 3 patterns first.`
        : 'No errors found in the selected period.',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Business Rule performance audit for a table
  // ══════════════════════════════════════════════════════════════════════════
  async auditBusinessRules(tableName) {
    const rows = await this.sn.query('sys_script', {
      sysparm_query:  `collection=${tableName}^active=true`,
      sysparm_fields: 'name,when,filter_condition,action_update,condition,script,is_rest',
      sysparm_limit:  100,
    });

    const issues = [];

    for (const br of rows) {
      const script = br.script ?? '';

      // No condition — fires on every record
      if (!br.filter_condition && !br.condition && br.action_update === 'true') {
        issues.push({ br: br.name, severity: 'high', issue: 'No condition — fires on EVERY update', suggestion: 'Add a field condition to limit scope' });
      }

      // GlideRecord query inside
      if (/new GlideRecord/.test(script) && !/setLimit/.test(script)) {
        issues.push({ br: br.name, severity: 'high', issue: 'GlideRecord query without setLimit', suggestion: 'Add setLimit() to all GlideRecord queries in this BR' });
      }

      // Synchronous REST call
      if (/new RESTMessageV2/.test(script) && !br.is_rest && !/execute_async/.test(script)) {
        issues.push({ br: br.name, severity: 'critical', issue: 'Synchronous REST call in BR', suggestion: 'Move REST call to async BR or use executeAsync()' });
      }

      // Fires on query
      if (br.when === 'after' && /action_query/.test(JSON.stringify(br)) && /new GlideRecord/.test(script)) {
        issues.push({ br: br.name, severity: 'medium', issue: 'BR on query + GlideRecord inside — double query', suggestion: 'Avoid GlideRecord queries in "on query" BRs' });
      }
    }

    return {
      table:          tableName,
      rules_analyzed: rows.length,
      issues,
      issue_count:    issues.length,
      recommendation: issues.length === 0
        ? 'Business Rules look healthy.'
        : `${issues.filter(i => i.severity === 'critical').length} critical, ${issues.filter(i => i.severity === 'high').length} high-priority issues need attention.`,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  _extractMs(message) {
    const match = message && message.match(/(\d+)\s*ms/i);
    return match ? parseInt(match[1], 10) : null;
  }

  _normalizeError(message) {
    if (!message) return '(empty)';
    return message
      .replace(/sys_id=[a-f0-9]{32}/gi, 'sys_id=<SYS_ID>')
      .replace(/\b[a-f0-9]{32}\b/gi, '<SYS_ID>')
      .replace(/\d+/g, '<N>')
      .substring(0, 120);
  }
}
