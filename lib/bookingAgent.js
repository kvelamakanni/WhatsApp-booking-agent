// Same 7-step booking state machine shape as the local App's bookingAgent.js
// (itself ported from ai-booking's useBookingFlow.ts), but with every LLM
// call replaced by rule-based extraction (lib/extract.js) and static
// template replies instead of ai()-generated text. No LLM/Ollama dependency.

const { extractDates, extractSelection, extractGuestCount, extractGuestDetails } = require('./extract');
const { searchHotels, getHotelDetails, createBookingSession, completeBooking } = require('./mcp');
const { todayIso, parseFlowDatesText, validateStay, FLOW_DATES_PREFIX } = require('./flows');
const { createCheckoutSession, ensureSavedCard, chargeSavedCard, expireCheckoutSession, refundPayment } = require('./stripe');

// Destinations we actually have inventory for. Anything else typed by the
// guest falls back to DEFAULT_DESTINATION for the MCP search, so the
// searchHotels() call always has a city we know Devara's MCP can serve.
const DEFAULT_DESTINATION = 'New York';
const DESTINATION_ALIASES = {
  'new york': 'New York',
  'newyork': 'New York',
  'ny': 'New York',
  'nyc': 'New York',
  'chicago': 'Chicago',
  'los angeles': 'Los Angeles',
  'los angles': 'Los Angeles', // common typo
  'la': 'Los Angeles',
  'paris': 'Paris',
  'dubai': 'Dubai',
  'bali': 'Bali',
  'london': 'London',
};
const SUPPORTED_DESTINATIONS_LIST = ['New York', 'Chicago', 'Los Angeles', 'Paris', 'Dubai', 'Bali', 'London'];

// WhatsApp List Messages allow at most 10 rows; row titles are capped at 24
// characters. Row/button ids below are deliberately chosen to be exactly
// what the existing plain-text parsing already accepts (a digit string for
// a numbered pick, the canonical destination name for a city) — so a
// guest can tap OR type, and every step handler below needs no changes
// to support both.
const MAX_LIST_ROWS = 10;

function truncate(s, n) {
  if (typeof s !== 'string' || s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function guestCountPrompt(prefix = '') {
  return {
    type: 'button',
    body: `${prefix ? prefix + ' ' : ''}How many guests will be staying?`,
    buttons: [
      { id: '1', title: '1 guest' },
      { id: '2', title: '2 guests' },
      { id: '3', title: '3+ guests' },
    ],
  };
}

/** Matches free text against the supported destination list; returns the canonical name or null if no match. */
function matchDestination(text) {
  const lower = text.toLowerCase();
  if (DESTINATION_ALIASES[lower]) return DESTINATION_ALIASES[lower];
  for (const [alias, canonical] of Object.entries(DESTINATION_ALIASES)) {
    if (lower.includes(alias)) return canonical;
  }
  return null;
}

function initialState() {
  return {
    step: 1,
    guest: { name: '', email: '', phone: '' },
    destination: '',
    checkin: '',
    checkout: '',
    numGuests: 1,
    hotels: [],
    selectedHotel: null,
    products: [],
    selected: null,
    sessionId: null,
    paymentToken: '',
    stripeSessionId: null,
    paymentUrl: '',
    paymentTotal: '',
    savedCard: null,
  };
}

/** One of these is created per WhatsApp phone number and persisted in Vercel KV. */
function createSession() {
  return { state: initialState() };
}

function getMissingContact(S) {
  const missing = [];
  if (!S.guest.name) missing.push('name');
  if (!S.guest.email) missing.push('email');
  if (!S.guest.phone) missing.push('phone');
  return missing;
}

function isContactComplete(S) {
  return Boolean(S.guest.name && S.guest.email && S.guest.phone);
}

function promptForContact(S) {
  const missing = getMissingContact(S);
  if (!missing.length) return null;
  const hotel = S.selectedHotel?.name ?? 'your chosen hotel';
  const roomName = S.selected?.name ?? S.selected?.title ?? 'the room';
  return `Great choice — ${hotel}, ${roomName}! Your room is held. To confirm the booking, please send your ${missing.join(', ')}.`;
}

function greet() {
  return {
    type: 'list',
    body: "Hi! I'm your Hotels booking assistant. Where would you like to stay?",
    button: 'View destinations',
    rows: SUPPORTED_DESTINATIONS_LIST.map((city) => ({ id: city, title: city })),
  };
}

// ─── step handlers ───────────────────────────────────────────

// Asks for the stay dates. With a dates Flow configured
// (WHATSAPP_DATES_FLOW_ID) the guest gets a button that opens a native
// calendar; without one — or if their WhatsApp can't open it — typing the
// dates works exactly as before.
function datesPrompt(intro) {
  const typed = `${intro} When would you like to check in and check out? You can say it naturally, like "next Friday to Sunday" or "July 1st to July 5th".`;
  const flowId = process.env.WHATSAPP_DATES_FLOW_ID;
  if (!flowId) return typed;
  return {
    type: 'flow',
    body: `${intro} When would you like to stay?\n\nTap below to pick your dates on a calendar, or just type them (like "next Friday to Sunday").`,
    button: 'Choose dates',
    flowId,
    flowToken: 'stay-dates',
    screen: 'DATES',
    data: { min_date: todayIso() },
    draft: process.env.WHATSAPP_FLOW_MODE === 'draft',
    // Sent instead if WhatsApp rejects the Flow message.
    fallbackText: typed,
  };
}

function handleStep1(session, text) {
  const S = session.state;
  const dest = text.trim().replace(/[.!?,]+$/, '');
  if (dest.length >= 2) {
    const matched = matchDestination(dest);
    const finalDest = matched ?? DEFAULT_DESTINATION;
    S.destination = finalDest;
    S.step = 2;
    if (!matched) {
      return datesPrompt(`We don't currently have hotels in "${dest}" — showing available options in ${DEFAULT_DESTINATION} instead.`);
    }
    return datesPrompt(`Got it — ${finalDest}!`);
  }
  return 'Could you tell me which city or country you\'d like to stay in?';
}

function handleStep2(session, text) {
  const S = session.state;

  // Dates picked on the calendar. The client isn't trusted: the range is
  // re-validated here, and a bad one just re-opens the calendar.
  const picked = parseFlowDatesText(text);
  if (picked) {
    const problem = validateStay(picked);
    if (problem) return datesPrompt(problem);
    S.checkin = picked.start;
    S.checkout = picked.end;
    S.step = 3;
    return guestCountPrompt(`Check-in ${picked.start}, check-out ${picked.end} — got it!`);
  }

  const { checkin, checkout } = extractDates(text);
  if (checkin && checkout) {
    S.checkin = checkin;
    S.checkout = checkout;
    S.step = 3;
    return guestCountPrompt(`Check-in ${checkin}, check-out ${checkout} — got it!`);
  }
  return `Sorry, I couldn't quite catch those dates from "${text}". Try something like "next Friday to Sunday" or "July 1st to July 5th".`;
}

function handleStep3(session, text) {
  const S = session.state;
  const count = extractGuestCount(text);
  if (count > 0) {
    S.numGuests = count;
    S.step = 4;
    return null; // trigger hotel search
  }
  return guestCountPrompt();
}

async function handleStep4(session, text) {
  const S = session.state;
  const num = parseInt(text.trim());
  if (!isNaN(num) && num >= 1 && num <= S.hotels.length) {
    S.selectedHotel = S.hotels[num - 1];
    S.selected = null;
    S.step = 5;
    return null;
  }
  const lower = text.toLowerCase();
  const nameMatch = S.hotels.find((h) => (h.name ?? '').toLowerCase().includes(lower));
  if (nameMatch) {
    S.selectedHotel = nameMatch;
    S.selected = null;
    S.step = 5;
    return null;
  }
  const index = extractSelection(text, S.hotels.length);
  if (index) {
    S.selectedHotel = S.hotels[index - 1];
    S.selected = null;
    S.step = 5;
    return null;
  }
  const list = S.hotels.map((h, i) => `${i + 1}. ${h.name ?? 'Hotel'}`).join(', ');
  return `Sorry, I couldn't match "${text}" to a hotel. Options: ${list}. Please reply with a number.`;
}

async function handleStep5(session, text) {
  const S = session.state;
  const num = parseInt(text.trim());
  if (!isNaN(num) && num >= 1 && num <= S.products.length) {
    S.selected = S.products[num - 1];
    S.step = 6;
    const prompt = promptForContact(S);
    if (prompt) return prompt;
    S.step = 7;
    return null;
  }
  const lower = text.toLowerCase();
  const nameMatch = S.products.find((p) => (p.name ?? p.title ?? '').toLowerCase().includes(lower));
  if (nameMatch) {
    S.selected = nameMatch;
    S.step = 6;
    const prompt = promptForContact(S);
    if (prompt) return prompt;
    S.step = 7;
    return null;
  }
  const index = extractSelection(text, S.products.length);
  if (index) {
    S.selected = S.products[index - 1];
    S.step = 6;
    const prompt = promptForContact(S);
    if (prompt) return prompt;
    S.step = 7;
    return null;
  }
  const list = S.products.map((r, i) => `${i + 1}. ${r.name ?? r.title ?? 'Room'}`).join(', ');
  return `Sorry, I couldn't match "${text}" to a room. Options: ${list}. Please reply with a number.`;
}

function handleStep6(session, text) {
  const S = session.state;
  const guest = extractGuestDetails(text, S.guest);
  if (guest.name) S.guest.name = guest.name;
  if (guest.email) S.guest.email = guest.email;
  if (guest.phone) S.guest.phone = guest.phone;

  if (isContactComplete(S)) {
    S.step = 7;
    return null;
  }

  const missing = getMissingContact(S);
  if (missing.length === 1) {
    return `Thanks! I still need your ${missing[0]} to complete the booking.`;
  }
  return `Thanks! I still need your ${missing.join(', ')} to complete the booking. Please send your full name, email, and phone number.`;
}

// ─── API actions — each pushes its own reply text(s) onto outbox ──────

async function doSearchHotels(session, outbox) {
  const S = session.state;
  try {
    const hotels = await searchHotels({
      destination: S.destination,
      check_in: S.checkin,
      check_out: S.checkout,
      guests: S.numGuests,
    });
    S.hotels = hotels;
    if (!hotels.length) {
      S.checkin = '';
      S.checkout = '';
      S.step = 2;
      outbox.push(`No hotels available in "${S.destination}" for those dates. Could you try different dates?`);
      return;
    }
    if (hotels.length > MAX_LIST_ROWS) {
      // Too many results for a WhatsApp List Message (max 10 rows) — fall
      // back to the plain numbered text format instead of sending an
      // invalid/truncated interactive payload.
      const list = hotels.map((h, i) => `${i + 1}. ${h.name ?? 'Hotel'}${h.price_per_night ? ` — $${h.price_per_night}/night` : ''}`).join('\n');
      outbox.push(`Found ${hotels.length} hotels in ${S.destination}:\n${list}\n\nReply with a number to select.`);
    } else {
      outbox.push({
        type: 'list',
        body: `Found ${hotels.length} hotel${hotels.length > 1 ? 's' : ''} in ${S.destination}`,
        button: 'View hotels',
        rows: hotels.map((h, i) => ({
          id: String(i + 1),
          title: truncate(h.name ?? 'Hotel', 24),
          description: h.price_per_night ? `$${h.price_per_night}/night` : undefined,
        })),
      });
    }
  } catch (e) {
    console.error('doSearchHotels error:', e);
    S.step = 5;
    outbox.push(`⚠ Hotel search failed: ${e.message}. Want to try again or change your search?`);
  }
}

async function doFetchRooms(session, outbox) {
  const S = session.state;
  if (!S.selectedHotel) return;
  S.selected = null;
  try {
    const rooms = await getHotelDetails(S.selectedHotel.id ?? S.selectedHotel.hotel_id);
    S.products = rooms;
    if (!rooms.length) {
      S.step = 4;
      outbox.push('No rooms available for this hotel. Please pick a different hotel.');
      return;
    }
    if (rooms.length > MAX_LIST_ROWS) {
      const list = rooms.map((r, i) => `${i + 1}. ${r.name ?? r.title ?? 'Room'}`).join('\n');
      outbox.push(`Room types:\n${list}\n\nReply with a number to select.`);
    } else {
      outbox.push({
        type: 'list',
        body: 'Room types available',
        button: 'View rooms',
        rows: rooms.map((r, i) => ({
          id: String(i + 1),
          title: truncate(r.name ?? r.title ?? 'Room', 24),
          description: r.price_per_night ? `$${r.price_per_night}/night` : undefined,
        })),
      });
    }
  } catch (e) {
    outbox.push(`⚠ Could not load rooms: ${e.message}`);
    S.step = 5;
  }
}

function nightsBetween(checkin, checkout) {
  return Math.round((new Date(checkout).getTime() - new Date(checkin).getTime()) / 86400000);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function payNowPrompt(body, url) {
  return { type: 'cta', body, button: 'Pay now', url };
}

/**
 * Holds the room with the MCP, then sends the guest a Stripe Checkout link.
 * The booking is deliberately NOT completed here — completeAfterPayment()
 * does that once Stripe confirms the guest actually paid.
 */
async function doBooking(session, outbox, ctx = {}) {
  const S = session.state;
  if (!S.selectedHotel || !S.selected) return;
  try {
    if (!ctx.store || !ctx.baseUrl || !ctx.from) {
      throw new Error('payment is not configured');
    }

    const bookingSession = await createBookingSession({
      hotel_id: S.selectedHotel.id,
      room_id: S.selected.id ?? S.selected.room_id,
      check_in: S.checkin,
      check_out: S.checkout,
      guests: S.numGuests,
    });
    const sessionId = bookingSession.id ?? bookingSession.session_id;
    if (!sessionId) throw new Error('No session ID from API: ' + JSON.stringify(bookingSession).slice(0, 200));
    S.sessionId = sessionId;
    // The MCP ignores this value today, but complete_booking is still called
    // with it so the call shape stays valid if the MCP starts checking it.
    S.paymentToken = 'success_token';

    // totals[].amount from create_booking_session is in cents, same as
    // complete_booking's order.total (e.g. amount: 87136 === $871.36). It's
    // also exactly what Stripe wants for unit_amount, so no conversion.
    const totalCents = bookingSession.totals?.find((t) => t.type === 'total')?.amount;
    if (typeof totalCents !== 'number') throw new Error('the hotel did not return a total for this stay');
    const currency = bookingSession.currency ?? 'USD';
    const nights = nightsBetween(S.checkin, S.checkout);
    const hotelName = S.selectedHotel?.name;
    const roomName = S.selected?.name ?? S.selected?.title;

    const checkout = await createCheckoutSession({
      amountCents: totalCents,
      currency,
      description: `${hotelName} — ${roomName} (${plural(nights, 'night')})`,
      phone: ctx.from,
      mcpSessionId: sessionId,
      baseUrl: ctx.baseUrl,
    });

    await ctx.store.setPayment(checkout.id, {
      phone: ctx.from,
      phoneNumberId: ctx.phoneNumberId,
      mcpSessionId: sessionId,
      paymentToken: S.paymentToken,
      hotel: hotelName,
      room: roomName,
      nights,
      totalCents,
      currency,
    });

    S.stripeSessionId = checkout.id;
    S.paymentUrl = checkout.url;
    S.paymentTotal = `${currency} ${(totalCents / 100).toFixed(2)}`;

    // The guest's "card on file" for one-tap payment. If it can't be set up,
    // the Checkout link alone still works — payment is never blocked on it.
    S.savedCard = null;
    try {
      S.savedCard = describeSavedCard(await ensureSavedCard(ctx.from, ctx.store));
    } catch (e) {
      console.error('saved card unavailable, offering Checkout only:', e);
    }

    S.step = 7; // awaiting payment
    outbox.push(S.savedCard ? paymentChoicePrompt(S) : checkoutPrompt(S, true));
  } catch (e) {
    console.error('doBooking error:', e);
    // Back to the contact step: contact details are already complete, so
    // the guest's next message of any kind retries the hold + payment.
    S.step = 6;
    outbox.push(`⚠ Could not start payment: ${e.message}. Send any message to try again.`);
  }
}

/**
 * Finishes a paid booking and returns the confirmation text. Called by
 * api/payment-success.js once Stripe has confirmed payment — there's no
 * WhatsApp message or guest session in hand at that point, so it works
 * from the saved payment record instead.
 */
async function completeAfterPayment(record) {
  const completed = await completeBooking({ session_id: record.mcpSessionId, payment_token: record.paymentToken });
  const orderId = completed.order?.id;
  const currency = completed.order?.currency ?? record.currency ?? 'USD';
  const totalCents = completed.order?.total ?? record.totalCents;
  const total = typeof totalCents === 'number' ? (totalCents / 100).toFixed(2) : null;
  // The external MCP generates its own order ID with its own prefix (e.g.
  // "BK-16CE0B0C") — normalize whatever prefix it uses to "KV-" so the
  // guest always sees our own reference format, regardless of what the
  // upstream provider returns.
  const finalRef = orderId
    ? `KV-${orderId.replace(/^[A-Za-z]+-/, '')}`
    : `KV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  return `✅ Payment received — booking confirmed!\n\nOrder ID: ${finalRef}\nHotel: ${record.hotel}\nRoom: ${record.room}\n${plural(record.nights, 'night')}\nTotal: ${currency} ${total}\n\nThanks for booking with us — see you soon!`;
}

// ─── payment choice (step 7) ──────────────────────────────────

function describeSavedCard(saved) {
  const brand = saved.brand.charAt(0).toUpperCase() + saved.brand.slice(1);
  const label = `Pay ${brand} ••${saved.last4}`;
  return {
    text: `${brand} ending ${saved.last4}`,
    // WhatsApp reply-button titles are capped at 20 characters.
    label: label.length <= 20 ? label : `Pay card ••${saved.last4}`,
  };
}

function paymentChoicePrompt(S) {
  return {
    type: 'button',
    body: `Room held! Total: ${S.paymentTotal}.\n\nPay with the saved ${S.savedCard.text}? Demo: test card on file.`,
    buttons: [
      { id: 'pay_saved', title: S.savedCard.label },
      { id: 'pay_other', title: 'Use another card' },
    ],
  };
}

// The Stripe Checkout link — the fallback for "use another card", and the
// only option if no saved card could be set up. The hosted page also offers
// Apple Pay / Google Pay / Link.
function checkoutPrompt(S, firstOffer = false) {
  const body = firstOffer
    ? `Room held! Total: ${S.paymentTotal}.\n\nTap below to pay securely. Demo mode — use test card 4242 4242 4242 4242, any future expiry, any CVC.`
    : "No problem — tap below to pay on Stripe's secure page, where Apple Pay, Google Pay and cards are accepted. Demo: use test card 4242 4242 4242 4242, any future expiry, any CVC.";
  return payNowPrompt(body, S.paymentUrl);
}

/**
 * Charges the saved card and finishes the booking, all inside the chat.
 * Pushes its own replies onto `outbox`. Three safeguards against paying
 * twice or paying for nothing: one exactly-once guard shared with the
 * Checkout path, a per-booking idempotency key on the charge, and an
 * automatic refund if the booking can't be completed after the money is
 * taken.
 */
async function payWithSavedCard(session, ctx, outbox) {
  const S = session.state;
  const store = ctx.store;

  const record = await store.getPayment(S.stripeSessionId);
  if (!record) {
    outbox.push('That payment session has expired. Send "clear" to start a new booking.');
    return;
  }

  const claimed = await store.markPaymentCompleted(record.mcpSessionId);
  if (!claimed) {
    outbox.push('Your payment is already being processed.');
    return;
  }

  let intent;
  try {
    const saved = await store.getSavedCard(record.phone);
    if (!saved) throw new Error('no saved card on file');
    intent = await chargeSavedCard({
      saved,
      amountCents: record.totalCents,
      currency: record.currency,
      description: `${record.hotel} — ${record.room} (${plural(record.nights, 'night')})`,
      phone: record.phone,
      mcpSessionId: record.mcpSessionId,
    });
    if (intent.status !== 'succeeded') throw new Error(`card not charged (${intent.status})`);
  } catch (e) {
    console.error('saved-card charge failed:', e);
    await store.releasePaymentClaim(record.mcpSessionId);
    outbox.push("We couldn't charge your saved card. You can pay with another card instead.");
    outbox.push(checkoutPrompt(S));
    return;
  }

  let confirmation;
  try {
    confirmation = await completeAfterPayment(record);
  } catch (e) {
    console.error('booking failed after charge — refunding:', e);
    await refundPayment(intent.id).catch((err) => console.error('REFUND FAILED — needs manual refund:', intent.id, err));
    await store.releasePaymentClaim(record.mcpSessionId);
    S.step = 6; // contact details are complete, so the next message retries
    outbox.push("Your card was charged, but we couldn't finish the booking, so the payment has been refunded. Send any message to try again.");
    return;
  }

  // Paid in chat — the Checkout link must not be payable any more.
  await expireCheckoutSession(S.stripeSessionId).catch(() => {});
  S.step = 8; // booking confirmed
  outbox.push(confirmation);
}

// A guest at step 7 either taps one of the two payment buttons or types
// something, in which case the choice is simply shown again. Step 8 is a
// finished booking.
async function handleAwaitingPayment(session, text, ctx, outbox) {
  const S = session.state;
  if (!S.stripeSessionId || !S.paymentUrl) {
    return 'Something went wrong with your payment. Send "clear" to start over.';
  }
  if (text === 'pay_other') return checkoutPrompt(S);
  if (text === 'pay_saved' && S.savedCard) {
    await payWithSavedCard(session, ctx, outbox);
    return null;
  }
  return S.savedCard ? paymentChoicePrompt(S) : checkoutPrompt(S, true);
}

// ─── main dispatch — one incoming WhatsApp message in, array of replies out ──

/**
 * @param {ReturnType<typeof createSession>} session
 * @param {string} text
 * @param {{ from?: string, phoneNumberId?: string, baseUrl?: string, store?: object }} [ctx]
 *        who is chatting and where payment should return to; only the
 *        payment step needs it
 * @returns {Promise<Array<string|object>>} messages to send back to WhatsApp, in order
 */
async function dispatch(session, text, ctx = {}) {
  const S = session.state;
  const outbox = [];

  try {
    // A calendar reply from an old message must not be parsed as, say, a guest
    // count (its digits would be). Only the dates step can use it.
    if (typeof text === 'string' && text.startsWith(FLOW_DATES_PREFIX) && S.step !== 2) {
      outbox.push('Thanks — I can\'t use those dates at this point in the booking. Send "clear" to start over if you want to change something.');
      return outbox;
    }

    let reply = null;
    let action = null;

    const step = S.step;
    if      (step === 1) { reply = handleStep1(session, text); }
    else if (step === 2) { reply = handleStep2(session, text); }
    else if (step === 3) { reply = handleStep3(session, text); if (S.step === 4) action = 'search_hotels'; }
    else if (step === 4) { reply = await handleStep4(session, text); if (S.step === 5) action = 'fetch_rooms'; }
    else if (step === 5) { reply = await handleStep5(session, text); if (S.step === 7) action = 'booking'; }
    else if (step === 6) { reply = handleStep6(session, text); if (S.step === 7) action = 'booking'; }
    else if (step === 7) { reply = await handleAwaitingPayment(session, text, ctx, outbox); }
    else if (step === 8) { reply = 'Your booking is confirmed. Send "clear" to start a new one.'; }
    else                 { reply = "I'm not sure what you mean — let's start over. Where would you like to stay?"; }

    if (reply) outbox.push(reply);

    if (action === 'search_hotels') await doSearchHotels(session, outbox);
    if (action === 'fetch_rooms')   await doFetchRooms(session, outbox);
    if (action === 'booking')       await doBooking(session, outbox, ctx);
  } catch (e) {
    console.error(e);
    outbox.push(`⚠ ${e.message}`);
  }

  return outbox;
}

module.exports = { createSession, greet, dispatch, completeAfterPayment };
