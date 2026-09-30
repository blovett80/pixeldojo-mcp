/**
 * Log-boundary redaction. Strips PixelDojo API keys (`pd_<alphanumerics>`)
 * from any string passed through the logger so a debug message can never
 * leak a customer's key into MCP-host logs.
 *
 * Per Eng review: redaction is not optional, even for "internal" log
 * lines — the MCP host (Claude Code, Cursor) controls the log destination
 * and we cannot assume it is private.
 */

const PD_KEY_RE = /pd_[A-Za-z0-9_-]{8,}/g;
const REDACTED = '[redacted]';

/**
 * Replace any pd_xxx token in a string with `[redacted]`. Returns the
 * original input unchanged when no token is present, so the common case
 * is a no-op allocation-wise.
 */
export function redactKeys(input: string): string {
  if (!input || typeof input !== 'string') return input;
  if (!input.includes('pd_')) return input;
  return input.replace(PD_KEY_RE, REDACTED);
}

/**
 * Recursively redact a value before sending it to a logger. Strings are
 * scrubbed via `redactKeys`. Plain objects and arrays are walked. Symbols,
 * functions, and primitives other than string pass through unchanged.
 *
 * Cycle-safe via WeakSet: an object that references itself is replaced
 * with `[circular]` rather than crashing the logger.
 */
export function redactValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactKeys(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, seen);
  }
  return out;
}

/**
 * Build a logger that wraps `console.error` (the conventional place for
 * MCP server logs — stdout is reserved for JSON-RPC framing). Every
 * message and arg is passed through `redactValue` first.
 */
export function makeRedactedLogger(target: Pick<Console, 'error'> = console) {
  return {
    error(msg: string, ...args: unknown[]) {
      const redactedArgs = args.map((a) => redactValue(a));
      target.error(`[pixeldojo-mcp] ${redactKeys(msg)}`, ...redactedArgs);
    },
  };
}
