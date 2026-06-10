// Logs to stderr so MCP stdout stays clean for protocol messages
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? 1;

export const logger = {
  debug:   (msg) => current <= 0 && process.stderr.write(`[debug] ${msg}\n`),
  info:    (msg) => current <= 1 && process.stderr.write(`[info]  ${msg}\n`),
  success: (msg) => process.stderr.write(`[ok]    ${msg}\n`),
  warn:    (msg) => current <= 2 && process.stderr.write(`[warn]  ${msg}\n`),
  error:   (msg) => current <= 3 && process.stderr.write(`[error] ${msg}\n`),
  step:    (msg) => process.stderr.write(`\n>> ${msg}\n`),
  divider: ()    => process.stderr.write(`${'─'.repeat(60)}\n`),
};
