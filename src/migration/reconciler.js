/**
 * Migration Reconciler
 *
 * Deep comparison engine that verifies migrated data is correct — not just
 * that fields are non-empty, but that the VALUES in the target match what was
 * in the source after applying the expected transformations.
 *
 * Three comparison layers:
 *   1. Count check       — source count == target count?
 *   2. Record matching   — every source record has a corresponding target record
 *   3. Field-level diff  — for each matched pair, compare every mapped field
 *
 * Transform-aware: you can register the same transform rules used during
 * migration so that, e.g., a Jira "In Progress" → SN state "2" is not
 * flagged as a mismatch.
 *
 * Output:
 *   { verdict, summary, mismatched_records, missing_records, extra_records,
 *     field_stats, sample_diffs }
 */

import { logger } from '../utils/logger.js';

// ── Value normalisation helpers ────────────────────────────────────────────
function norm(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    // SN display_value object: { value, display_value }
    if ('value' in v) return String(v.value ?? '').trim();
    return JSON.stringify(v);
  }
  return String(v).trim();
}

function normDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v).trim() : d.toISOString().slice(0, 10);
}

export class MigrationReconciler {
  /**
   * @param {object} sn    ServiceNow connector
   * @param {object} opts
   * @param {Map}    opts.transformMap  sourceValue → expectedTargetValue (for mapped fields)
   * @param {Set}    opts.dateFields    field names that should be compared as dates only
   * @param {Set}    opts.ignoredFields field names to skip in value comparison
   * @param {number} opts.sampleDiffs   max per-record diffs to include in output (default 20)
   */
  constructor(sn, opts = {}) {
    this.sn           = sn;
    this.transformMap = opts.transformMap ?? new Map();   // Map<snField, Map<srcVal, expectedVal>>
    this.dateFields   = opts.dateFields   ?? new Set();
    this.ignoredFields = opts.ignoredFields ?? new Set(['sys_created_on','sys_updated_on','sys_created_by','sys_updated_by','sys_mod_count']);
    this.sampleDiffs  = opts.sampleDiffs  ?? 20;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Main entry point
  // ══════════════════════════════════════════════════════════════════════════
  /**
   * @param {object[]} sourceRecords   Raw records from source platform (Jira/SF)
   * @param {string}   snTable         Target ServiceNow table
   * @param {object}   fieldMappings   { sourceField: snField }
   * @param {string}   correlationField  Field in snTable that stores the source ID
   *                                     (e.g. 'u_jira_key', 'u_sf_id', 'correlation_display')
   * @param {string}   sourceIdField   Field in sourceRecords that holds the ID (e.g. 'key','Id')
   * @param {object}   opts
   * @param {number}   opts.limit      Max source records to compare (default 200)
   * @param {boolean}  opts.fullScan   If true, also query SN for records not in source
   */
  async reconcile(sourceRecords, snTable, fieldMappings, correlationField, sourceIdField, opts = {}) {
    const limit = opts.limit ?? 200;
    const sample = sourceRecords.slice(0, limit);

    logger.header(`Reconciling ${sample.length} records — source vs ${snTable}`);

    // ── Step 1: load target records from SN ───────────────────────────────
    logger.step('Loading target records from ServiceNow…');
    const sourceIds  = sample.map(r => r[sourceIdField]).filter(Boolean);
    const snRecords  = await this._loadSnRecords(snTable, correlationField, sourceIds, fieldMappings);
    const snByCorrel = new Map(snRecords.map(r => [norm(r[correlationField]), r]));

    logger.info(`  ${snRecords.length} SN records loaded`);

    // ── Step 2: count check ───────────────────────────────────────────────
    const countResult = this._countCheck(sample.length, snRecords.length);

    // ── Step 3: record matching ───────────────────────────────────────────
    logger.step('Matching source ↔ target records…');
    const matched    = [];
    const missing    = [];   // in source, not in SN
    for (const src of sample) {
      const srcId  = String(src[sourceIdField] ?? '').trim();
      const snRec  = snByCorrel.get(srcId);
      if (snRec) matched.push({ source: src, target: snRec, sourceId: srcId });
      else        missing.push({ sourceId: srcId, source: src });
    }

    // Records in SN but not in the source sample
    const extra = [];
    if (opts.fullScan) {
      const matchedIds = new Set(matched.map(m => m.sourceId));
      for (const [corrId, snRec] of snByCorrel) {
        if (!matchedIds.has(corrId)) extra.push({ correlId: corrId, target: snRec });
      }
    }

    logger.info(`  Matched: ${matched.length} | Missing from SN: ${missing.length} | Extra in SN: ${extra.length}`);

    // ── Step 4: field-level value comparison ──────────────────────────────
    logger.step('Comparing field values…');
    const fieldStats = this._initFieldStats(fieldMappings);
    const mismatchedRecords = [];

    for (const { source, target, sourceId } of matched) {
      const diffs = this._compareFields(source, target, fieldMappings);
      for (const diff of diffs) {
        fieldStats[diff.snField].total++;
        if (diff.match) {
          fieldStats[diff.snField].passed++;
        } else {
          fieldStats[diff.snField].failed++;
          fieldStats[diff.snField].sample_mismatches.push({
            sourceId,
            expected: diff.expected,
            actual:   diff.actual,
          });
        }
      }
      const failures = diffs.filter(d => !d.match);
      if (failures.length) {
        mismatchedRecords.push({
          source_id:      sourceId,
          total_fields:   diffs.length,
          failed_fields:  failures.length,
          passed_fields:  diffs.length - failures.length,
          field_accuracy: Math.round(((diffs.length - failures.length) / diffs.length) * 100),
          diffs:          failures.slice(0, this.sampleDiffs),
        });
      }
    }

    // ── Step 5: build final verdict ───────────────────────────────────────
    const verdict = this._verdict(missing, mismatchedRecords, fieldStats, countResult);
    const report  = {
      verdict,
      summary: {
        source_records:       sample.length,
        sn_records_found:     snRecords.length,
        matched:              matched.length,
        missing_from_sn:      missing.length,
        extra_in_sn:          extra.length,
        records_with_errors:  mismatchedRecords.length,
        records_fully_correct: matched.length - mismatchedRecords.length,
        record_accuracy_pct:  matched.length
          ? Math.round(((matched.length - mismatchedRecords.length) / matched.length) * 100)
          : 0,
      },
      count_check:    countResult,
      field_stats:    this._summariseFieldStats(fieldStats),
      mismatched_records: mismatchedRecords.slice(0, 50),
      missing_records:    missing.slice(0, 20),
      extra_records:      extra.slice(0, 20),
    };

    this._printSummary(report);
    return report;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Load SN records in batches
  // ══════════════════════════════════════════════════════════════════════════
  async _loadSnRecords(snTable, correlationField, sourceIds, fieldMappings) {
    const snFields = [...new Set(Object.values(fieldMappings))];
    const fields   = ['sys_id', correlationField, ...snFields].join(',');
    const results  = [];

    // Batch into groups of 50 (SN IN query limit)
    for (let i = 0; i < sourceIds.length; i += 50) {
      const batch = sourceIds.slice(i, i + 50);
      const query = `${correlationField}IN${batch.join(',')}`;
      const rows  = await this.sn.get(snTable, {
        sysparm_query:         query,
        sysparm_fields:        fields,
        sysparm_limit:         '50',
        sysparm_display_value: 'true',
      }).catch(e => { logger.warn(`  Batch query failed: ${e.message}`); return []; });
      results.push(...rows);
    }
    return results;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Compare all mapped fields for one source↔target pair
  // ══════════════════════════════════════════════════════════════════════════
  _compareFields(source, target, fieldMappings) {
    const diffs = [];
    for (const [srcField, snField] of Object.entries(fieldMappings)) {
      if (this.ignoredFields.has(snField)) continue;

      const rawSource = source[srcField];
      const rawTarget = target[snField];

      // Apply expected transformation to source value
      const expected = this._applyTransform(snField, rawSource);
      const actual   = this._normalise(snField, rawTarget);

      const match = this._valuesMatch(snField, expected, actual);
      diffs.push({
        sourceField,
        snField,
        expected,
        actual,
        match,
        raw_source: rawSource,
        raw_target: rawTarget,
      });
    }
    return diffs;
  }

  _applyTransform(snField, sourceValue) {
    if (sourceValue === null || sourceValue === undefined) return '';
    const fieldMap = this.transformMap.get(snField);
    const src = String(sourceValue).trim();
    if (fieldMap && fieldMap.has(src)) return String(fieldMap.get(src));
    return this._normalise(snField, sourceValue);
  }

  _normalise(field, value) {
    if (this.dateFields.has(field)) return normDate(value);
    return norm(value);
  }

  _valuesMatch(field, expected, actual) {
    if (expected === actual) return true;
    // Case-insensitive match
    if (expected.toLowerCase() === actual.toLowerCase()) return true;
    // Date: compare YYYY-MM-DD prefix
    if (this.dateFields.has(field)) return normDate(expected) === normDate(actual);
    // Numeric: compare as numbers
    const n1 = Number(expected), n2 = Number(actual);
    if (!isNaN(n1) && !isNaN(n2) && n1 === n2) return true;
    // Both empty
    if (!expected && !actual) return true;
    return false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Count check
  // ══════════════════════════════════════════════════════════════════════════
  _countCheck(srcCount, snCount) {
    const diff = snCount - srcCount;
    return {
      source_count: srcCount,
      sn_count:     snCount,
      difference:   diff,
      passed:       diff === 0,
      message: diff === 0
        ? 'Record counts match'
        : diff > 0
          ? `${diff} more records in SN than source (possible duplicates or pre-existing records)`
          : `${Math.abs(diff)} records missing from SN`,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Field stats helpers
  // ══════════════════════════════════════════════════════════════════════════
  _initFieldStats(fieldMappings) {
    const stats = {};
    for (const [srcField, snField] of Object.entries(fieldMappings)) {
      if (this.ignoredFields.has(snField)) continue;
      stats[snField] = {
        source_field:      srcField,
        sn_field:          snField,
        total:             0,
        passed:            0,
        failed:            0,
        sample_mismatches: [],
      };
    }
    return stats;
  }

  _summariseFieldStats(stats) {
    return Object.values(stats).map(s => ({
      source_field:  s.source_field,
      sn_field:      s.sn_field,
      total:         s.total,
      passed:        s.passed,
      failed:        s.failed,
      accuracy_pct:  s.total ? Math.round((s.passed / s.total) * 100) : null,
      verdict:       s.total === 0 ? 'no_data'
                   : s.failed === 0 ? 'PASS'
                   : s.passed === 0 ? 'FAIL'
                   : 'PARTIAL',
      sample_mismatches: s.sample_mismatches.slice(0, 5),
    })).sort((a, b) => (a.accuracy_pct ?? 100) - (b.accuracy_pct ?? 100));  // worst first
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Overall verdict
  // ══════════════════════════════════════════════════════════════════════════
  _verdict(missing, mismatched, fieldStats, countCheck) {
    const hasBlocking = missing.length > 0 || !countCheck.passed;
    const failedFields = Object.values(fieldStats).filter(f => f.failed > 0).length;
    const totalFields  = Object.values(fieldStats).length;

    if (missing.length > 0 && missing.length === Object.keys(fieldStats).length) {
      return { result: 'FAIL', reason: 'No source records were found in ServiceNow — migration may not have run or correlation field is misconfigured' };
    }
    if (missing.length > 0) {
      return { result: 'PARTIAL', reason: `${missing.length} source records are missing from ServiceNow` };
    }
    if (failedFields === 0 && !hasBlocking) {
      return { result: 'PASS', reason: 'All records matched and all field values are correct' };
    }
    if (failedFields > 0 && failedFields < totalFields) {
      const pct = Math.round(((totalFields - failedFields) / totalFields) * 100);
      return { result: 'PARTIAL', reason: `${failedFields}/${totalFields} fields have value mismatches (${pct}% field accuracy)` };
    }
    if (mismatched.length > 0) {
      return { result: 'PARTIAL', reason: `${mismatched.length} records have field-level mismatches` };
    }
    return { result: 'PASS', reason: 'Migration verified successfully' };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Console summary
  // ══════════════════════════════════════════════════════════════════════════
  _printSummary(report) {
    const v = report.verdict.result;
    const icon = v === 'PASS' ? '✓' : v === 'PARTIAL' ? '~' : '✗';
    logger.divider();
    logger.info(`Reconciliation verdict: ${icon} ${v}`);
    logger.info(`  ${report.verdict.reason}`);
    logger.info(`  Records: ${report.summary.matched} matched | ${report.summary.missing_from_sn} missing | ${report.summary.records_with_errors} with field errors`);
    logger.info(`  Record accuracy: ${report.summary.record_accuracy_pct}%`);

    const failedFields = report.field_stats.filter(f => f.verdict === 'FAIL' || f.verdict === 'PARTIAL');
    if (failedFields.length) {
      logger.warn(`  Fields with mismatches:`);
      for (const f of failedFields.slice(0, 10)) {
        logger.warn(`    ${f.sn_field.padEnd(30)} ${f.accuracy_pct}% (${f.failed}/${f.total} wrong)`);
      }
    }
    logger.divider();
  }
}
