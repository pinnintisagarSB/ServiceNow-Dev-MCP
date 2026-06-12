/**
 * Audit Trail
 *
 * Logs every migrated record with before/after snapshots and timing.
 * Written to a local NDJSON file so it survives process restarts and can
 * be replayed or queried without importing into ServiceNow.
 *
 * Format (one JSON object per line):
 * {
 *   ts, sessionId, phase,
 *   sourceTable, sourceId,
 *   snTable, snSysId,
 *   action,          // "create" | "update" | "skip" | "error"
 *   fieldsBefore,    // {} for creates
 *   fieldsAfter,
 *   durationMs,
 *   error?           // only on action="error"
 * }
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export class AuditTrail {
  constructor(opts = {}) {
    this.sessionId  = opts.sessionId ?? randomUUID();
    this.outputPath = opts.outputPath ?? path.join(process.cwd(), 'migration-audit.ndjson');
    this._stream    = null;
    this._stats     = { created: 0, updated: 0, skipped: 0, errors: 0, totalMs: 0 };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  open() {
    this._stream = fs.createWriteStream(this.outputPath, { flags: 'a' });
    this._log({ phase: 'session_start', sessionId: this.sessionId });
    return this;
  }

  close() {
    this._log({ phase: 'session_end', stats: this._stats, sessionId: this.sessionId });
    return new Promise(resolve => this._stream.end(resolve));
  }

  // ── Record logging ─────────────────────────────────────────────────────────
  recordCreated({ sourceTable, sourceId, snTable, snSysId, fieldsAfter = {}, durationMs = 0 }) {
    this._stats.created++;
    this._stats.totalMs += durationMs;
    this._log({ action: 'create', sourceTable, sourceId, snTable, snSysId, fieldsBefore: {}, fieldsAfter, durationMs });
  }

  recordUpdated({ sourceTable, sourceId, snTable, snSysId, fieldsBefore = {}, fieldsAfter = {}, durationMs = 0 }) {
    this._stats.updated++;
    this._stats.totalMs += durationMs;
    this._log({ action: 'update', sourceTable, sourceId, snTable, snSysId, fieldsBefore, fieldsAfter, durationMs });
  }

  recordSkipped({ sourceTable, sourceId, snTable, reason }) {
    this._stats.skipped++;
    this._log({ action: 'skip', sourceTable, sourceId, snTable, reason });
  }

  recordError({ sourceTable, sourceId, snTable, error, fieldsAfter = {} }) {
    this._stats.errors++;
    this._log({ action: 'error', sourceTable, sourceId, snTable, fieldsAfter, error: String(error) });
  }

  // ── Internal ───────────────────────────────────────────────────────────────
  _log(data) {
    const entry = { ts: new Date().toISOString(), sessionId: this.sessionId, ...data };
    if (this._stream?.writable) {
      this._stream.write(JSON.stringify(entry) + '\n');
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  stats() {
    return {
      ...this._stats,
      avgMsPerRecord: this._stats.created + this._stats.updated > 0
        ? Math.round(this._stats.totalMs / (this._stats.created + this._stats.updated))
        : 0,
    };
  }

  // ── Replay / query support (static) ───────────────────────────────────────
  static async query(filePath, filter = {}) {
    const { action, snTable, sourceTable } = filter;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return entries.filter(e => {
      if (action     && e.action     !== action)     return false;
      if (snTable    && e.snTable    !== snTable)    return false;
      if (sourceTable && e.sourceTable !== sourceTable) return false;
      return true;
    });
  }
}
