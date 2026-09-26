// Per-phone-number session state and a lightweight lock, backed by a
// standalone Upstash Redis database (not the deprecated Vercel KV product)
// instead of the local App's in-memory Map — Vercel functions are stateless
// and can run as multiple concurrent instances, so state must live outside
// the process. Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.

const { Redis } = require('@upstash/redis');
const kv = Redis.fromEnv();

const SESSION_TTL_SECONDS = 60 * 60 * 6; // 6 hours of inactivity before a session expires
const LOCK_TTL_SECONDS = 15; // guards against a stuck lock if a function crashes mid-request

function sessionKey(phone) {
  return `session:${phone}`;
}

function lockKey(phone) {
  return `lock:${phone}`;
}

async function getSession(phone) {
  return kv.get(sessionKey(phone));
}

async function setSession(phone, session) {
  await kv.set(sessionKey(phone), session, { ex: SESSION_TTL_SECONDS });
}

/**
 * Acquires a short-lived per-phone-number lock so concurrent webhook
 * deliveries for the same guest don't race on the same session.
 * Returns true if the lock was acquired, false if another request is
 * already in flight for this number.
 */
async function acquireLock(phone) {
  const result = await kv.set(lockKey(phone), '1', { nx: true, ex: LOCK_TTL_SECONDS });
  return result !== null;
}

async function releaseLock(phone) {
  await kv.del(lockKey(phone));
}

module.exports = { getSession, setSession, acquireLock, releaseLock };
