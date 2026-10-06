// Stripe sends the guest's browser here after a successful Checkout:
//   /api/payment-success?session_id=cs_test_...
//
// Confirmation is deliberately redirect-based (no Stripe webhook) to keep
// the demo simple. It does NOT trust the redirect itself: it asks Stripe's
// API whether the session is actually paid, so the URL can't be forged.
// Known limitation: if a guest pays and closes the tab before this page
// loads, the booking isn't completed — a webhook would close that gap.

const { getCheckoutSession } = require('../lib/stripe');
const { getPayment, markPaymentCompleted, releasePaymentClaim, getSession, setSession } = require('../lib/session');
const { completeAfterPayment } = require('../lib/bookingAgent');
const { sendReply } = require('../lib/whatsapp');
const { sendPage } = require('../lib/pages');

module.exports = async (req, res) => {
  const stripeSessionId = req.query.session_id;
  if (typeof stripeSessionId !== 'string' || !stripeSessionId.startsWith('cs_')) {
    return sendPage(res, 400, {
      title: 'Missing payment reference',
      message: 'This page needs to be opened from the payment screen. Head back to WhatsApp to try again.',
      tone: 'warn',
    });
  }

  let claimed = false;
  try {
    const checkout = await getCheckoutSession(stripeSessionId);
    if (checkout.payment_status !== 'paid') {
      return sendPage(res, 402, {
        title: 'Payment not completed',
        message: "We haven't received your payment yet. Head back to WhatsApp and tap Pay now to try again.",
        tone: 'warn',
      });
    }

    const record = await getPayment(stripeSessionId);
    if (!record || checkout.metadata?.mcpSessionId !== record.mcpSessionId) {
      return sendPage(res, 404, {
        title: 'Booking not found',
        message: 'This payment link has expired. Head back to WhatsApp to start a new booking.',
        tone: 'error',
      });
    }

    // The page can be refreshed or opened twice — only the first hit books.
    claimed = await markPaymentCompleted(stripeSessionId);
    if (claimed) {
      const confirmation = await completeAfterPayment(record);

      const guestSession = await getSession(record.phone);
      if (guestSession) {
        guestSession.state.step = 8; // booking confirmed
        await setSession(record.phone, guestSession);
      }

      await sendReply(record.phone, record.phoneNumberId, confirmation);
    }

    return sendPage(res, 200, {
      title: 'Payment received',
      message: 'Thank you! Head back to WhatsApp — your booking confirmation is waiting for you there.',
      tone: 'ok',
    });
  } catch (err) {
    console.error('payment-success error:', err);
    // Booking didn't complete, so let a refresh of this page try again.
    if (claimed) await releasePaymentClaim(stripeSessionId).catch(() => {});
    return sendPage(res, 500, {
      title: 'Something went wrong',
      message: "Your payment went through, but we couldn't finish the booking. Please refresh this page in a moment.",
      tone: 'error',
    });
  }
};
