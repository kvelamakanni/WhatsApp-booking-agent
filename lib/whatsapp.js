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
      return false;
    }
    console.log('Reply sent:', JSON.stringify(body), '—', JSON.stringify(data));
    return true;
  } catch (err) {
    console.error('Error sending WhatsApp reply:', err);
    return false;
  }
}

async function sendWhatsAppText(to, phoneNumberId, text) {
  return sendWhatsAppPayload(phoneNumberId, {
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
 *   { type: 'flow',   body, button, flowId, flowToken, screen, data, draft } — opens a WhatsApp Flow
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
  } else if (reply.type === 'flow') {
    interactive = {
      type: 'flow',
      body: { text: reply.body },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_id: reply.flowId,
          flow_token: reply.flowToken,
          flow_cta: reply.button,
          flow_action: 'navigate',
          flow_action_payload: { screen: reply.screen, data: reply.data },
          // A draft Flow can be sent for testing before it's published.
          ...(reply.draft ? { mode: 'draft' } : {}),
        },
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

  return sendWhatsAppPayload(phoneNumberId, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive,
  });
}

/**
 * Sends a plain string as text, or a typed object as an interactive message.
 * If an interactive message is rejected (for example a WhatsApp Flow that
 * Meta blocks for this account) and the object carries `fallbackText`, the
 * guest gets that plain text instead of silence.
 */
async function sendReply(to, phoneNumberId, reply) {
  if (typeof reply === 'string') {
    await sendWhatsAppText(to, phoneNumberId, reply);
    return;
  }
  const sent = await sendWhatsAppInteractive(to, phoneNumberId, reply);
  if (!sent && reply.fallbackText) {
    console.error(`Interactive "${reply.type}" message was rejected — sending the plain-text version instead.`);
    await sendWhatsAppText(to, phoneNumberId, reply.fallbackText);
  }
}

module.exports = { sendReply, sendWhatsAppText, sendWhatsAppInteractive };
