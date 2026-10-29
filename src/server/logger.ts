/**
 * Structured JSON logger that never emits tokens or PII.
 * - Any key that looks sensitive is replaced with "[REDACTED]" (deeply).
 * - Strings are scrubbed for email addresses, bearer tokens and JWT-like blobs,
 *   so error messages bubbling up from APIs cannot leak them either.
 */
const SENSITIVE_KEY =
  /token|secret|password|authorization|cookie|^code$|email|phone|first|last|name|address|birth|properties|submissions|info|values|patch/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER = /bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const LONG_SECRET = /\b[A-Za-z0-9\-_]{32,}\.[A-Za-z0-9\-_]{10,}(\.[A-Za-z0-9\-_]+)?\b/g; // JWT / signed instance

// Keys that match the pattern above but are safe identifiers we want to see.
const ALLOW = new Set(['instanceId', 'wixContactId', 'hubspotContactId', 'portalId', 'jobType', 'eventType', 'fieldCount', 'propertyName']);

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (typeof value === 'string') return scrubString(value);
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = !ALLOW.has(k) && SENSITIVE_KEY.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function scrubString(s: string): string {
  return s.replace(BEARER, 'Bearer [REDACTED]').replace(EMAIL, '[email]').replace(LONG_SECRET, '[token]');
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function emit(level: Level, msg: string, ctx?: Record<string, unknown>) {
  if (ORDER[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: scrubString(msg), ...(ctx ? (scrub(ctx) as object) : {}) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit('error', msg, ctx),
};
