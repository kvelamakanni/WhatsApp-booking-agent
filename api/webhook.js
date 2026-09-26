// Vercel serverless function — WhatsApp Cloud API webhook.
// GET: Meta's one-time endpoint verification.
// POST: incoming message handling, same shape as the local App's server.js,
// but stateless (session lives in Vercel KV, see ../lib/session.js) and
// with no LLM/proxy backend — booking logic in ../lib/bookingAgent.js is
// fully rule-based and calls Devara Hotels MCP directly.

const { createSession, greet, dispatch } = require('../lib/bookingAgent');
const { getSession, setSession, acquireLock, releaseLock } = require('../lib/session');

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const RESET_KEYWORDS = new Set(['clear', 'reset', 'restart', 'start over']);

async function sendWhatsAppText(to, phoneNumberId, text) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        text: { body: text },
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      console.error('WhatsApp API rejected the message:', res.status, JSON.stringify(data));
      return;
    }
    console.log('Reply sent:', text, '—', JSON.stringify(data));
  } catch (err) {
    console.error('Error sending WhatsApp reply:', err);
  }
}

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
  const text = message.text?.body;
  const phoneNumberId = change.value.metadata.phone_number_id;

  console.log(`Message from ${from}: ${text}`);

  // IMPORTANT: do all the work BEFORE responding, not after. Vercel's
  // serverless runtime can freeze/tear down the execution context as soon
  // as the HTTP response is sent — continuing to `await` Redis/MCP/WhatsApp
  // calls after an early res.end() (as the local Express version safely
  // does) can get silently killed mid-flight with no further logs at all.
  let gotLock = false;
  try {
    gotLock = await acquireLock(from);
    if (!gotLock) {
      await sendWhatsAppText(from, phoneNumberId, "Still working on your last message — one moment!");
      res.status(200).end();
      return;
    }

    if (RESET_KEYWORDS.has((text || '').trim().toLowerCase())) {
      const freshSession = createSession();
      await setSession(from, freshSession);
      await sendWhatsAppText(from, phoneNumberId, "Session cleared! " + greet());
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
      await sendWhatsAppText(from, phoneNumberId, greet());
      await setSession(from, session);
      res.status(200).end();
      return;
    }

    const replies = await dispatch(session, text);
    await setSession(from, session);

    for (const reply of replies) {
      await sendWhatsAppText(from, phoneNumberId, reply);
    }
  } catch (err) {
    console.error('Error handling booking message:', err);
    await sendWhatsAppText(from, phoneNumberId, "Sorry, I couldn't process that right now.").catch(() => {});
  } finally {
    if (gotLock) {
      await releaseLock(from).catch((err) => console.error('Error releasing lock:', err));
    }
  }

  res.status(200).end();
};
