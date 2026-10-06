// Stripe sends the guest's browser here if they back out of Checkout.
// Nothing to undo: the room hold and the "Pay now" button in WhatsApp are
// both still there, so they can simply tap it again.

const { sendPage } = require('../lib/pages');

module.exports = async (req, res) => {
  sendPage(res, 200, {
    title: 'Payment cancelled',
    message: 'No charge was made. Head back to WhatsApp and tap Pay now whenever you\'re ready.',
    tone: 'warn',
  });
};
