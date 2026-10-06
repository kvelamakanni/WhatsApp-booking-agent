// Stripe Checkout (test mode) for the demo payment step.
//
// The Devara MCP never actually charges anything — its complete_booking
// ignores the payment token — so this is the only real payment gate in the
// flow: the guest pays on a Stripe-hosted page, and only then does the
// booking get completed.

const Stripe = require('stripe');

let client;

// Created lazily, not at require time: a missing/invalid key should fail
// only when a payment is attempted, never take the whole webhook down.
function stripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  if (!key.startsWith('sk_test_')) {
    throw new Error('Refusing to use a non-test Stripe key — this demo only supports sk_test_ keys');
  }
  if (!client) client = new Stripe(key);
  return client;
}

/**
 * Creates a hosted Checkout page for one hotel booking.
 * `amountCents` is the MCP's own total (already in cents), so there is no
 * currency rounding on our side.
 */
async function createCheckoutSession({ amountCents, currency = 'usd', description, phone, mcpSessionId, baseUrl }) {
  return stripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: currency.toLowerCase(),
          unit_amount: amountCents,
          product_data: { name: description },
        },
      },
    ],
    success_url: `${baseUrl}/api/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/api/payment-cancel`,
    metadata: { phone, mcpSessionId },
  });
}

async function getCheckoutSession(sessionId) {
  return stripe().checkout.sessions.retrieve(sessionId);
}

// Stripe's own test PaymentMethod token. It stands in for "a card the guest
// saved earlier" — in a real product the card would be saved on a first
// Checkout payment (setup_future_usage: 'off_session') with the guest's
// consent. Here it's attached automatically, so it's a demo shortcut.
const DEMO_SAVED_CARD = 'pm_card_visa';

/**
 * The guest's "card on file" for one-tap payment. Created once per phone
 * number (a Stripe Customer with the test card attached) and cached through
 * `store` so later bookings reuse it.
 * @returns {{ customerId: string, paymentMethodId: string, brand: string, last4: string }}
 */
async function ensureSavedCard(phone, store) {
  const existing = await store.getSavedCard(phone);
  if (existing) return existing;

  const s = stripe();
  const customer = await s.customers.create({
    description: 'WhatsApp demo guest',
    metadata: { whatsapp_phone: phone },
  });
  const pm = await s.paymentMethods.attach(DEMO_SAVED_CARD, { customer: customer.id });
  const saved = {
    customerId: customer.id,
    paymentMethodId: pm.id,
    brand: pm.card.brand,
    last4: pm.card.last4,
  };
  await store.setSavedCard(phone, saved);
  return saved;
}

/**
 * Charges the saved card off-session, in one call. The idempotency key is
 * per booking, so a retried request can never charge the same booking twice.
 */
async function chargeSavedCard({ saved, amountCents, currency = 'usd', description, phone, mcpSessionId }) {
  return stripe().paymentIntents.create(
    {
      amount: amountCents,
      currency: currency.toLowerCase(),
      customer: saved.customerId,
      payment_method: saved.paymentMethodId,
      off_session: true,
      confirm: true,
      description,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { phone, mcpSessionId },
    },
    { idempotencyKey: `pi_${mcpSessionId}` },
  );
}

/** Makes an unpaid Checkout link unusable (used once the saved-card path has paid). */
async function expireCheckoutSession(sessionId) {
  return stripe().checkout.sessions.expire(sessionId);
}

async function refundPayment(paymentIntentId) {
  return stripe().refunds.create({ payment_intent: paymentIntentId });
}

module.exports = {
  createCheckoutSession,
  getCheckoutSession,
  ensureSavedCard,
  chargeSavedCard,
  expireCheckoutSession,
  refundPayment,
};
