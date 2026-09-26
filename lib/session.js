// Per-phone-number session state and a lightweight lock, backed by a
// standalone Upstash Redis database (not the deprecated Vercel KV product)
// instead of the local App's in-memory Map — Vercel functions are stateless
// and can run as multiple concurrent instances, so state must live outside
// the process. Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.

const { Redis } = require('@upstash/redis');
const kv = Redis.fromEnv();

const SESSION_TTL_SECONDS = 60 * 60 * 6; // 6 hours of inactivity before a session expires
const LOCK_TTL_SECONDS = 15; // guards against a stuck lock if a function crashes mid-request
const REDIS_CALL_TIMEOUT_MS = 5000; // fail fast with a clear error instead of hanging until Vercel's own timeout

function sessionKey(phone) {
  return `session:${phone}`;
}

function lockKey(phone) {
  return `lock:${phone}`;
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Redis call timed out after ${REDIS_CALL_TIMEOUT_MS}ms: ${label}`)), REDIS_CALL_TIMEOUT_MS),
    ),
  ]);
}

async function getSession(phone) {
  return withTimeout(kv.get(sessionKey(phone)), 'getSession');
}

async function setSession(phone, session) {
  await withTimeout(kv.set(sessionKey(phone), session, { ex: SESSION_TTL_SECONDS }), 'setSession');
}

/**
 * Acquires a short-lived per-phone-number lock so concurrent webhook
 * deliveries for the same guest don't race on the same session.
 * Returns true if the lock was acquired, false if another request is
 * already in flight for this number.
 */
async function acquireLock(phone) {
  const result = await withTimeout(kv.set(lockKey(phone), '1', { nx: true, ex: LOCK_TTL_SECONDS }), 'acquireLock');
  return result !== null;
}

async function releaseLock(phone) {
  await withTimeout(kv.del(lockKey(phone)), 'releaseLock');
}

module.exports = { getSession, setSession, acquireLock, releaseLock };
