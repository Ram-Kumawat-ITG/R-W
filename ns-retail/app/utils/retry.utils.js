// Generic retry with exponential backoff + jitter, plus the typed error
// classes the QBO client uses to decide what to retry. Permanent errors
// (4xx auth/validation) bypass retry; transient errors (5xx / 429 /
// network) are retried up to `attempts` times.
// (Mirrors the wholesale workspace's retry.utils.)

const DEFAULTS = {
  attempts: 3,
  baseMs: 300,
  maxMs: 4000,
  factor: 2,
};

export class PermanentError extends Error {
  constructor(message, { cause, status, body } = {}) {
    super(message);
    this.name = "PermanentError";
    this.permanent = true;
    if (cause) this.cause = cause;
    if (status !== undefined) this.status = status;
    if (body !== undefined) this.body = body;
  }
}

export class TransientError extends Error {
  constructor(message, { cause, status, body } = {}) {
    super(message);
    this.name = "TransientError";
    this.permanent = false;
    if (cause) this.cause = cause;
    if (status !== undefined) this.status = status;
    if (body !== undefined) this.body = body;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function retry(fn, opts = {}) {
  const { attempts, baseMs, maxMs, factor, onAttempt } = { ...DEFAULTS, ...opts };
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (err?.permanent) throw err;
      if (attempt === attempts) break;
      const delay = Math.min(maxMs, baseMs * factor ** (attempt - 1));
      // ±25% jitter to avoid thundering herds
      const jittered = Math.round(delay * (0.75 + Math.random() * 0.5));
      onAttempt?.({ attempt, err, nextDelayMs: jittered });
      await sleep(jittered);
    }
  }
  throw lastErr;
}
