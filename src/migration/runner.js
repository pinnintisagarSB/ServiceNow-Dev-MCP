import { logger } from '../utils/logger.js';
import { config }  from '../config.js';

// ── Topological sort for relationship-aware migration order ────────────────
// nodes: string[]  edges: [parentId, childId][]
// Returns nodes in dependency order (parents before children).
export function topoSort(nodes, edges) {
  const adj  = new Map(nodes.map(n => [n, []]));
  const inDeg = new Map(nodes.map(n => [n, 0]));
  for (const [parent, child] of edges) {
    if (adj.has(parent) && inDeg.has(child)) {
      adj.get(parent).push(child);
      inDeg.set(child, inDeg.get(child) + 1);
    }
  }
  const queue = [...inDeg.entries()].filter(([,d]) => d === 0).map(([n]) => n);
  const result = [];
  while (queue.length) {
    const n = queue.shift();
    result.push(n);
    for (const child of (adj.get(n) ?? [])) {
      const d = inDeg.get(child) - 1;
      inDeg.set(child, d);
      if (d === 0) queue.push(child);
    }
  }
  // Append any nodes not reachable (cycles or disconnected)
  for (const n of nodes) { if (!result.includes(n)) result.push(n); }
  return result;
}

// ── ETA tracker ────────────────────────────────────────────────────────────
class EtaTracker {
  constructor(total) {
    this.total    = total;
    this.done     = 0;
    this.startMs  = Date.now();
    this._times   = [];   // rolling window of (done, ms) samples
  }

  tick(n = 1) {
    this.done += n;
    this._times.push({ done: this.done, ms: Date.now() });
    if (this._times.length > 20) this._times.shift();
  }

  eta() {
    if (this.done === 0) return null;
    const rate = this._rollingRate();
    if (!rate) return null;
    const remaining = this.total - this.done;
    const etaMs     = remaining / rate;
    return {
      remaining,
      etaMs,
      etaHuman:  this._fmt(etaMs),
      ratePerSec: Math.round(rate * 1000),
      pct: Math.round((this.done / this.total) * 100),
    };
  }

  _rollingRate() {
    if (this._times.length < 2) {
      return this.done / (Date.now() - this.startMs);
    }
    const first = this._times[0], last = this._times[this._times.length - 1];
    const elapsed = last.ms - first.ms;
    const records  = last.done - first.done;
    return elapsed > 0 ? records / elapsed : null;
  }

  _fmt(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60)  return `${s}s`;
    if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
  }
}

// ── Batch size auto-tuner ──────────────────────────────────────────────────
class BatchAutoTuner {
  constructor(opts = {}) {
    this.current  = opts.initial   ?? 50;
    this.min      = opts.min       ?? 10;
    this.max      = opts.max       ?? 200;
    this.targetMs = opts.targetMs  ?? 8000;  // aim for each batch to finish in ~8s
    this._samples = [];
  }

  record(batchSize, durationMs) {
    const msPerRecord = durationMs / batchSize;
    this._samples.push(msPerRecord);
    if (this._samples.length > 5) this._samples.shift();

    const avg      = this._samples.reduce((a, b) => a + b, 0) / this._samples.length;
    const ideal    = Math.round(this.targetMs / avg);
    this.current   = Math.min(this.max, Math.max(this.min, ideal));
    return this.current;
  }

  get size() { return this.current; }
}

export class MigrationRunner {
  constructor(sn, opts = {}) {
    this.sn          = sn;
    this.stopOnError = opts.stopOnError ?? config.migration.stopOnError ?? false;
    this.stats       = { inserted: 0, updated: 0, ignored: 0, errors: 0, total: 0 };
    this.errorLog    = [];
    this.startTime   = null;
    this._tuner      = new BatchAutoTuner(opts.batchTuner ?? {});
    this._eta        = null;
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

    const totalRecords = sequence.reduce((s, t) => s + (t.issues?.length ?? 0), 0);
    this._eta = new EtaTracker(totalRecords);

    for (const tier of sequence) {
      logger.step(`Tier ${tier.tier}: ${tier.types.join(', ')} (${tier.count} records)`);
      let tierInserted = 0, tierUpdated = 0, tierErrors = 0;

      const issues   = tier.issues ?? [];
      const batchSz  = this._tuner.size;

      for (let i = 0; i < issues.length; i += batchSz) {
        const batchStart = Date.now();
        const chunk  = issues.slice(i, i + batchSz);

        for (const issue of chunk) {
          const record   = flattenFn(issue);
          const sourceId = issue.key ?? issue.id ?? issue.Id;
          try {
            const res   = await this.pushRecord(stagingTable, record);
            const state = res?.status ?? 'unknown';
            this.stats.total++;
            this._eta.tick();
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

        const batchDuration = Date.now() - batchStart;
        this._tuner.record(chunk.length, batchDuration);

        const eta = this._eta.eta();
        if (eta) {
          logger.info(`  Progress: ${eta.pct}% | ${eta.ratePerSec} rec/s | ETA ${eta.etaHuman}`);
        }
      }

      logger.info(`  Tier ${tier.tier} complete — ✓ ${tierInserted} inserted | ↺ ${tierUpdated} updated | ✗ ${tierErrors} errors`);
    }
    return this._completionReport();
  }

  async runFullMigration(stagingTable, recordIterator, flattenFn, totalHint = 0) {
    this.startTime = Date.now();
    logger.header('Phase 6 — Full Migration');
    if (this.sn.ensureErrorLogTable) await this.sn.ensureErrorLogTable(stagingTable);
    this._eta = totalHint > 0 ? new EtaTracker(totalHint) : null;
    let page = 0;

    try {
      for await (const batch of recordIterator) {
        page++;
        const batchStart = Date.now();
        let pageInserted = 0, pageUpdated = 0, pageIgnored = 0, pageErrors = 0;
        for (const rec of batch) {
          const record   = flattenFn(rec);
          const sourceId = rec.key ?? rec.id ?? rec.Id;
          try {
            const res   = await this.pushRecord(stagingTable, record);
            const state = res?.status ?? 'unknown';
            this.stats.total++;
            this._eta?.tick();
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
        this._tuner.record(batch.length, Date.now() - batchStart);
        const eta = this._eta?.eta();
        const etaStr = eta ? ` | ETA ${eta.etaHuman} (${eta.ratePerSec} rec/s)` : '';
        logger.info(`Page ${page} — ✓ ${pageInserted} | ↺ ${pageUpdated} | — ${pageIgnored} | ✗ ${pageErrors}${etaStr}`);
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
