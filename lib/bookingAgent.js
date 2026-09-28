// Same 7-step booking state machine shape as the local App's bookingAgent.js
// (itself ported from ai-booking's useBookingFlow.ts), but with every LLM
// call replaced by rule-based extraction (lib/extract.js) and static
// template replies instead of ai()-generated text. No LLM/Ollama dependency.

const { extractDates, extractSelection, extractGuestCount, extractGuestDetails } = require('./extract');
const { searchHotels, getHotelDetails, createBookingSession, completeBooking } = require('./mcp');

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
  const list = SUPPORTED_DESTINATIONS_LIST.join('\n');
  return `Hi! I'm your Hotels booking assistant. We currently have hotels in:\n${list}\n\nWhere would you like to stay?`;
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
    return `Check-in ${checkin}, check-out ${checkout} — got it! How many guests will be staying?`;
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
  return 'How many guests will be staying? (just the number, e.g. "2")';
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
    const list = hotels.map((h, i) => `${i + 1}. ${h.name ?? 'Hotel'}${h.price_per_night ? ` — $${h.price_per_night}/night` : ''}`).join('\n');
    outbox.push(`Found ${hotels.length} hotels in ${S.destination}:\n${list}\n\nReply with a number to select.`);
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
    const list = rooms.map((r, i) => `${i + 1}. ${r.name ?? r.title ?? 'Room'}`).join('\n');
    outbox.push(`Room types:\n${list}\n\nReply with a number to select.`);
  } catch (e) {
    outbox.push(`⚠ Could not load rooms: ${e.message}`);
    S.step = 5;
  }
}

async function doBooking(session, outbox) {
  const S = session.state;
  if (!S.selectedHotel || !S.selected) return;
  try {
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
    S.paymentToken = 'success_token';

    // totals[].amount from create_booking_session is in cents, same as
    // complete_booking's order.total (e.g. amount: 87136 === $871.36).
    const totalCents = bookingSession.totals?.find((t) => t.type === 'total')?.amount;
    const totalDisplay = typeof totalCents === 'number' ? (totalCents / 100).toFixed(2) : totalCents;
    outbox.push(`Room held! ${totalDisplay ? `Total: USD ${totalDisplay}. ` : ''}Processing your payment...`);

    await doCompleteBooking(session, outbox);
  } catch (e) {
    outbox.push(`⚠ Could not create booking session: ${e.message}`);
    S.step = 7;
  }
}

async function doCompleteBooking(session, outbox) {
  const S = session.state;
  if (!S.sessionId) return;
  const nights = Math.round((new Date(S.checkout).getTime() - new Date(S.checkin).getTime()) / 86400000);
  try {
    const completed = await completeBooking({ session_id: S.sessionId, payment_token: S.paymentToken });
    const orderId = completed.order?.id;
    const currency = completed.order?.currency ?? 'USD';
    const totalCents = completed.order?.total;
    const total = totalCents ? (totalCents / 100).toFixed(2) : null;
    // The external MCP generates its own order ID with its own prefix (e.g.
    // "BK-16CE0B0C") — normalize whatever prefix it uses to "KV-" so the
    // guest always sees our own reference format, regardless of what the
    // upstream provider returns.
    const finalRef = orderId
      ? `KV-${orderId.replace(/^[A-Za-z]+-/, '')}`
      : `KV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    S.step = 7;
    outbox.push(`✅ Booking confirmed! Order ID: ${finalRef}\nHotel: ${S.selectedHotel?.name}\nRoom: ${S.selected?.name ?? S.selected?.title}\n${nights} nights\nTotal: ${currency} ${total}\n\nThanks for booking with us — see you soon!`);
  } catch (e) {
    outbox.push(`⚠ Payment failed: ${e.message}`);
  }
}

// ─── main dispatch — one incoming WhatsApp message in, array of replies out ──

/**
 * @param {ReturnType<typeof createSession>} session
 * @param {string} text
 * @returns {Promise<string[]>} messages to send back to WhatsApp, in order
 */
async function dispatch(session, text) {
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
    else                 { reply = "I'm not sure what you mean — let's start over. Where would you like to stay?"; }

    if (reply) outbox.push(reply);

    if (action === 'search_hotels') await doSearchHotels(session, outbox);
    if (action === 'fetch_rooms')   await doFetchRooms(session, outbox);
    if (action === 'booking')       await doBooking(session, outbox);
  } catch (e) {
    console.error(e);
    outbox.push(`⚠ ${e.message}`);
  }

  return outbox;
}

module.exports = { createSession, greet, dispatch };
