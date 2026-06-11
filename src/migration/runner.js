import { logger } from '../utils/logger.js';
import { config }  from '../config.js';

export class MigrationRunner {
  constructor(sn, opts = {}) {
    this.sn          = sn;
    this.stopOnError = opts.stopOnError ?? config.migration.stopOnError ?? false;
    this.stats       = { inserted: 0, updated: 0, ignored: 0, errors: 0, total: 0 };
    this.errorLog    = [];
    this.startTime   = null;
  }

  async pushRecord(stagingTable, record) {
    const result = await this.sn.pushToImportSet(stagingTable, record);
    return Array.isArray(result) ? result[0] : result;
  }

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

  async _handleError({ stagingTable, sourceId, record, error, phase }) {
    this.stats.errors++;
    this.errorLog.push({ source_id: sourceId, error, phase });
    if (this.sn.logError) await this.sn.logError(stagingTable, { source_id: sourceId, payload: record, error, phase });
  }

  async runSequencedMigration(stagingTable, sequence, flattenFn) {
    this.startTime = Date.now();
    logger.header('Phase 6 — Sequenced Full Migration');
    if (this.sn.ensureErrorLogTable) await this.sn.ensureErrorLogTable(stagingTable);

    for (const tier of sequence) {
      logger.step(`Tier ${tier.tier}: ${tier.types.join(', ')} (${tier.count} records)`);
      let tierInserted = 0, tierUpdated = 0, tierErrors = 0;

      for (const issue of tier.issues) {
        const record   = flattenFn(issue);
        const sourceId = issue.key ?? issue.id ?? issue.Id;
        try {
          const res   = await this.pushRecord(stagingTable, record);
          const state = res?.status ?? 'unknown';
          this.stats.total++;
          if      (state === 'inserted') { this.stats.inserted++; tierInserted++; }
          else if (state === 'updated')  { this.stats.updated++;  tierUpdated++;  }
          else if (state === 'ignored')  { this.stats.ignored++; }
          else if (state === 'error') {
            await this._handleError({ stagingTable, sourceId, record, error: res?.error_message ?? 'unknown', phase: 'transform' });
            tierErrors++;
            if (this.stopOnError) {
              logger.error(`Stopped at Tier ${tier.tier} (stopOnError=true)`);
              return { stopped: true, stoppedAtTier: tier.tier, stats: this.stats, errorLog: this.errorLog };
            }
          }
        } catch (e) {
          await this._handleError({ stagingTable, sourceId, record, error: e.message, phase: 'push' });
          tierErrors++;
          if (this.stopOnError) return { stopped: true, stoppedAtTier: tier.tier, stats: this.stats, errorLog: this.errorLog };
        }
      }
      logger.info(`  Tier ${tier.tier} complete — ✓ ${tierInserted} inserted | ↺ ${tierUpdated} updated | ✗ ${tierErrors} errors`);
    }
    return this._completionReport();
  }

  async runFullMigration(stagingTable, recordIterator, flattenFn) {
    this.startTime = Date.now();
    logger.header('Phase 6 — Full Migration');
    if (this.sn.ensureErrorLogTable) await this.sn.ensureErrorLogTable(stagingTable);
    let page = 0;

    try {
      for await (const batch of recordIterator) {
        page++;
        let pageInserted = 0, pageUpdated = 0, pageIgnored = 0, pageErrors = 0;
        for (const rec of batch) {
          const record   = flattenFn(rec);
          const sourceId = rec.key ?? rec.id ?? rec.Id;
          try {
            const res   = await this.pushRecord(stagingTable, record);
            const state = res?.status ?? 'unknown';
            this.stats.total++;
            if      (state === 'inserted') { this.stats.inserted++; pageInserted++; }
            else if (state === 'updated')  { this.stats.updated++;  pageUpdated++;  }
            else if (state === 'ignored')  { this.stats.ignored++;  pageIgnored++;  }
            else if (state === 'error') {
              await this._handleError({ stagingTable, sourceId, record, error: res?.error_message ?? 'unknown', phase: 'transform' });
              pageErrors++;
              if (this.stopOnError) return { stopped: true, page, stats: this.stats, errorLog: this.errorLog };
            }
          } catch (e) {
            await this._handleError({ stagingTable, sourceId, record, error: e.message, phase: 'push' });
            pageErrors++;
            if (this.stopOnError) return { stopped: true, page, stats: this.stats, errorLog: this.errorLog };
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
    if (this.stats.errors)  logger.error(`Errors:    ${this.stats.errors} (see *_errors table for details)`);
    logger.info(`Duration:  ${duration}s`);
    return { stopped: false, stats: this.stats, errorLog: this.errorLog };
  }
}
