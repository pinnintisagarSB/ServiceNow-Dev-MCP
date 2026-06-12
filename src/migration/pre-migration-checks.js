/**
 * Pre-Migration Checks
 *
 * Runs before any data is pushed to ServiceNow:
 *   1. Picklist / Choice validation — source values exist in sys_choice
 *   2. Reference integrity         — referenced records exist in SN
 *   3. Required field coverage     — mandatory SN fields are populated
 *   4. Business rule conflict scan — warns about rules that may overwrite data
 */

import { logger } from '../utils/logger.js';

export class PreMigrationChecker {
  constructor(sn) {
    this.sn = sn;
  }

  // ── 1. Validate picklist values ────────────────────────────────────────────
  // For every mapped field that is a choice/select type, verify the source values
  // exist as valid sys_choice entries on the target table.
  async validateChoices(snTable, fieldMappings, sampleRecords) {
    logger.step('Checking picklist values…');
    const issues = [];

    // Discover which SN fields are choice fields on this table
    const dictRows = await this.sn.get('sys_dictionary', {
      sysparm_query:  `name=${snTable}^internal_type=integer^ORinternal_type=string^choice!=0`,
      sysparm_fields: 'element,internal_type,choice',
      sysparm_limit:  '200',
    });
    const choiceFields = new Set(dictRows.filter(r => r.choice && r.choice !== '0').map(r => r.element));

    // Load valid choices for each choice field we're mapping to
    const validChoices = {};
    for (const [sourceField, snField] of Object.entries(fieldMappings)) {
      if (!choiceFields.has(snField)) continue;
      const rows = await this.sn.get('sys_choice', {
        sysparm_query:  `name=${snTable}^element=${snField}`,
        sysparm_fields: 'value,label',
        sysparm_limit:  '200',
      });
      validChoices[snField] = new Set(rows.map(r => String(r.value)));
    }

    // Check sample records
    const badValues = {};
    for (const rec of sampleRecords) {
      for (const [sourceField, snField] of Object.entries(fieldMappings)) {
        if (!validChoices[snField]) continue;
        const v = String(rec[sourceField] ?? '');
        if (v && !validChoices[snField].has(v)) {
          if (!badValues[snField]) badValues[snField] = new Set();
          badValues[snField].add(v);
        }
      }
    }

    for (const [field, vals] of Object.entries(badValues)) {
      const validList = [...validChoices[field]].slice(0, 10).join(', ');
      issues.push({
        type:    'invalid_choice',
        field,
        bad_values: [...vals],
        valid_values_sample: validList,
        fix: `Map these source values to one of: ${validList}`,
      });
    }

    logger.info(`  Choice validation: ${Object.keys(validChoices).length} fields checked, ${issues.length} issues found`);
    return { issues, valid_choice_fields: validChoices };
  }

  // ── 2. Reference integrity check ───────────────────────────────────────────
  // For each reference field in the mapping, verify referenced sys_ids exist.
  // referenceFields: { snField: { table, lookupField } }
  async validateReferences(snTable, referenceFields, sampleRecords) {
    logger.step('Checking reference integrity…');
    const issues = [];

    for (const [snField, ref] of Object.entries(referenceFields)) {
      const values = [...new Set(
        sampleRecords.map(r => r[snField]).filter(Boolean)
      )];
      if (!values.length) continue;

      // Look up in batches of 100 using IN query
      const found = new Set();
      for (let i = 0; i < values.length; i += 100) {
        const batch = values.slice(i, i + 100);
        const query = batch.map(v => `${ref.lookupField ?? 'sys_id'}=${v}`).join('^OR');
        const rows  = await this.sn.get(ref.table, {
          sysparm_query:  query,
          sysparm_fields: ref.lookupField ?? 'sys_id',
          sysparm_limit:  '100',
        }).catch(() => []);
        rows.forEach(r => found.add(r[ref.lookupField ?? 'sys_id']));
      }

      const missing = values.filter(v => !found.has(v));
      if (missing.length) {
        issues.push({
          type:    'missing_reference',
          field:   snField,
          ref_table: ref.table,
          missing_values: missing.slice(0, 20),
          missing_count:  missing.length,
          fix: `Create the referenced records in ${ref.table} before migrating, or set a default value`,
        });
      }
    }

    logger.info(`  Reference check: ${Object.keys(referenceFields).length} ref fields, ${issues.length} issues found`);
    return issues;
  }

  // ── 3. Required field coverage ─────────────────────────────────────────────
  async validateRequiredFields(snTable, fieldMappings, sampleRecords) {
    logger.step('Checking required field coverage…');
    const issues = [];

    const mandatoryFields = await this.sn.get('sys_dictionary', {
      sysparm_query:  `name=${snTable}^mandatory=true^element!=NULL^elementNOT INsys_id,sys_created_by,sys_created_on,sys_updated_by,sys_updated_on`,
      sysparm_fields: 'element,column_label',
      sysparm_limit:  '100',
    });

    const mappedSnFields = new Set(Object.values(fieldMappings));

    for (const f of mandatoryFields) {
      if (!mappedSnFields.has(f.element)) {
        issues.push({
          type:  'missing_required_field',
          field: f.element,
          label: f.column_label,
          fix:   `Add a mapping or default value for required field "${f.column_label}" (${f.element})`,
        });
        continue;
      }
      // Check whether any sample record actually has a value
      const sourceField = Object.entries(fieldMappings).find(([,v]) => v === f.element)?.[0];
      if (sourceField) {
        const emptyCount = sampleRecords.filter(r => !r[sourceField] && r[sourceField] !== 0).length;
        if (emptyCount > 0) {
          issues.push({
            type:  'empty_required_field',
            field: f.element,
            label: f.column_label,
            empty_in_sample: emptyCount,
            sample_size: sampleRecords.length,
            fix: `${emptyCount}/${sampleRecords.length} records have no value for "${f.column_label}". Set a default.`,
          });
        }
      }
    }

    logger.info(`  Required field check: ${mandatoryFields.length} mandatory fields, ${issues.length} issues found`);
    return issues;
  }

  // ── 4. Business rule conflict scan ─────────────────────────────────────────
  // Finds active business rules on the target table that run on insert/update
  // and may overwrite values the migration just wrote.
  async scanBusinessRuleConflicts(snTable, fieldMappings) {
    logger.step('Scanning for business rule conflicts…');
    const warnings = [];

    const rules = await this.sn.get('sys_script', {
      sysparm_query:  `name=${snTable}^active=true^(action_insert=true^ORaction_update=true)`,
      sysparm_fields: 'name,action_insert,action_update,script,when,order',
      sysparm_limit:  '50',
    });

    const mappedFields = Object.values(fieldMappings);

    for (const rule of rules) {
      const script = rule.script ?? '';
      const touched = mappedFields.filter(f => script.includes(f));
      if (touched.length || rule.when === 'before') {
        warnings.push({
          type:        'business_rule_conflict',
          rule_name:   rule.name,
          when:        rule.when,
          on_insert:   rule.action_insert === 'true',
          on_update:   rule.action_update === 'true',
          fields_at_risk: touched,
          risk: touched.length
            ? `This rule may overwrite: ${touched.join(', ')}`
            : 'Before-save rule runs on every insert — may reject or alter records',
          fix: 'Consider temporarily disabling this rule during migration, or exclude its fields from the import.',
        });
      }
    }

    logger.info(`  Business rule scan: ${rules.length} rules checked, ${warnings.length} potential conflicts`);
    return warnings;
  }

  // ── Run all checks ─────────────────────────────────────────────────────────
  async runAll(snTable, fieldMappings, referenceFields, sampleRecords) {
    logger.header('Pre-Migration Checks');
    const [choiceIssues, refIssues, requiredIssues, brWarnings] = await Promise.all([
      this.validateChoices(snTable, fieldMappings, sampleRecords),
      this.validateReferences(snTable, referenceFields, sampleRecords),
      this.validateRequiredFields(snTable, fieldMappings, sampleRecords),
      this.scanBusinessRuleConflicts(snTable, fieldMappings),
    ]);

    const allIssues = [
      ...choiceIssues.issues,
      ...refIssues,
      ...requiredIssues,
      ...brWarnings,
    ];
    const blocking = allIssues.filter(i => i.type !== 'business_rule_conflict');
    const warnings = allIssues.filter(i => i.type === 'business_rule_conflict');

    logger.divider();
    if (blocking.length) logger.error(`${blocking.length} blocking issue(s) — fix before migrating`);
    if (warnings.length) logger.warn(`${warnings.length} warning(s) — review before migrating`);
    if (!allIssues.length) logger.success('All pre-migration checks passed ✓');

    return {
      passed:    allIssues.length === 0,
      blocking,
      warnings,
      detail: {
        choice_issues:   choiceIssues.issues,
        ref_issues:      refIssues,
        required_issues: requiredIssues,
        br_warnings:     brWarnings,
      },
    };
  }
}
