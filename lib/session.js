// Per-phone-number session state and a lightweight lock, backed by a
// standalone Upstash Redis database (not the deprecated Vercel KV product)
// instead of the local App's in-memory Map — Vercel functions are stateless
// and can run as multiple concurrent instances, so state must live outside
// the process. Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.

const { Redis } = require('@upstash/redis');
const kv = Redis.fromEnv();

const SESSION_TTL_SECONDS = 60 * 60 * 6; // 6 hours of inactivity before a session expires
const LOCK_TTL_SECONDS = 15; // guards against a stuck lock if a function crashes mid-request
const MESSAGE_DEDUPE_TTL_SECONDS = 60 * 60 * 24; // WhatsApp can retry a webhook delivery for a while — remember longer than that
const PAYMENT_TTL_SECONDS = 60 * 60 * 6; // how long a pending/finished payment record is kept
const REDIS_CALL_TIMEOUT_MS = 5000; // fail fast with a clear error instead of hanging until Vercel's own timeout

function paymentKey(stripeSessionId) {
  return `pay:${stripeSessionId}`;
}

function paymentDoneKey(stripeSessionId) {
  return `paid:${stripeSessionId}`;
}

function sessionKey(phone) {
  return `session:${phone}`;
}

function lockKey(phone) {
  return `lock:${phone}`;
}

function messageKey(messageId) {
  return `msg:${messageId}`;
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
 * Deletes a phone number's session outright (rather than replacing it with
 * a fresh one) so the *next* incoming message is treated exactly like a
 * brand-new conversation — getSession() will return null, taking the
 * "just greet, don't process this message as data" path instead of being
 * consumed as an answer to whatever question the last session left off on.
 */
async function clearSession(phone) {
  await withTimeout(kv.del(sessionKey(phone)), 'clearSession');
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

/**
 * Marks a WhatsApp message ID as processed. Returns true the first time
 * it's called for a given ID, false on every subsequent call — used to
 * detect and skip retried webhook deliveries of the same message, which
 * WhatsApp sends whenever it doesn't get an ack quickly enough. Without
 * this, a slow response could cause the same "Hi" (or any message) to be
 * run through dispatch() two or three times, advancing the booking state
 * machine using stale/repeated text.
 */
async function markMessageProcessed(messageId) {
  const result = await withTimeout(kv.set(messageKey(messageId), '1', { nx: true, ex: MESSAGE_DEDUPE_TTL_SECONDS }), 'markMessageProcessed');
  return result !== null;
}

/**
 * A pending payment, keyed by the Stripe Checkout session id. It carries
 * everything the payment-success endpoint needs to finish the booking and
 * message the guest — that endpoint runs when Stripe redirects the guest's
 * browser, with no WhatsApp message (and so no phone / phoneNumberId) in hand.
 */
async function setPayment(stripeSessionId, record) {
  await withTimeout(kv.set(paymentKey(stripeSessionId), record, { ex: PAYMENT_TTL_SECONDS }), 'setPayment');
}

async function getPayment(stripeSessionId) {
  return withTimeout(kv.get(paymentKey(stripeSessionId)), 'getPayment');
}

/**
 * Exactly-once guard for finishing a paid booking. Returns true only the
 * first time it's called for a given Stripe session; the success URL can be
 * refreshed or opened twice, and the second hit must not book again.
 */
async function markPaymentCompleted(stripeSessionId) {
  const result = await withTimeout(
    kv.set(paymentDoneKey(stripeSessionId), '1', { nx: true, ex: PAYMENT_TTL_SECONDS }),
    'markPaymentCompleted',
  );
  return result !== null;
}

/** Frees the guard when completing the booking failed, so a refresh of the success page can retry. */
async function releasePaymentClaim(stripeSessionId) {
  await withTimeout(kv.del(paymentDoneKey(stripeSessionId)), 'releasePaymentClaim');
}

module.exports = {
  getSession, setSession, clearSession, acquireLock, releaseLock, markMessageProcessed,
  setPayment, getPayment, markPaymentCompleted, releasePaymentClaim,
};
