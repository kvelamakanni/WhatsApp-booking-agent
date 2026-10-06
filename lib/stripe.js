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

module.exports = { createCheckoutSession, getCheckoutSession };
