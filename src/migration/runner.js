import { logger } from '../utils/logger.js';
import { config }  from '../config.js';

export class MigrationRunner {
  constructor(sn) {
    this.sn        = sn;
    this.stats     = { inserted: 0, updated: 0, ignored: 0, errors: 0, total: 0 };
    this.errorLog  = [];
    this.startTime = null;
  }

  // ── Push a single record via Import Set API ────────────────────────────────
  async pushRecord(stagingTable, record) {
    const result = await this.sn.pushToImportSet(stagingTable, record);
    // pushToImportSet returns json.result which is the array of transform results
    return Array.isArray(result) ? result[0] : result;
  }

  // ── Test migration: push a small sample to verify transform ───────────────
  async runTestMigration(stagingTable, records) {
    logger.step(`Test migration: pushing ${records.length} records...`);
    const results = [];

    for (const rec of records) {
      try {
        const res   = await this.pushRecord(stagingTable, rec);
        const state = res?.status ?? 'unknown';
        results.push({ state, record: rec, error: res?.error_message });
        if (state === 'error') logger.warn(`  ✗ ${res?.error_message}`);
        else                   logger.info(`  ${rec[Object.keys(rec)[0]]?.toString().substring(0, 60)} → ${state}`);
      } catch (e) {
        results.push({ state: 'error', record: rec, error: e.message });
        logger.warn(`  ✗ Exception: ${e.message}`);
      }
    }

    const counts = results.reduce((acc, r) => { acc[r.state] = (acc[r.state] ?? 0) + 1; return acc; }, {});
    logger.divider();
    logger.info(`Test results: ${JSON.stringify(counts)}`);
    return { results, counts };
  }

  // ── Sequenced migration: migrate by dependency tier ────────────────────────
  // sequence is the migrationSequence from DependencyAnalyzer:
  //   [{ tier, types, issues, count }, ...]
  async runSequencedMigration(stagingTable, sequence, flattenFn) {
    this.startTime = Date.now();
    logger.header('Phase 6 — Sequenced Full Migration');

    for (const tier of sequence) {
      logger.step(`Tier ${tier.tier}: ${tier.types.join(', ')} (${tier.count} records)`);
      let tierInserted = 0, tierUpdated = 0, tierErrors = 0;

      for (const issue of tier.issues) {
        const record = flattenFn(issue);
        try {
          const res   = await this.pushRecord(stagingTable, record);
          const state = res?.status ?? 'unknown';
          this.stats.total++;

          if      (state === 'inserted') { this.stats.inserted++; tierInserted++; }
          else if (state === 'updated')  { this.stats.updated++;  tierUpdated++;  }
          else if (state === 'ignored')  { this.stats.ignored++; }
          else if (state === 'error') {
            this.stats.errors++; tierErrors++;
            this.errorLog.push({ issue: issue.key, error: res?.error_message ?? 'unknown', tier: tier.tier });
            logger.error(`  ✗ [${issue.key}] ${res?.error_message}`);
            // Stop on error so user can decide how to proceed
            logger.error(`Migration stopped at Tier ${tier.tier}.`);
            return { stopped: true, stoppedAtTier: tier.tier, stats: this.stats, errorLog: this.errorLog };
          }
        } catch (e) {
          this.stats.errors++;
          this.errorLog.push({ issue: issue.key, error: e.message, tier: tier.tier });
          logger.error(`  ✗ [${issue.key}] ${e.message}`);
          return { stopped: true, stoppedAtTier: tier.tier, stats: this.stats, errorLog: this.errorLog };
        }
      }

      logger.info(`  Tier ${tier.tier} complete — ✓ ${tierInserted} inserted | ↺ ${tierUpdated} updated | ✗ ${tierErrors} errors`);
    }

    return this._completionReport();
  }

  // ── Full migration: paginated iterator (no dependency ordering) ────────────
  async runFullMigration(stagingTable, recordIterator, flattenFn) {
    this.startTime = Date.now();
    logger.header('Phase 6 — Full Migration');
    let page = 0;

    try {
      for await (const batch of recordIterator) {
        page++;
        let pageInserted = 0, pageUpdated = 0, pageIgnored = 0, pageErrors = 0;

        for (const rec of batch.map(flattenFn)) {
          try {
            const res   = await this.pushRecord(stagingTable, rec);
            const state = res?.status ?? 'unknown';
            this.stats.total++;

            if      (state === 'inserted') { this.stats.inserted++; pageInserted++; }
            else if (state === 'updated')  { this.stats.updated++;  pageUpdated++;  }
            else if (state === 'ignored')  { this.stats.ignored++;  pageIgnored++;  }
            else if (state === 'error') {
              this.stats.errors++; pageErrors++;
              this.errorLog.push({ record: rec, error: res?.error_message ?? 'unknown', page });
              logger.error(`\nMigration stopped at page ${page}: ${res?.error_message}`);
              return { stopped: true, page, stats: this.stats, errorLog: this.errorLog };
            }
          } catch (e) {
            this.stats.errors++;
            this.errorLog.push({ record: rec, error: e.message, page });
            logger.error(`Exception on page ${page}: ${e.message}`);
            return { stopped: true, page, stats: this.stats, errorLog: this.errorLog };
          }
        }

        logger.info(`Page ${page} — ✓ ${pageInserted} inserted | ↺ ${pageUpdated} updated | — ${pageIgnored} ignored | ✗ ${pageErrors} errors`);
      }
    } catch (e) {
      logger.error(`Fatal error: ${e.message}`);
      return { stopped: true, page, stats: this.stats, errorLog: this.errorLog };
    }

    return this._completionReport();
  }

  _completionReport() {
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(1);
    logger.header('Migration Complete');
    logger.success(`Inserted:  ${this.stats.inserted}`);
    logger.info(`Updated:   ${this.stats.updated}`);
    if (this.stats.ignored) logger.warn(`Ignored:   ${this.stats.ignored}`);
    if (this.stats.errors)  logger.error(`Errors:    ${this.stats.errors}`);
    logger.info(`Duration:  ${duration}s`);
    return { stopped: false, stats: this.stats };
  }
}
