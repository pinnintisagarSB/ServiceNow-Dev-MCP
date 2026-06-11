import { SalesforceConnector } from '../connectors/salesforce.js';
import { JiraConnector }       from '../connectors/jira.js';
import { logger }               from '../utils/logger.js';
import { config }               from '../config.js';

export class SchemaDiscovery {
  constructor(sn) {
    this.sn = sn;
  }

  // ── Generic source schema dispatcher ──────────────────────────────────────
  // Platform connectors register themselves here via registerConnector().
  // Built-in: 'salesforce', 'jira'. Any additional platform can be added
  // without touching this file — just call registerConnector() before use.
  static _connectors = {};

  static registerConnector(platformId, handler) {
    SchemaDiscovery._connectors[platformId.toLowerCase()] = handler;
  }

  async discoverSourceSchema(platform, connector, objectName) {
    const pid = platform.toLowerCase();
    if (pid === 'salesforce') return this.discoverSalesforceSchema(connector, objectName);
    if (pid === 'jira')       return this.discoverJiraSchema(connector, objectName);
    const handler = SchemaDiscovery._connectors[pid];
    if (handler) return handler(connector, objectName);
    throw new Error(
      `No schema connector registered for platform "${platform}". ` +
      `Register one with SchemaDiscovery.registerConnector('${platform}', async (conn, obj) => [...fields])`
    );
  }

  // ── Target table suggestion (live — no hardcoded table list) ──────────────
  // Uses the source object name + field labels to suggest the best SN target table.
  async suggestTargetTable(objectName, sourceFields = []) {
    // Build a rich hint from the object name + most common field labels
    const labelHints = sourceFields
      .slice(0, 20)
      .map(f => f.label ?? f.source_field)
      .join(' ');
    const hint = `${objectName} ${labelHints}`;

    const candidates = await this.sn.suggestTargetTable(objectName);

    // Re-rank by also considering field-label overlap
    const norm = s => (s ?? '').toLowerCase().replace(/[_\-]/g, ' ').replace(/\s+/g, ' ').trim();
    const allHintWords = new Set(
      norm(hint).split(' ').filter(w => w.length > 2)
    );
    const reranked = candidates.map(c => {
      const extraOverlap = norm(c.label ?? c.table)
        .split(' ')
        .filter(w => w.length > 2 && allHintWords.has(w)).length;
      return { ...c, score: c.score + extraOverlap * 5 };
    }).sort((a, b) => b.score - a.score);

    const top = reranked[0] ?? null;
    return {
      suggested_table:    top?.table ?? null,
      suggested_label:    top?.label ?? null,
      confidence:         top ? (top.score >= 80 ? 'high' : top.score >= 40 ? 'medium' : 'low') : 'none',
      alternatives:       reranked.slice(1, 6),
      custom_table_hint:  `u_${objectName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
    };
  }

  // ── Source Schema ──────────────────────────────────────────────────────────
  async discoverSalesforceSchema(sf, objectName) {
    logger.step(`Discovering Salesforce ${objectName} schema...`);
    const describe = await sf.describeObject(objectName);

    return describe.fields.map(f => ({
      source_field:   f.name,
      label:          f.label,
      sf_type:        f.type,
      required:       !f.nillable,
      is_reference:   f.type === 'reference',
      reference_to:   f.referenceTo?.[0] ?? null,
      max_length:     f.length,
      sn_column:      `u_sf_${f.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      // Live picklist values from the describe — no hardcoding needed
      picklist_values: f.picklistValues?.filter(v => v.active).map(v => v.value) ?? [],
      ...SalesforceConnector.mapFieldType(f.type, f.length),
    }));
  }

  async discoverJiraSchema(jira, projectKey) {
    logger.step(`Discovering Jira ${projectKey} schema...`);

    // Fetch fields, sample issue, AND live priorities + statuses in parallel
    const [fields, sample, priorities, statuses] = await Promise.all([
      jira.getAllFields(),
      jira.getSampleIssue(projectKey),
      jira.getPriorities().catch(() => []),
      jira.getStatuses(projectKey).catch(() => []),
    ]);

    // Flatten statuses per issue type into a unique set
    const statusNames = [...new Set(
      (Array.isArray(statuses) ? statuses : [])
        .flatMap(it => it.statuses ?? [])
        .map(s => s.name)
        .filter(Boolean)
    )];
    const priorityNames = priorities.map(p => p.name).filter(Boolean);

    const usedFields = sample ? Object.keys(sample.fields) : [];
    const fieldMap   = Object.fromEntries(fields.map(f => [f.id, f]));

    const coreIds = ['summary','description','status','priority','issuetype','assignee','reporter',
                     'created','updated','project','resolutiondate','duedate','labels','environment'];
    const allIds  = [...new Set([...coreIds, ...usedFields])];

    const discovered = allIds
      .filter(id => fieldMap[id])
      .map(id => {
        const f      = fieldMap[id];
        const jType  = f.schema?.type ?? 'string';
        const snBase = `u_jira_${id.replace('customfield_', 'cf_').toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

        // Attach live values for picklist-like types
        let picklist_values = [];
        if (id === 'priority')   picklist_values = priorityNames;
        if (id === 'status')     picklist_values = statusNames;
        if (id === 'issuetype')  picklist_values = (sample?.fields?.issuetype ? [] : []);

        return {
          source_field:    id,
          label:           f.name,
          jira_type:       jType,
          required:        false,
          is_reference:    jType === 'user',
          picklist_values,
          sn_column:       snBase.length > 40 ? snBase.substring(0, 40) : snBase,
          ...JiraConnector.mapFieldType(jType),
        };
      });

    // Fetch issue types live
    try {
      const issueTypes = await jira.getIssueTypes();
      const itField = discovered.find(f => f.source_field === 'issuetype');
      if (itField) itField.picklist_values = issueTypes.map(t => t.name).filter(Boolean);
    } catch (_) {}

    // Synthetic issue key field
    if (!discovered.find(f => f.source_field === 'key')) {
      discovered.unshift({
        source_field:    'key',
        label:           'Issue Key',
        jira_type:       'string',
        required:        true,
        is_reference:    false,
        is_unique_id:    true,
        picklist_values: [],
        sn_column:       'u_jira_key',
        internal_type:   'string',
        max_length:      40,
      });
    }

    return discovered;
  }

  // ── Target Schema — fetches fields AND sys_choice values from SN ──────────
  async discoverSnSchema(targetTable) {
    logger.step(`Discovering ServiceNow ${targetTable} schema...`);

    const [fields, choices] = await Promise.all([
      this.sn.getTableSchema(targetTable),
      this._fetchSnChoices(targetTable),
    ]);

    return fields
      .filter(f => f.element && !f.element.startsWith('sys_'))
      .map(f => ({
        field:     f.element,
        label:     f.column_label,
        type:      f.internal_type,
        reference: f.reference,
        mandatory: f.mandatory === 'true',
        // Live choice list from sys_choice — value:label pairs
        choices:   choices[f.element] ?? [],
      }));
  }

  async _fetchSnChoices(targetTable) {
    try {
      const rows = await this.sn.get('sys_choice', {
        sysparm_query:  `name=${targetTable}^inactive=false`,
        sysparm_fields: 'element,value,label',
        sysparm_limit:  '1000',
      });
      const grouped = {};
      for (const r of rows) {
        if (!grouped[r.element]) grouped[r.element] = [];
        grouped[r.element].push({ value: r.value, label: r.label });
      }
      return grouped;
    } catch (_) {
      return {};
    }
  }

  // ── Staging Table Definition ───────────────────────────────────────────────
  buildStagingDefinition(platform, objectName, sourceFields) {
    const prefix    = config.servicenow.scopePrefix;
    const shortPlat = platform.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 6);
    const shortObj  = objectName.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 20);
    const tableName = `${prefix}_stg_${shortPlat}_${shortObj}`;
    const plat      = platform.charAt(0).toUpperCase() + platform.slice(1);

    return {
      tableName,
      label:   `Migration Staging - ${plat} ${objectName}`,
      columns: sourceFields.map(f => ({
        element:       f.sn_column,
        column_label:  f.label,
        internal_type: f.internal_type ?? 'string',
        max_length:    f.max_length ?? 255,
      })),
    };
  }

  // ── Auto-suggest mappings (fully live-schema driven) ──────────────────────
  suggestMappings(sourceFields, snFields, { platform = 'jira', objectName = '' } = {}) {
    // Build two indexes: by field name and by normalised label
    const snByName  = Object.fromEntries(snFields.map(f => [f.field, f]));
    const snByLabel = Object.fromEntries(
      snFields.map(f => [this._normalise(f.label ?? f.field), f])
    );
    const hasCorrelationId = !!snByName['correlation_id'];

    // Fields that are structurally unique identifiers in SN (safe coalesce targets)
    const snUniqueFields = new Set(
      snFields
        .filter(f => f.mandatory || ['correlation_id','number','name','email','user_name',
                                     'employee_number','asset_tag','serial_number'].includes(f.field)
                  || f.field.startsWith('u_'))
        .map(f => f.field)
    );

    // Composite coalesce detection (runtime: only if BOTH fields exist in the target)
    const compositeCoalesce = new Set();
    const compositePairs    = [['email','employee_number'], ['serial_number','asset_tag']];
    for (const pair of compositePairs) {
      if (pair.every(p => snByName[p])) pair.forEach(p => compositeCoalesce.add(p));
    }

    const mappings = sourceFields.map(sf => {
      const matched = this._matchSnField(sf, snByName, snByLabel);

      const isSourceUniqueId =
        sf.is_unique_id ||
        sf.source_field === 'Id'        ||
        sf.source_field === 'key'       ||
        sf.source_field === 'ExternalId'||
        sf.sn_column === 'u_jira_key'   ||
        sf.sn_column === 'u_sf_id'      ||
        (sf.sn_column?.endsWith('_id') && sf.required);

      const snTargetIsCoalesceable =
        !matched || snUniqueFields.has(matched.field);

      let coalesce        = isSourceUniqueId && snTargetIsCoalesceable;
      let coalesce_reason = coalesce
        ? `"${sf.source_field}" is the unique identifier — used as upsert key to prevent duplicates on re-run`
        : null;

      if (matched && compositeCoalesce.has(matched.field)) {
        coalesce        = true;
        coalesce_reason = `Part of composite upsert key with the other coalesce field(s)`;
      }

      const sourceType = sf.sf_type ?? sf.jira_type ?? '';
      const targetType = matched?.type ?? '';
      const needs_script = this._needsScript(sourceType, targetType, sf.picklist_values ?? [], matched?.choices ?? []);

      // Build a live value map when both sides have known values
      let transform_script = null;
      let resolved_script  = false;

      if (sf.is_reference && matched && targetType === 'reference') {
        transform_script = this._referenceResolverScript(sf, matched);
        resolved_script  = true;
      } else if (needs_script && !sf.is_reference) {
        transform_script = this._buildValueMapScript(
          sf.sn_column, sf.picklist_values ?? [], matched?.choices ?? [], sourceType, matched?.field
        );
      }

      // Every source field is always included — never skip.
      // Unmapped fields get sn_target:null with an explanation so the user can act.
      const unmapped_reason = !matched
        ? `No ServiceNow field matched label "${sf.label ?? sf.source_field}" — ` +
          `will land in staging as "${sf.sn_column}". ` +
          `Either map it to an existing SN field or add a custom field on the target table.`
        : null;

      return {
        staging_field:    sf.sn_column,
        source_field:     sf.source_field,
        source_label:     sf.label ?? sf.source_field,
        source_type:      sourceType,
        sn_target:        matched?.field ?? null,
        sn_target_label:  matched?.label ?? null,
        coalesce,
        coalesce_reason,
        is_reference:     sf.is_reference,
        needs_script:     needs_script || resolved_script,
        script_reason:    resolved_script
          ? 'reference field — uses GlideRecord to resolve target sys_id'
          : needs_script
          ? this._scriptReason(sourceType, targetType)
          : null,
        transform_script,
        auto_matched:     !!matched,
        match_confidence: matched ? this._matchConfidence(sf, matched) : null,
        unmapped_reason,
        source_values:    sf.picklist_values?.length ? sf.picklist_values : undefined,
        target_choices:   matched?.choices?.length   ? matched.choices    : undefined,
      };
    });

    // Synthetic correlation_id mapping
    if (hasCorrelationId) {
      const idField = sourceFields.find(f => f.is_unique_id) ??
                      sourceFields.find(f => ['Id','key'].includes(f.source_field));
      if (idField && !mappings.find(m => m.sn_target === 'correlation_id')) {
        // Use the platform name as the prefix so it works for any source system
        const pfx = platform.toLowerCase().replace(/[^a-z0-9]/g, '_');
        mappings.push({
          staging_field:    idField.sn_column,
          source_field:     idField.source_field,
          source_label:     idField.label ?? idField.source_field,
          source_type:      'string',
          sn_target:        'correlation_id',
          sn_target_label:  'Correlation ID',
          coalesce:         true,
          coalesce_reason:  `correlation_id is the SN-standard upsert key — "${pfx}:<id>" prevents duplicates across runs`,
          is_reference:     false,
          needs_script:     true,
          script_reason:    `prefix with "${pfx}:" to uniquely identify records across all source systems`,
          transform_script: `answer = '${pfx}:' + source.getValue('${idField.sn_column}');`,
          auto_matched:     true,
          match_confidence: 'exact',
          unmapped_reason:  null,
          synthetic:        true,
        });
      }
    }

    return mappings;
  }

  // ── Field matching — live label similarity (no hardcoded aliases) ─────────
  _matchSnField(sf, snByName, snByLabel) {
    const candidates = [];

    // 1. Exact field name match
    const exactName = sf.source_field.toLowerCase();
    if (snByName[exactName]) candidates.push({ f: snByName[exactName], score: 100 });

    // 2. Strip platform prefix from staging column and try as field name
    const stripped = sf.sn_column.replace(/^u_(sf|jira)_/, '');
    if (snByName[stripped]) candidates.push({ f: snByName[stripped], score: 90 });

    // 3. Label similarity — normalise both sides and compare
    const srcLabel = this._normalise(sf.label ?? sf.source_field);
    for (const [normLabel, snField] of Object.entries(snByLabel)) {
      if (normLabel === srcLabel) {
        candidates.push({ f: snField, score: 85 });
      } else if (normLabel.includes(srcLabel) || srcLabel.includes(normLabel)) {
        candidates.push({ f: snField, score: 60 });
      }
    }

    // 4. Word-overlap similarity
    const srcWords = new Set(srcLabel.split(' ').filter(w => w.length > 2));
    for (const snField of Object.values(snByLabel)) {
      if (candidates.find(c => c.f.field === snField.field)) continue;
      const tgtWords = new Set(this._normalise(snField.label ?? snField.field).split(' ').filter(w => w.length > 2));
      const overlap  = [...srcWords].filter(w => tgtWords.has(w)).length;
      if (overlap > 0) {
        const score = Math.round((overlap / Math.max(srcWords.size, tgtWords.size)) * 50);
        if (score >= 30) candidates.push({ f: snField, score });
      }
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].score >= 30 ? candidates[0].f : null;
  }

  _normalise(str) {
    return (str ?? '')
      .toLowerCase()
      .replace(/[_\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _matchConfidence(sf, matched) {
    if (sf.source_field.toLowerCase() === matched.field) return 'exact';
    const srcLabel = this._normalise(sf.label ?? sf.source_field);
    const tgtLabel = this._normalise(matched.label ?? matched.field);
    if (srcLabel === tgtLabel) return 'label-match';
    return 'fuzzy';
  }

  // ── Needs-script decision (type-driven + live value presence) ────────────
  _needsScript(srcType, tgtType, sourceValues, targetChoices) {
    if (['picklist', 'multipicklist', 'status', 'priority', 'issuetype', 'option'].includes(srcType)) return true;
    if (['array', 'list', 'combobox'].includes(srcType)) return true;
    if (srcType === 'boolean' && tgtType && tgtType !== 'boolean') return true;
    if (['string', 'textarea', 'text'].includes(srcType) && tgtType === 'integer') return true;
    if (['datetime', 'date'].includes(srcType) && ['glide_date_time', 'glide_date'].includes(tgtType)) return true;
    if (['resolution', 'issuelinks'].includes(srcType)) return true;
    // If target has choices and source has values, a script is needed to map them
    if (targetChoices.length > 0 && sourceValues.length > 0) return true;
    return false;
  }

  _scriptReason(srcType, tgtType) {
    if (['picklist', 'multipicklist'].includes(srcType)) return 'picklist — source values must map to SN choice values';
    if (srcType === 'status')     return 'status — source status names must map to SN state values';
    if (srcType === 'priority')   return 'priority — source priority names must map to SN priority values';
    if (srcType === 'issuetype')  return 'issue type — source type names must map to SN category/type values';
    if (['array', 'list'].includes(srcType)) return 'array must be joined to a string';
    if (srcType === 'boolean')    return `boolean → ${tgtType} conversion required`;
    if (['string','textarea'].includes(srcType) && tgtType === 'integer') return 'string → integer parse required';
    if (['datetime','date'].includes(srcType)) return 'date format conversion required';
    if (srcType === 'option' || srcType === 'resolution') return 'nested object — extract .name value';
    return 'value transform required';
  }

  // ── Build value-map script from live source values + SN choices ───────────
  // Maps source values → SN choice values by label similarity.
  // Falls back to a passthrough if one side has no values.
  _buildValueMapScript(stagingField, sourceValues, targetChoices, srcType, tgtField) {
    // Array join
    if (['array', 'list', 'combobox'].includes(srcType)) {
      return `var _v = source.getValue('${stagingField}');\ntry { answer = JSON.parse(_v || '[]').join(', '); } catch(e) { answer = _v || ''; }`;
    }
    // Boolean
    if (srcType === 'boolean') {
      return `var _b = source.getValue('${stagingField}');\nanswer = (_b === 'true' || _b === '1') ? 'true' : 'false';`;
    }
    // Nested option/resolution objects
    if (['option', 'resolution'].includes(srcType)) {
      return `var _o = source.getValue('${stagingField}');\ntry { answer = JSON.parse(_o || '{}').name || _o || ''; } catch(e) { answer = _o || ''; }`;
    }

    // Build value map from live data if both sides have values
    if (sourceValues.length > 0 && targetChoices.length > 0) {
      const map = {};
      for (const sv of sourceValues) {
        const normSrc = this._normalise(sv);
        // Try exact match on value first, then label
        let best = targetChoices.find(tc => this._normalise(tc.value) === normSrc)
                ?? targetChoices.find(tc => this._normalise(tc.label) === normSrc);
        // Partial/word match fallback
        if (!best) {
          const srcWords = new Set(normSrc.split(' ').filter(w => w.length > 1));
          best = targetChoices.find(tc => {
            const tgtWords = new Set(this._normalise(tc.label ?? tc.value).split(' '));
            return [...srcWords].some(w => tgtWords.has(w));
          });
        }
        if (best) map[sv] = best.value;
      }

      if (Object.keys(map).length > 0) {
        const mapLiteral = JSON.stringify(map);
        return `var _v = source.getValue('${stagingField}');\nvar _map = ${mapLiteral};\nanswer = _map[_v] !== undefined ? _map[_v] : _v;`;
      }
    }

    // If only one side has values, or no match found — passthrough with comment
    if (sourceValues.length > 0) {
      const comment = `// Source values: ${sourceValues.slice(0, 5).join(', ')}${sourceValues.length > 5 ? '...' : ''}`;
      return `${comment}\n// TODO: map these to target values\nanswer = source.getValue('${stagingField}');`;
    }

    return `answer = source.getValue('${stagingField}');`;
  }

  // ── GlideRecord lookup for reference target fields ────────────────────────
  _referenceResolverScript(sf, matched) {
    const target      = matched.reference || 'sys_user';
    const stagingField = sf.sn_column;
    if (target === 'sys_user') {
      return `var _v = source.getValue('${stagingField}');\nvar u = new GlideRecord('sys_user');\nu.addEncodedQuery('email=' + _v + '^ORuser_name=' + _v + '^ORemployee_number=' + _v + '^ORname=' + _v);\nu.setLimit(1); u.query();\nanswer = u.next() ? u.getUniqueValue() : '';`;
    }
    if (target.startsWith('cmdb')) {
      return `var _v = source.getValue('${stagingField}');\nvar c = new GlideRecord('${target}');\nc.addEncodedQuery('name=' + _v + '^ORserial_number=' + _v + '^ORasset_tag=' + _v);\nc.setLimit(1); c.query();\nanswer = c.next() ? c.getUniqueValue() : '';`;
    }
    return `var _v = source.getValue('${stagingField}');\nvar g = new GlideRecord('${target}');\ng.addEncodedQuery('name=' + _v + '^ORnumber=' + _v + '^ORsys_id=' + _v);\ng.setLimit(1); g.query();\nanswer = g.next() ? g.getUniqueValue() : '';`;
  }

  // ── Print schemas side-by-side ─────────────────────────────────────────────
  printSchemas(platform, objectName, sourceFields, snFields) {
    logger.header(`Schema: ${platform} ${objectName} → ServiceNow`);
    console.log('\nSource Fields:');
    console.log(`${'Field Name'.padEnd(35)} ${'Label'.padEnd(30)} ${'Type'.padEnd(15)} Req`);
    logger.divider();
    sourceFields.slice(0, 30).forEach(f => {
      const req = f.required ? '✓' : ' ';
      console.log(`${f.source_field.padEnd(35)} ${f.label.padEnd(30)} ${(f.sf_type ?? f.jira_type ?? '').padEnd(15)} ${req}`);
    });
    if (sourceFields.length > 30) logger.info(`... and ${sourceFields.length - 30} more fields`);
    console.log('\nServiceNow Target Fields:');
    console.log(`${'Field Name'.padEnd(35)} ${'Label'.padEnd(30)} ${'Type'.padEnd(15)} Mand`);
    logger.divider();
    snFields.forEach(f => {
      const mand = f.mandatory ? '✓' : ' ';
      console.log(`${f.field.padEnd(35)} ${(f.label ?? '').padEnd(30)} ${f.type.padEnd(15)} ${mand}`);
    });
  }
}
