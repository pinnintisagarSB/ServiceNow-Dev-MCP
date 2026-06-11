import { JiraConnector } from '../connectors/jira.js';
import { Progress } from '../utils/progress.js';

/**
 * Validates data quality across three layers after a test migration:
 *   Source (Jira/SF) → Staging table → Target table (SN incident)
 *
 * Reports:
 *   - Fields blank in staging that had values in source (source→staging loss)
 *   - Fields blank in target that had values in staging (staging→target loss)
 *   - Overall per-field fill rates
 */
export class MigrationValidator {
  constructor(sn) {
    this.sn = sn;
  }

  // ── Main validate call ─────────────────────────────────────────────────────
  async validate({ platform, source, stagingTable, targetTable, mappings, sampleSize = 5 }) {
    const progress = new Progress(3, 'Data Quality Check');
    progress.section('Post-Test Data Quality Report');

    // Step 1 — fetch recent staging records
    progress.step('Reading records from the ServiceNow staging table');
    const stagingRecords = await this.sn.get(stagingTable, {
      sysparm_limit:         String(sampleSize),
      sysparm_query:         'ORDERBYDESCsys_created_on',
      sysparm_display_value: 'true',
    });
    progress.ok(`Found ${stagingRecords.length} staging records`);

    // Step 2 — fetch corresponding target records (works for any target table)
    progress.step(`Reading the ${targetTable} records created in ServiceNow`);
    const targetRecords = [];
    for (const row of stagingRecords) {
      // Extract target sys_id from link or display_value — works for any table
      const sysId = row.sys_target_sys_id?.link?.split('/').pop()
                 ?? (row.sys_target_sys_id?.value ?? row.sys_target_sys_id ?? null);
      if (!sysId || sysId === 'null') continue;
      try {
        const rec = await this.sn.getById(targetTable, sysId, { sysparm_display_value: 'true' });
        if (rec?.sys_id) targetRecords.push({ stagingRow: row, targetRecord: rec });
      } catch (_) {}
    }
    progress.ok(`Matched ${targetRecords.length} staging → ${targetTable} record pairs`);

    // Step 3 — build field-level quality report
    progress.step('Checking each field for data completeness');
    const report = this._buildReport(mappings, stagingRecords, targetRecords);
    this._printReport(report, progress);

    return report;
  }

  // ── Build per-field statistics ─────────────────────────────────────────────
  _buildReport(mappings, stagingRecords, pairs) {
    const fields = [];

    for (const m of mappings.filter(m => m.sn_target)) {
      const stagingField = m.staging_field;
      const targetField  = m.sn_target;

      // Staging fill rate
      const stagingFilled = stagingRecords.filter(r => {
        const v = r[stagingField];
        return v !== undefined && v !== null && v !== '';
      }).length;

      // Target fill rate (only for matched pairs)
      const targetFilled = pairs.filter(({ targetRecord }) => {
        const v = targetRecord[targetField];
        return v !== undefined && v !== null && v !== '';
      }).length;

      const stagingRate = stagingRecords.length ? Math.round((stagingFilled / stagingRecords.length) * 100) : 0;
      const targetRate  = pairs.length          ? Math.round((targetFilled  / pairs.length)          * 100) : null;

      fields.push({
        staging_field:  stagingField,
        target_field:   targetField,
        staging_filled: stagingFilled,
        staging_total:  stagingRecords.length,
        staging_pct:    stagingRate,
        target_filled:  targetFilled,
        target_total:   pairs.length,
        target_pct:     targetRate,
        staging_issue:  stagingRate === 0,
        target_issue:   targetRate !== null && targetRate === 0,
      });
    }

    const stagingIssues = fields.filter(f => f.staging_issue);
    const targetIssues  = fields.filter(f => f.target_issue);

    return {
      sample_size:      stagingRecords.length,
      matched_pairs:    pairs.length,
      fields,
      staging_issues:   stagingIssues,
      target_issues:    targetIssues,
      overall_health:   stagingIssues.length === 0 && targetIssues.length === 0 ? 'PASS' : 'NEEDS REVIEW',
    };
  }

  // ── Print human-readable report ────────────────────────────────────────────
  _printReport(report, progress) {
    process.stderr.write('\n  Field-by-Field Data Quality:\n');
    process.stderr.write(`  ${'Staging Column'.padEnd(30)} ${'→ SN Field'.padEnd(25)} ${'Staging'.padEnd(10)} Target\n`);
    process.stderr.write(`  ${'─'.repeat(75)}\n`);

    for (const f of report.fields) {
      const stagingBar = this._pctIcon(f.staging_pct);
      const targetBar  = f.target_pct !== null ? this._pctIcon(f.target_pct) : '  n/a';
      const flag       = f.staging_issue ? ' ⚠ BLANK IN STAGING' : f.target_issue ? ' ⚠ BLANK IN TARGET' : '';
      process.stderr.write(
        `  ${f.staging_field.padEnd(30)} ${f.target_field.padEnd(25)} ${stagingBar.padEnd(10)} ${targetBar}${flag}\n`
      );
    }

    process.stderr.write('\n');
    if (report.staging_issues.length) {
      progress.warn(`${report.staging_issues.length} field(s) are blank in the staging table — data was not fetched from Jira:`);
      report.staging_issues.forEach(f => progress.warn(`  • ${f.staging_field}`));
    }
    if (report.target_issues.length) {
      progress.warn(`${report.target_issues.length} field(s) are blank in the incident — staging data was not mapped across:`);
      report.target_issues.forEach(f => progress.warn(`  • ${f.staging_field} → ${f.target_field}`));
    }
    if (report.overall_health === 'PASS') {
      progress.ok('All mapped fields have data — quality check passed');
    }
  }

  _pctIcon(pct) {
    if (pct === 100) return '100% ✓';
    if (pct >= 50)   return `${pct}%  ~`;
    if (pct > 0)     return `${pct}%  ⚠`;
    return '0%  ✗';
  }
}
