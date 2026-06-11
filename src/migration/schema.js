import { SalesforceConnector } from '../connectors/salesforce.js';
import { JiraConnector }       from '../connectors/jira.js';
import { logger }               from '../utils/logger.js';
import { config }               from '../config.js';

/**
 * Discovers fields from a source platform and maps them to SN staging column definitions.
 */
export class SchemaDiscovery {
  constructor(sn) {
    this.sn = sn;
  }

  // ── Source Schema ──────────────────────────────────────────────────────────
  async discoverSalesforceSchema(sf, objectName) {
    logger.step(`Discovering Salesforce ${objectName} schema...`);
    const describe = await sf.describeObject(objectName);

    return describe.fields.map(f => ({
      source_field:  f.name,
      label:         f.label,
      sf_type:       f.type,
      required:      !f.nillable,
      is_reference:  f.type === 'reference',
      reference_to:  f.referenceTo?.[0] ?? null,
      max_length:    f.length,
      sn_column:     `u_sf_${f.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      ...SalesforceConnector.mapFieldType(f.type, f.length),
    }));
  }

  async discoverJiraSchema(jira, projectKey) {
    logger.step(`Discovering Jira ${projectKey} schema...`);
    const [fields, sample] = await Promise.all([
      jira.getAllFields(),
      jira.getSampleIssue(projectKey),
    ]);

    const usedFields = sample ? Object.keys(sample.fields) : [];
    const fieldMap   = Object.fromEntries(fields.map(f => [f.id, f]));

    // Core + used custom fields
    const coreIds = ['summary','description','status','priority','issuetype','assignee','reporter','created','updated','project','resolutiondate','duedate','labels','environment'];
    const allIds  = [...new Set([...coreIds, ...usedFields])];

    const discovered = allIds
      .filter(id => fieldMap[id])
      .map(id => {
        const f       = fieldMap[id];
        const jType   = f.schema?.type ?? 'string';
        const snBase  = `u_jira_${id.replace('customfield_', 'cf_').toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
        return {
          source_field:  id,
          label:         f.name,
          jira_type:     jType,
          required:      false,
          is_reference:  jType === 'user',
          sn_column:     snBase.length > 40 ? snBase.substring(0, 40) : snBase,
          ...JiraConnector.mapFieldType(jType),
        };
      });

    // Always include the issue key as a synthetic field — it's the primary unique identifier
    // (it lives on issue.key, not issue.fields, so it's never in fieldMap)
    if (!discovered.find(f => f.source_field === 'key')) {
      discovered.unshift({
        source_field:  'key',
        label:         'Issue Key',
        jira_type:     'string',
        required:      true,
        is_reference:  false,
        is_unique_id:  true,
        sn_column:     'u_jira_key',
        internal_type: 'string',
        max_length:    40,
      });
    }

    return discovered;
  }

  // ── Target Schema ──────────────────────────────────────────────────────────
  async discoverSnSchema(targetTable) {
    logger.step(`Discovering ServiceNow ${targetTable} schema...`);
    const fields = await this.sn.getTableSchema(targetTable);
    return fields
      .filter(f => f.element && !f.element.startsWith('sys_'))
      .map(f => ({
        field:     f.element,
        label:     f.column_label,
        type:      f.internal_type,
        reference: f.reference,
        mandatory: f.mandatory === 'true',
      }));
  }

  // ── Staging Table Definition ───────────────────────────────────────────────
  buildStagingDefinition(platform, objectName, sourceFields) {
    const prefix    = config.servicenow.scopePrefix;
    const shortPlatform = platform === 'salesforce' ? 'sf' : 'jira';
    const shortObj  = objectName.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 20);
    const tableName = `${prefix}_stg_${shortPlatform}_${shortObj}`;

    return {
      tableName,
      label:  `Migration Staging - ${platform.charAt(0).toUpperCase() + platform.slice(1)} ${objectName}`,
      columns: sourceFields.map(f => ({
        element:       f.sn_column,
        column_label:  f.label,
        internal_type: f.internal_type,
        max_length:    f.max_length,
      })),
    };
  }

  // ── Auto-suggest mappings ──────────────────────────────────────────────────
  suggestMappings(sourceFields, snFields, { platform = 'jira', objectName = '' } = {}) {
    const snIndex = Object.fromEntries(snFields.map(f => [f.field, f]));
    const hasCorrelationId = !!snIndex['correlation_id'];

    // SN fields that are good coalesce targets — unique/reference fields on the target table
    const snCoalesceFields = new Set([
      'correlation_id',     // used across SN tables for external system references
      'number',             // incident/problem/change number — unique per record
      'name',               // unique name fields
      'u_jira_key',         // custom field for jira key
      'u_sf_id',            // custom field for SF record id
      'u_external_id',      // generic external ID
      'employee_number',    // sys_user unique field
      'email',              // sys_user unique field
      'user_name',          // sys_user unique field
      'asset_tag',          // cmdb unique field
      'serial_number',      // cmdb unique field
    ]);

    // Composite coalesce detection — sys_user benefits from email + employee_number
    // pair; cmdb benefits from serial_number + asset_tag pair.
    const compositeCoalesce = new Set();
    const present = new Set(sourceFields.map(s => s.sn_column));
    const compositePairs = [
      ['email', 'employee_number'],
      ['serial_number', 'asset_tag'],
      ['name', 'manufacturer'],
    ];
    for (const pair of compositePairs) {
      if (pair.every(p => snIndex[p] && [...present].some(c => c.endsWith(p)))) {
        pair.forEach(p => compositeCoalesce.add(p));
      }
    }

    const mappings = sourceFields.map(sf => {
      // Try to auto-match by common naming conventions
      const candidates = [
        sf.source_field.toLowerCase(),
        sf.sn_column.replace(/^u_(sf|jira)_/, ''),
        // common field name aliases
        sf.source_field === 'summary'     ? 'short_description' : null,
        sf.source_field === 'description' ? 'description'       : null,
        sf.source_field === 'assignee'    ? 'assigned_to'       : null,
        sf.source_field === 'reporter'    ? 'caller_id'         : null,
        sf.source_field === 'created'     ? 'opened_at'         : null,
        sf.source_field === 'priority'    ? 'priority'          : null,
        sf.source_field === 'status'      ? 'state'             : null,
        sf.source_field === 'issuetype'   ? 'category'          : null,
        sf.source_field === 'duedate'     ? 'due_date'          : null,
        sf.source_field === 'Name'        ? 'name'              : null,
        sf.source_field === 'Subject'     ? 'short_description' : null,
        sf.source_field === 'Body'        ? 'description'       : null,
        sf.source_field === 'OwnerId'     ? 'assigned_to'       : null,
        sf.source_field === 'Status'      ? 'state'             : null,
        sf.source_field === 'Priority'    ? 'priority'          : null,
      ].filter(Boolean);

      let matched = null;
      for (const c of candidates) {
        if (snIndex[c]) { matched = snIndex[c]; break; }
      }

      // Determine coalesce:
      // true when this field is the natural unique identifier from the source
      // AND either maps to a known unique SN field or is a custom external-ref field
      const isSourceUniqueId =
        sf.is_unique_id ||                            // explicitly flagged (e.g. jira key)
        sf.source_field === 'Id' ||                   // Salesforce record ID
        sf.source_field === 'key' ||                  // Jira issue key
        sf.source_field === 'ExternalId' ||           // SF external ID
        sf.sn_column === 'u_jira_key' ||              // jira key staging column
        sf.sn_column === 'u_sf_id' ||                 // salesforce ID staging column
        sf.sn_column?.endsWith('_id') && sf.required; // required ID-like column

      const snTargetIsCoalesceable =
        !matched ||                                   // unmapped — will go to custom field
        snCoalesceFields.has(matched?.field) ||       // maps to known unique SN field
        matched?.field?.startsWith('u_');             // maps to any custom field (u_ prefix)

      let coalesce = isSourceUniqueId && snTargetIsCoalesceable;
      let coalesce_reason = coalesce
        ? `"${sf.source_field}" is the unique identifier from the source — used as upsert key to prevent duplicates on re-run`
        : null;

      // Composite coalesce (multi-field upsert key)
      if (matched && compositeCoalesce.has(matched.field)) {
        coalesce = true;
        coalesce_reason = `Part of composite upsert key — combined with the other coalesce fields to uniquely identify a record`;
      }

      const sourceType = sf.sf_type ?? sf.jira_type ?? '';
      const targetType = matched?.type ?? '';
      const needs_script = this._needsScript(sourceType, targetType, sf.source_field, matched?.field);

      // Reference field → generate GlideRecord lookup script automatically
      let transform_script = null;
      let resolved_script = false;
      if (sf.is_reference && matched && targetType === 'reference') {
        transform_script = this._referenceResolverScript(sf, matched);
        resolved_script = true;
      }

      return {
        staging_field:    sf.sn_column,
        source_field:     sf.source_field,
        sn_target:        matched?.field ?? null,
        coalesce,
        coalesce_reason,
        is_reference:     sf.is_reference,
        needs_script:     needs_script || resolved_script,
        script_reason:    resolved_script ? 'reference field — uses GlideRecord to resolve target sys_id' :
                          needs_script ? this._scriptReason(sourceType, targetType, sf.source_field, matched?.field) : null,
        transform_script,
        auto_matched:     !!matched,
        source_type:      sourceType,
      };
    });

    // Synthetic correlation_id mapping — the SN best-practice upsert key
    if (hasCorrelationId) {
      const idField = sourceFields.find(f => f.is_unique_id) ?? sourceFields.find(f => ['Id','key'].includes(f.source_field));
      if (idField && !mappings.find(m => m.sn_target === 'correlation_id')) {
        const prefix = platform === 'salesforce' ? 'salesforce' : 'jira';
        mappings.push({
          staging_field:   idField.sn_column,
          source_field:    idField.source_field,
          sn_target:       'correlation_id',
          coalesce:        true,
          coalesce_reason: `correlation_id is the SN-standard upsert key — using "${prefix}:<id>" prevents duplicates and enables reconciliation`,
          is_reference:    false,
          needs_script:    true,
          script_reason:   `prefix value with "${prefix}:" so the target row is uniquely identifiable across all source systems`,
          transform_script: `answer = '${prefix}:' + source.getValue('${idField.sn_column}');`,
          auto_matched:    true,
          source_type:     'string',
          synthetic:       true,
        });
      }
    }

    return mappings;
  }

  // GlideRecord lookup script for a reference target (caller_id, assigned_to, etc.)
  _referenceResolverScript(sf, matched) {
    const target = matched.reference || 'sys_user';
    const stagingField = sf.sn_column;
    if (target === 'sys_user') {
      return `
var _v = source.getValue('${stagingField}');
var u = new GlideRecord('sys_user');
u.addEncodedQuery('email=' + _v + '^ORuser_name=' + _v + '^ORemployee_number=' + _v + '^ORname=' + _v);
u.setLimit(1); u.query();
answer = u.next() ? u.getUniqueValue() : '';`.trim();
    }
    if (target.startsWith('cmdb')) {
      return `
var _v = source.getValue('${stagingField}');
var c = new GlideRecord('${target}');
c.addEncodedQuery('name=' + _v + '^ORserial_number=' + _v + '^ORasset_tag=' + _v);
c.setLimit(1); c.query();
answer = c.next() ? c.getUniqueValue() : '';`.trim();
    }
    return `
var _v = source.getValue('${stagingField}');
var g = new GlideRecord('${target}');
g.addEncodedQuery('name=' + _v + '^ORnumber=' + _v + '^ORsys_id=' + _v);
g.setLimit(1); g.query();
answer = g.next() ? g.getUniqueValue() : '';`.trim();
  }

  // ── Determine if a field needs an inline transform script ─────────────────
  // Compares source field type against SN target field type for every mapping.
  _needsScript(srcType, tgtType, srcField, tgtField) {
    // Explicit value-mapped types — source values don't match SN picklist integers
    if (['picklist', 'multipicklist', 'status', 'priority'].includes(srcType)) return true;

    // Jira/SF array/list fields must be joined to a string for SN
    if (['array', 'list', 'combobox'].includes(srcType)) return true;

    // Boolean source going into a non-boolean SN field (e.g. string/integer)
    if (srcType === 'boolean' && tgtType && tgtType !== 'boolean') return true;

    // String/textarea source going into an integer SN field — needs parseInt
    if (['string', 'textarea', 'text'].includes(srcType) && tgtType === 'integer') return true;

    // Jira date-time strings need reformatting for SN glide_date_time
    if (['datetime', 'date'].includes(srcType) && ['glide_date_time', 'glide_date'].includes(tgtType)) return true;

    // Jira/SF nested objects that land as a plain string in staging but target is a
    // structured SN field (e.g. issuetype → category, resolution → close_code)
    if (['option', 'resolution', 'issuelinks'].includes(srcType)) return true;

    // Well-known source→target field pairs that always need value translation
    const knownPairs = new Set([
      'priority:priority',   // Jira "High" → SN "2"
      'status:state',        // Jira "In Progress" → SN "2"
      'issuetype:category',  // Jira "Bug" → SN "software"
      'Status:state',        // SF "Open" → SN "1"
      'Priority:priority',   // SF "High" → SN "2"
    ]);
    if (srcField && tgtField && knownPairs.has(`${srcField}:${tgtField}`)) return true;

    return false;
  }

  _scriptReason(srcType, tgtType, srcField, tgtField) {
    if (['picklist', 'multipicklist'].includes(srcType)) return 'picklist values must be mapped to SN choice integers';
    if (srcType === 'status')    return 'status strings must be translated to SN state integers';
    if (srcType === 'priority')  return 'priority strings must be translated to SN priority integers (1-5)';
    if (['array', 'list'].includes(srcType)) return 'array must be joined to a comma-separated string';
    if (srcType === 'boolean' && tgtType !== 'boolean') return `boolean → ${tgtType} requires explicit conversion`;
    if (['string', 'textarea'].includes(srcType) && tgtType === 'integer') return 'string must be parsed to integer';
    if (['datetime', 'date'].includes(srcType)) return 'date format must be converted to SN glide_date_time format';
    if (['option', 'resolution'].includes(srcType)) return 'nested object — extract .name or .value before storing';
    if (srcField && tgtField) return `"${srcField}" → "${tgtField}" values require translation`;
    return 'value transform required';
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
