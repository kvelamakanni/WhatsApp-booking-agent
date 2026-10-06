// Same 7-step booking state machine shape as the local App's bookingAgent.js
// (itself ported from ai-booking's useBookingFlow.ts), but with every LLM
// call replaced by rule-based extraction (lib/extract.js) and static
// template replies instead of ai()-generated text. No LLM/Ollama dependency.

const { extractDates, extractSelection, extractGuestCount, extractGuestDetails } = require('./extract');
const { searchHotels, getHotelDetails, createBookingSession, completeBooking } = require('./mcp');
const { createCheckoutSession } = require('./stripe');

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

function handleStep1(session, text) {
  const S = session.state;
  const dest = text.trim().replace(/[.!?,]+$/, '');
  if (dest.length >= 2) {
    const matched = matchDestination(dest);
    const finalDest = matched ?? DEFAULT_DESTINATION;
    S.destination = finalDest;
    S.step = 2;
    if (!matched) {
      return `We don't currently have hotels in "${dest}" — showing available options in ${DEFAULT_DESTINATION} instead. When would you like to check in and check out? You can say it naturally, like "next Friday to Sunday" or "July 1st to July 5th".`;
    }
    return `Got it — ${finalDest}! When would you like to check in and check out? You can say it naturally, like "next Friday to Sunday" or "July 1st to July 5th".`;
  }
  return 'Could you tell me which city or country you\'d like to stay in?';
}

function handleStep2(session, text) {
  const S = session.state;
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
    if (!ctx.savePayment || !ctx.baseUrl || !ctx.from) {
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

    await ctx.savePayment(checkout.id, {
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
    S.step = 7; // awaiting payment
    outbox.push(
      payNowPrompt(
        `Room held! Total: ${currency} ${(totalCents / 100).toFixed(2)}.\n\nTap below to pay securely. Demo mode — use test card 4242 4242 4242 4242, any future expiry, any CVC.`,
        checkout.url,
      ),
    );
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

// A guest who types while their room is held (step 7) just gets the Pay now
// button again; step 8 is a finished booking.
function handleAwaitingPayment(session) {
  const S = session.state;
  if (!S.paymentUrl) return 'Something went wrong with your payment link. Send "clear" to start over.';
  return payNowPrompt('Your room is held — just waiting on payment. Tap below to pay.', S.paymentUrl);
}

// ─── main dispatch — one incoming WhatsApp message in, array of replies out ──

/**
 * @param {ReturnType<typeof createSession>} session
 * @param {string} text
 * @param {{ from?: string, phoneNumberId?: string, baseUrl?: string, savePayment?: Function }} [ctx]
 *        who is chatting and where payment should return to; only the
 *        payment step needs it
 * @returns {Promise<Array<string|object>>} messages to send back to WhatsApp, in order
 */
async function dispatch(session, text, ctx = {}) {
  const S = session.state;
  const outbox = [];

  try {
    let reply = null;
    let action = null;

    const step = S.step;
    if      (step === 1) { reply = handleStep1(session, text); }
    else if (step === 2) { reply = handleStep2(session, text); }
    else if (step === 3) { reply = handleStep3(session, text); if (S.step === 4) action = 'search_hotels'; }
    else if (step === 4) { reply = await handleStep4(session, text); if (S.step === 5) action = 'fetch_rooms'; }
    else if (step === 5) { reply = await handleStep5(session, text); if (S.step === 7) action = 'booking'; }
    else if (step === 6) { reply = handleStep6(session, text); if (S.step === 7) action = 'booking'; }
    else if (step === 7) { reply = handleAwaitingPayment(session); }
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
