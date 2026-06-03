/* eslint-env node */
// Structured logger with two output modes:
//   - JSON lines (default, production)
//   - Pretty multi-line (set LOG_PRETTY=true in dev)
//
// Errors always print a fully-resolved stack trace (including cause
// chains) on a separate line so they're not buried inside escaped JSON.
// (Mirrors the wholesale workspace's logger.utils.)

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;
const PRETTY = process.env.LOG_PRETTY === "true";

const LEVEL_LABEL = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

function serializeError(err) {
  if (!err || typeof err !== "object") return err;
  const out = {
    message: err.message,
    name: err.name,
    code: err.code,
    status: err.status,
    body: err.body,
  };
  if (err.cause) out.cause = serializeError(err.cause);
  return out;
}

function fullStack(err, depth = 0) {
  if (!err) return "";
  const indent = "  ".repeat(depth);
  let s = `${indent}${err.stack || `${err.name || "Error"}: ${err.message}`}`;
  if (err.cause) s += `\n${indent}Caused by:\n${fullStack(err.cause, depth + 1)}`;
  return s;
}

function safeJson(v) {
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
  } catch {
    return String(v);
  }
}

function emitJson(level, scope, event, fields) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    scope,
    event,
    ...fields,
  };
  if (payload.err) payload.err = serializeError(payload.err);
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function emitPretty(level, scope, event, fields) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const label = LEVEL_LABEL[level] || level;
  const head = `[${ts}] ${label} ${scope} → ${event}`;
  const { err, ...rest } = fields || {};

  const print = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  print(head);
  if (Object.keys(rest).length > 0) {
    for (const [k, v] of Object.entries(rest)) {
      const formatted =
        typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null
          ? String(v)
          : safeJson(v);
      print(`         ${k}: ${formatted}`);
    }
  }
  if (err) {
    print(`         err: ${err.message || err}`);
    if (err.status) print(`         err.status: ${err.status}`);
    if (err.body !== undefined) print(`         err.body: ${safeJson(err.body)}`);
    const stack = fullStack(err);
    if (stack) print(stack);
  }
}

function emit(level, scope, event, fields = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;
  if (PRETTY) emitPretty(level, scope, event, fields);
  else emitJson(level, scope, event, fields);
}

export function createLogger(scope) {
  return {
    debug: (event, fields) => emit("debug", scope, event, fields),
    info: (event, fields) => emit("info", scope, event, fields),
    warn: (event, fields) => emit("warn", scope, event, fields),
    error: (event, fields) => emit("error", scope, event, fields),
    child: (childScope) => createLogger(`${scope}.${childScope}`),
  };
}
