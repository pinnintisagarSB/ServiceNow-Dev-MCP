import { logger } from '../utils/logger.js';
import { config }  from '../config.js';

/**
 * Phase 5 + 6: Pushes records to SN Import Set API and monitors transform results.
 */
export class MigrationRunner {
  constructor(sn) {
    this.sn          = sn;
    this.stats       = { inserted: 0, updated: 0, ignored: 0, errors: 0, total: 0 };
    this.errorLog    = [];
    this.startTime   = null;
  }

  // ── Push a single record ───────────────────────────────────────────────────
  async pushRecord(stagingTable, record) {
    const result = await this.sn.pushToImportSet(stagingTable, record);
    const state  = Array.isArray(result) ? result[0]?.transform_result : result?.transform_result;
    return state ?? result;
  }

  // ── Run test migration (10 records) ───────────────────────────────────────
  async runTestMigration(stagingTable, records) {
    logger.step(`Test migration: pushing ${records.length} records...`);
    const results = [];

    for (const rec of records) {
      try {
        const res = await this.pushRecord(stagingTable, rec);
        const state = res?.status ?? 'unknown';
        results.push({ state, record: rec, error: res?.error_message });
        if (state === 'error') logger.warn(`  ✗ Error: ${res?.error_message}`);
        else logger.info(`  ${rec[Object.keys(rec)[0]]} → ${state}`);
      } catch (e) {
        results.push({ state: 'error', record: rec, error: e.message });
        logger.warn(`  ✗ Exception: ${e.message}`);
      }
    }

    const counts = results.reduce((acc, r) => {
      acc[r.state] = (acc[r.state] ?? 0) + 1;
      return acc;
    }, {});

    logger.divider();
    logger.info(`Test results: ${JSON.stringify(counts)}`);
    return { results, counts };
  }

  // ── Full migration ─────────────────────────────────────────────────────────
  async runFullMigration(stagingTable, recordIterator, flattenFn) {
    this.startTime = Date.now();
    logger.header('Phase 6 — Full Migration');
    let page = 0;

    try {
      for await (const batch of recordIterator) {
        page++;
        const flatBatch = batch.map(flattenFn);
        let pageInserted = 0, pageUpdated = 0, pageIgnored = 0, pageErrors = 0;

        for (const rec of flatBatch) {
          try {
            const res   = await this.pushRecord(stagingTable, rec);
            const state = res?.status ?? 'unknown';
            this.stats.total++;

            if (state === 'inserted')      { this.stats.inserted++; pageInserted++; }
            else if (state === 'updated')  { this.stats.updated++;  pageUpdated++;  }
            else if (state === 'ignored')  { this.stats.ignored++;  pageIgnored++;  }
            else if (state === 'error')    {
              this.stats.errors++;
              pageErrors++;
              const errEntry = { record: rec, error: res?.error_message ?? 'unknown', page };
              this.errorLog.push(errEntry);

              // Stop on error per skill rules
              logger.error(`\nMigration stopped at page ${page}.`);
              logger.error(`Error: ${res?.error_message}`);
              logger.error(`Total processed: ${this.stats.total}`);
              logger.warn(`\nOptions:\n  Resume → call runner.resume()\n  Skip   → call runner.skip()\n  Rollback → manual (records not auto-rolled back)`);
              return { stopped: true, page, stats: this.stats, errorLog: this.errorLog };
            }
          } catch (e) {
            this.stats.errors++;
            this.errorLog.push({ record: rec, error: e.message, page });
            logger.error(`Exception on record in page ${page}: ${e.message}`);
            return { stopped: true, page, stats: this.stats, errorLog: this.errorLog };
          }
        }

        logger.info(`Page ${page} — ✓ ${pageInserted} inserted | ↺ ${pageUpdated} updated | — ${pageIgnored} ignored | ✗ ${pageErrors} errors`);
      }
    } catch (e) {
      logger.error(`Fatal error during migration: ${e.message}`);
      return { stopped: true, page, stats: this.stats, errorLog: this.errorLog };
    }

    return this.printCompletionReport();
  }

  printCompletionReport() {
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(1);
    logger.header('Migration Complete');
    logger.success(`Inserted:  ${this.stats.inserted}`);
    logger.info(`Updated:   ${this.stats.updated}`);
    logger.warn(`Ignored:   ${this.stats.ignored}`);
    if (this.stats.errors) logger.error(`Errors:    ${this.stats.errors}`);
    logger.info(`Duration:  ${duration}s`);
    return { stopped: false, stats: this.stats };
  }
}
