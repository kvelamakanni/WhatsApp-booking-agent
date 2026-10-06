// Outbound WhatsApp Cloud API senders. Shared by api/webhook.js (replies to
// incoming messages) and api/payment-success.js (the confirmation sent after
// a Stripe payment completes — there is no incoming WhatsApp message to
// reply to at that point, so it needs to send on its own).

async function sendWhatsAppPayload(phoneNumberId, body) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      console.error('WhatsApp API rejected the message:', res.status, JSON.stringify(data));
      return;
    }
    console.log('Reply sent:', JSON.stringify(body), '—', JSON.stringify(data));
  } catch (err) {
    console.error('Error sending WhatsApp reply:', err);
  }
}

async function sendWhatsAppText(to, phoneNumberId, text) {
  await sendWhatsAppPayload(phoneNumberId, {
    messaging_product: 'whatsapp',
    to,
    text: { body: text },
  });
}

/**
 * Sends an interactive message. `reply` is one of the typed objects
 * bookingAgent.js returns:
 *   { type: 'list',   body, button, rows: [{id, title, description?}] }
 *   { type: 'button', body, buttons: [{id, title}] }
 *   { type: 'cta',    body, button, url }   — a button that opens a link
 */
async function sendWhatsAppInteractive(to, phoneNumberId, reply) {
  let interactive;
  if (reply.type === 'list') {
    interactive = {
      type: 'list',
      body: { text: reply.body },
      action: {
        button: reply.button,
        sections: [{ rows: reply.rows.map((r) => ({ id: r.id, title: r.title, description: r.description })) }],
      },
    };
  } else if (reply.type === 'cta') {
    interactive = {
      type: 'cta_url',
      body: { text: reply.body },
      action: { name: 'cta_url', parameters: { display_text: reply.button, url: reply.url } },
    };
  } else {
    interactive = {
      type: 'button',
      body: { text: reply.body },
      action: {
        buttons: reply.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    };
  }

  await sendWhatsAppPayload(phoneNumberId, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive,
  });
}

/** Sends a plain string as text, or a typed object as an interactive message. */
async function sendReply(to, phoneNumberId, reply) {
  if (typeof reply === 'string') {
    await sendWhatsAppText(to, phoneNumberId, reply);
  } else {
    await sendWhatsAppInteractive(to, phoneNumberId, reply);
  }
}

module.exports = { sendReply, sendWhatsAppText, sendWhatsAppInteractive };
