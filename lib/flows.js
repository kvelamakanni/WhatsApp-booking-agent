// Helpers for the WhatsApp Flow calendar (flows/stay-dates.json).
//
// A guest who submits the calendar arrives at our webhook as an interactive
// "nfm_reply" whose response_json is a JSON *string*. We turn it into a
// small text token (`flow_dates:START,END`) so it can travel through the
// same dispatch() path as any typed or tapped answer.

const FLOW_DATES_PREFIX = 'flow_dates:';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NIGHTS = 30;

// "Today" has to be in the hotel's time zone: the server runs in UTC, so on a
// US evening its date is already tomorrow and would wrongly block today.
function todayIso(now = new Date()) {
  const tz = process.env.HOTEL_TIMEZONE || 'America/New_York';
  return now.toLocaleDateString('en-CA', { timeZone: tz });
}

function daysBetween(startIso, endIso) {
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const [ey, em, ed] = endIso.split('-').map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000);
}

function isRealDate(iso) {
  if (!ISO.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// The exact response shape of a range calendar isn't documented, so rather
// than hardcode one nesting, collect every YYYY-MM-DD value in the payload
// and pick start/end by key name, falling back to the order they appear in.
function collectDates(value, key, out) {
  if (typeof value === 'string') {
    if (ISO.test(value)) out.push({ key, value });
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectDates(v, key, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectDates(v, k, out);
  }
  return out;
}

function extractDateRange(data) {
  const found = collectDates(data, '', []);
  if (found.length < 2) return null;
  const start = found.find((f) => /start|check.?in|from/i.test(f.key)) ?? found[0];
  const end = found.find((f) => f !== start && /^end|check.?out|(^|[^a-z])to($|[^a-z])/i.test(f.key)) ?? found.find((f) => f !== start);
  return end ? { start: start.value, end: end.value } : null;
}

/** nfm_reply -> "flow_dates:START,END", or undefined if it carries no date range. */
function flowReplyToText(nfmReply) {
  let data;
  try {
    data = JSON.parse(nfmReply?.response_json ?? '{}');
  } catch {
    return undefined;
  }
  const range = extractDateRange(data);
  return range ? `${FLOW_DATES_PREFIX}${range.start},${range.end}` : undefined;
}

/** "flow_dates:START,END" -> { start, end }, or null if it isn't that token. */
function parseFlowDatesText(text) {
  if (typeof text !== 'string' || !text.startsWith(FLOW_DATES_PREFIX)) return null;
  const [start, end] = text.slice(FLOW_DATES_PREFIX.length).split(',');
  return isRealDate(start) && isRealDate(end) ? { start, end } : null;
}

/** Returns a guest-facing problem description, or null when the stay is bookable. */
function validateStay({ start, end }, now = new Date()) {
  if (start < todayIso(now)) return "Check-in can't be in the past.";
  if (end <= start) return 'Check-out must be after check-in.';
  if (daysBetween(start, end) > MAX_NIGHTS) return `Stays can be ${MAX_NIGHTS} nights at most.`;
  return null;
}

module.exports = {
  FLOW_DATES_PREFIX,
  todayIso,
  flowReplyToText,
  parseFlowDatesText,
  validateStay,
};
