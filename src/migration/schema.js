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
      sn_column:     `sf_${f.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
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
    const coreIds = ['summary','description','status','priority','issuetype','assignee','reporter','created','updated','project'];
    const allIds  = [...new Set([...coreIds, ...usedFields])];

    return allIds
      .filter(id => fieldMap[id])
      .map(id => {
        const f       = fieldMap[id];
        const jType   = f.schema?.type ?? 'string';
        const snCol   = `jira_${id.replace('customfield_', 'cf_').toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
        return {
          source_field:  id,
          label:         f.name,
          jira_type:     jType,
          required:      false,
          is_reference:  jType === 'user',
          sn_column:     snCol.length > 40 ? snCol.substring(0, 40) : snCol,
          ...JiraConnector.mapFieldType(jType),
        };
      });
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
  suggestMappings(sourceFields, snFields) {
    const snIndex = Object.fromEntries(snFields.map(f => [f.field, f]));
    return sourceFields.map(sf => {
      // Try to auto-match by common naming conventions
      const candidates = [
        sf.source_field.toLowerCase(),
        sf.sn_column.replace(/^(sf|jira)_/, ''),
      ];

      let matched = null;
      for (const c of candidates) {
        if (snIndex[c]) { matched = snIndex[c]; break; }
      }

      return {
        staging_field:  sf.sn_column,
        source_field:   sf.source_field,
        sn_target:      matched?.field ?? null,
        coalesce:       sf.source_field === 'Id' || sf.source_field === 'key',
        is_reference:   sf.is_reference,
        needs_script:   sf.sf_type === 'picklist' || sf.jira_type === 'status' || sf.jira_type === 'priority',
        auto_matched:   !!matched,
        source_type:    sf.sf_type ?? sf.jira_type,
      };
    });
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
