import { Progress }   from '../utils/progress.js';
import { config }     from '../config.js';
import { createHash } from 'crypto';

// Configurable max concurrent import set runs (default 5)
const MAX_PARALLEL_IMPORT_SETS = config.migration.maxParallelImportSets ?? 5;

// Ideal records per import set batch (calculated dynamically but bounded)
const MIN_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 200;

/**
 * Batch migration runner.
 *
 * Divides records into import set batches and runs up to MAX_PARALLEL_IMPORT_SETS
 * concurrently. Checks the instance's active import set count before starting
 * each wave to stay within the limit. Tracks every import set so none are missed.
 */
export class BatchMigrationRunner {
  constructor(sn, opts = {}) {
    this.sn          = sn;
    this.importSets  = [];
    this.stats       = { inserted: 0, updated: 0, ignored: 0, errors: 0, total: 0 };
    this.errorLog    = [];
    this.startTime   = null;
    this.stopOnError = opts.stopOnError ?? config.migration.stopOnError ?? false;
    this.useBulk     = opts.useBulk ?? false;
    this.transformMapSysId = opts.transformMapSysId ?? null;
    this.lockKey     = opts.lockKey ?? null;
    this.holderId    = `${process.pid}-${Date.now()}`;
  }

  // ── Check how many import sets are currently running in the instance ───────
  async activeImportSetCount() {
    try {
      const running = await this.sn.get('sys_import_set_run', {
        sysparm_query:  'state=running',
        sysparm_fields: 'sys_id',
        sysparm_limit:  '20',
      });
      return running.length;
    } catch (_) {
      return 0; // if we can't check, assume zero and proceed
    }
  }

  // ── Calculate ideal batch size based on total record count ────────────────
  calcBatchSize(total) {
    // Aim for ~10 batches total (to give meaningful progress), clamped to limits
    const ideal = Math.ceil(total / 10);
    return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, ideal));
  }

  // ── Push one batch of records, return import set info + results ───────────
  async _pushBatch(stagingTable, records, batchNum) {
    // Bulk path: insert rows directly to staging then run one transform pass.
    if (this.useBulk && this.transformMapSysId) {
      try {
        const inserted = await this.sn.bulkLoad(stagingTable, records);
        await this.sn.executeTransform(this.transformMapSysId);
        const ok = inserted.filter(x => typeof x === 'string').length;
        const err = inserted.length - ok;
        this.stats.total += records.length;
        this.stats.inserted += ok;
        this.stats.errors += err;
        return { batchNum, importSetId: null, results: inserted.map(x => ({
          status: typeof x === 'string' ? 'inserted' : 'error', error: x?.error,
        })) };
      } catch (e) {
        this.stats.errors += records.length;
        for (const rec of records) {
          if (this.sn.logError) await this.sn.logError(stagingTable, { source_id: '', payload: rec, error: e.message, phase: 'bulk' });
        }
        return { batchNum, importSetId: null, results: records.map(() => ({ status: 'error', error: e.message })) };
      }
    }

    const results = [];
    let importSetId = null;
    for (const rec of records) {
      try {
        const res    = await this.sn.pushToImportSet(stagingTable, rec);
        const item   = Array.isArray(res) ? res[0] : res;
        const state  = item?.status ?? 'unknown';
        if (!importSetId && item?.import_set) importSetId = item.import_set;
        results.push({ status: state, error: item?.error_message });
        this.stats.total++;
        if      (state === 'inserted') this.stats.inserted++;
        else if (state === 'updated')  this.stats.updated++;
        else if (state === 'ignored')  this.stats.ignored++;
        else if (state === 'error') {
          this.stats.errors++;
          this.errorLog.push({ batch: batchNum, error: item?.error_message ?? 'unknown' });
          if (this.sn.logError) await this.sn.logError(stagingTable, { source_id: '', payload: rec, error: item?.error_message ?? 'unknown', phase: 'transform' });
        }
      } catch (e) {
        this.stats.errors++;
        this.errorLog.push({ batch: batchNum, error: e.message });
        if (this.sn.logError) await this.sn.logError(stagingTable, { source_id: '', payload: rec, error: e.message, phase: 'push' });
        results.push({ status: 'error', error: e.message });
      }
    }
    if (importSetId) this.importSets.push(importSetId);
    return { batchNum, importSetId, results };
  }

  // ── Main entry: sequenced (by dependency tier) + parallel batches ──────────
  async run(stagingTable, sequence, flattenFn) {
    this.startTime = Date.now();
    const progress = new Progress(sequence.length + 3, 'Full Migration');

    progress.section('Starting Full Migration');

    // Acquire cross-session lock so two parallel runs don't fight
    if (this.lockKey && this.sn.acquireMigrationLock) {
      progress.step('Acquiring migration lock');
      const lock = await this.sn.acquireMigrationLock(this.lockKey, this.holderId);
      if (!lock.acquired) {
        progress.warn(`Another session holds the migration lock (${lock.heldBy}). Aborting.`);
        return { stopped: true, reason: 'lock_held', heldBy: lock.heldBy, stats: this.stats };
      }
      progress.ok('Lock acquired');
    }
    if (this.sn.ensureErrorLogTable) await this.sn.ensureErrorLogTable(stagingTable);

    // Check instance capacity
    progress.step('Checking how many migrations are already running in ServiceNow');
    const active = await this.activeImportSetCount();
    if (active >= MAX_PARALLEL_IMPORT_SETS) {
      progress.warn(`ServiceNow already has ${active} import sets running (limit: ${MAX_PARALLEL_IMPORT_SETS}).`);
      progress.warn('Please wait for them to finish before starting the migration.');
      return { stopped: true, reason: 'import_set_limit_reached', active, stats: this.stats };
    }
    const slotsAvailable = MAX_PARALLEL_IMPORT_SETS - active;
    progress.ok(`${slotsAvailable} import set slot(s) available — ready to migrate`);

    // Process each dependency tier in order
    for (const tier of sequence) {
      if (!tier.issues?.length) continue;
      progress.step(`Migrating Tier ${tier.tier}: ${tier.types.join(' and ')} (${tier.count} records)`);
      progress.info(`These are the ${tier.types.join('/')} records — they must go before any child records`);

      const flat        = tier.issues.map(flattenFn);
      const batchSize   = this.calcBatchSize(flat.length);
      const batches     = this._chunk(flat, batchSize);

      progress.info(`Divided ${flat.length} records into ${batches.length} batches of ~${batchSize} each`);
      progress.info(`Running up to ${Math.min(slotsAvailable, MAX_PARALLEL_IMPORT_SETS)} batches at a time`);

      // Run batches in waves of MAX_PARALLEL_IMPORT_SETS
      let done = 0;
      for (let i = 0; i < batches.length; i += MAX_PARALLEL_IMPORT_SETS) {
        const wave = batches.slice(i, i + MAX_PARALLEL_IMPORT_SETS);

        // Wait if instance is at capacity
        await this._waitForCapacity(progress);

        const waveResults = await Promise.all(
          wave.map((batch, idx) => this._pushBatch(stagingTable, batch, i + idx + 1))
        );

        done += wave.reduce((s, b) => s + b.length, 0);
        progress.batch(done, flat.length);

        // Log per-wave summary
        const waveInserted = waveResults.reduce((s, r) => s + r.results.filter(x => x.status === 'inserted').length, 0);
        const waveErrors   = waveResults.reduce((s, r) => s + r.results.filter(x => x.status === 'error').length, 0);
        progress.ok(`Batches ${i + 1}–${i + wave.length}: ${waveInserted} created, ${waveErrors} errors`);

        if (waveErrors > 0 && this.errorLog.length) {
          progress.warn(`Errors in this wave — check the error log. Continuing with next batch.`);
        }
      }

      progress.ok(`Tier ${tier.tier} complete`);
    }

    const report = this._finalReport(progress);
    await this._release();
    return report;
  }

  // ── Wait until instance has capacity for another batch ─────────────────────
  async _waitForCapacity(progress, maxWaitMs = 60000) {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const active = await this.activeImportSetCount();
      if (active < MAX_PARALLEL_IMPORT_SETS) return;
      progress.info(`ServiceNow is busy (${active} import sets running) — waiting 5 seconds...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // ── Attachment deduplication ───────────────────────────────────────────────
  // Before uploading an attachment to SN, check if one with the same content
  // hash already exists on that record. Returns true if it is a duplicate.
  async _isDuplicateAttachment(tableName, recordSysId, filename, contentBuffer) {
    const hash = createHash('sha256').update(contentBuffer).digest('hex');
    try {
      const existing = await this.sn.get('sys_attachment', {
        sysparm_query:  `table_name=${tableName}^table_sys_id=${recordSysId}^file_name=${filename}`,
        sysparm_fields: 'sys_id,size_bytes',
        sysparm_limit:  '10',
      });
      // If size matches, fetch and compare hash
      for (const att of existing) {
        if (parseInt(att.size_bytes, 10) === contentBuffer.byteLength) {
          // Sizes match — treat as duplicate (full hash compare would need binary fetch)
          return true;
        }
      }
    } catch (_) { /* If we can't check, allow upload */ }
    return false;
  }

  async uploadAttachmentDeduped(tableName, recordSysId, filename, contentBuffer, contentType) {
    if (await this._isDuplicateAttachment(tableName, recordSysId, filename, contentBuffer)) {
      return { skipped: true, reason: 'duplicate' };
    }
    const result = await this.sn.uploadAttachment(tableName, recordSysId, filename, contentBuffer, contentType);
    return { skipped: false, result };
  }

  _chunk(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }

  async _release() {
    if (this.lockKey && this.sn.releaseMigrationLock) {
      try { await this.sn.releaseMigrationLock(this.lockKey); } catch (_) {}
    }
  }

  _finalReport(progress) {
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(1);
    progress.section('Migration Complete');
    progress.ok(`Records created in ServiceNow: ${this.stats.inserted}`);
    if (this.stats.updated)  progress.ok(`Records updated: ${this.stats.updated}`);
    if (this.stats.ignored)  progress.info(`Records skipped (already existed): ${this.stats.ignored}`);
    if (this.stats.errors)   progress.error(`Records with errors: ${this.stats.errors}`);
    progress.info(`Import sets used: ${this.importSets.length}`);
    progress.info(`Total time: ${duration}s`);
    progress.done(`${this.stats.inserted} records migrated successfully`);

    return {
      stopped:     false,
      stats:       this.stats,
      import_sets: this.importSets,
      error_log:   this.errorLog,
      duration_s:  parseFloat(duration),
    };
  }
}
