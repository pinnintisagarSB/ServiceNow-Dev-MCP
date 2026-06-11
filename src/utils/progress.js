/**
 * Plain-English progress tracker.
 * Prints clear step messages that non-technical users can follow.
 */
export class Progress {
  constructor(totalSteps, taskName = 'Migration') {
    this.totalSteps = totalSteps;
    this.taskName   = taskName;
    this.current    = 0;
    this.startTime  = Date.now();
  }

  step(label) {
    this.current++;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
    process.stderr.write(`\n[${this.current}/${this.totalSteps}] ${label} (${elapsed}s elapsed)\n`);
  }

  info(msg)    { process.stderr.write(`    ℹ  ${msg}\n`); }
  ok(msg)      { process.stderr.write(`    ✓  ${msg}\n`); }
  warn(msg)    { process.stderr.write(`    ⚠  ${msg}\n`); }
  error(msg)   { process.stderr.write(`    ✗  ${msg}\n`); }

  section(title) {
    const line = '─'.repeat(55);
    process.stderr.write(`\n${line}\n  ${title}\n${line}\n`);
  }

  done(summary) {
    const total = ((Date.now() - this.startTime) / 1000).toFixed(1);
    process.stderr.write(`\n✅  ${this.taskName} finished in ${total}s — ${summary}\n\n`);
  }

  // Batch progress bar: "████░░░░  40/100 records"
  batch(done, total, label = 'records') {
    const pct   = total ? Math.floor((done / total) * 20) : 0;
    const bar   = '█'.repeat(pct) + '░'.repeat(20 - pct);
    process.stderr.write(`\r    ${bar}  ${done}/${total} ${label}   `);
    if (done === total) process.stderr.write('\n');
  }
}
