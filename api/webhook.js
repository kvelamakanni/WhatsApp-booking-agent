// Vercel serverless function — WhatsApp Cloud API webhook.
// GET: Meta's one-time endpoint verification.
// POST: incoming message handling, same shape as the local App's server.js,
// but stateless (session lives in Vercel KV, see ../lib/session.js) and
// with no LLM/proxy backend — booking logic in ../lib/bookingAgent.js is
// fully rule-based and calls Devara Hotels MCP directly.

const { createSession, greet, dispatch } = require('../lib/bookingAgent');
const { getSession, setSession, clearSession, acquireLock, releaseLock, markMessageProcessed, setPayment } = require('../lib/session');
const { sendReply } = require('../lib/whatsapp');

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const RESET_KEYWORDS = new Set(['clear', 'reset', 'restart', 'start over']);

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified!');
      res.status(200).send(challenge);
    } else {
      res.status(403).end();
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  console.log('Incoming webhook:', JSON.stringify(req.body, null, 2));

  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];

  if (!message) {
    // e.g. a status update event, not an actual message — nothing further to do
    res.status(200).end();
    return;
  }

  const from = message.from;
  const phoneNumberId = change.value.metadata.phone_number_id;
  const messageId = message.id;

  // A tapped list row or quick-reply button arrives as type "interactive"
  // (not "text") — its reply.id is what we treat as the guest's answer.
  // We chose those IDs (in bookingAgent.js) to be exactly the same values
  // the existing plain-text parsing already accepts — e.g. "2" for the
  // second hotel, or "New York" for that destination — so every step
  // handler keeps working unchanged whether the guest tapped or typed.
  const text =
    message.type === 'interactive'
      ? message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id
      : message.text?.body;

  console.log(`Message from ${from}: ${text}`);

  // WhatsApp retries a webhook delivery if it doesn't get an ack quickly
  // enough, resending the exact same message. Without deduplicating by
  // message ID, a retry gets fully reprocessed and can advance the booking
  // state machine using stale/repeated text (e.g. the retried "Hi" getting
  // interpreted as a destination, then a further retry as a dates answer).
  if (messageId) {
    let isNewMessage = true;
    try {
      isNewMessage = await markMessageProcessed(messageId);
    } catch (err) {
      console.error('Error checking message dedupe (proceeding anyway):', err);
    }
    if (!isNewMessage) {
      console.log(`Duplicate delivery of message ${messageId} — skipping reprocessing.`);
      res.status(200).end();
      return;
    }
  }

  if (text === undefined) {
    console.log(`Unsupported message type "${message.type}" — ignoring.`);
    await sendReply(from, phoneNumberId, "Sorry, I can only understand text messages and menu selections right now.");
    res.status(200).end();
    return;
  }

  // IMPORTANT: do all the work BEFORE responding, not after. Vercel's
  // serverless runtime can freeze/tear down the execution context as soon
  // as the HTTP response is sent — continuing to `await` Redis/MCP/WhatsApp
  // calls after an early res.end() (as the local Express version safely
  // does) can get silently killed mid-flight with no further logs at all.
  let gotLock = false;
  try {
    gotLock = await acquireLock(from);
    if (!gotLock) {
      await sendReply(from, phoneNumberId, "Still working on your last message — one moment!");
      res.status(200).end();
      return;
    }

    if (RESET_KEYWORDS.has((text || '').trim().toLowerCase())) {
      // Delete the session outright rather than replacing it with a fresh
      // one — that way the *next* message takes the brand-new-conversation
      // path below (just greet, don't consume it as data), instead of being
      // treated as the answer to "where would you like to stay?" the way a
      // persisted fresh session would be.
      await clearSession(from);
      await sendReply(from, phoneNumberId, 'Cleared! Send any message to start a new conversation.');
      res.status(200).end();
      return;
    }

    let session = await getSession(from);
    if (!session) {
      // Brand-new conversation: just greet and stop here. The trigger
      // message itself ("Hi", "hello", etc.) is not real booking data —
      // don't also run it through dispatch(), or it gets treated as the
      // answer to "where would you like to stay?" (step 1 only checks
      // length >= 2, so "Hi" would pass as a destination).
      session = createSession();
      await sendReply(from, phoneNumberId, greet());
      await setSession(from, session);
      res.status(200).end();
      return;
    }

    // Payment needs to know who to message later (from + phoneNumberId) and
    // which public URL Stripe should send the guest back to.
    const baseUrl = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const replies = await dispatch(session, text, { from, phoneNumberId, baseUrl, savePayment: setPayment });
    await setSession(from, session);

    for (const reply of replies) {
      await sendReply(from, phoneNumberId, reply);
    }
  } catch (err) {
    console.error('Error handling booking message:', err);
    await sendReply(from, phoneNumberId, "Sorry, I couldn't process that right now.").catch(() => {});
  } finally {
    if (gotLock) {
      await releaseLock(from).catch((err) => console.error('Error releasing lock:', err));
    }
  }

  res.status(200).end();
};
