// Rule-based replacements for ai-booking's LLM-backed extraction functions
// (src/services/extraction.ts). No LLM/Ollama dependency — dates go through
// chrono-node, everything else is regex/word matching (mostly already
// rule-based fast-paths in the original code; this file just drops the LLM
// fallback and returns a "couldn't tell, ask again" signal instead).

const chrono = require('chrono-node');

/** Extract check-in / check-out dates from natural text, e.g. "next Friday to Sunday". */
function extractDates(text) {
  const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
  const toISO = (d) => d.toISOString().split('T')[0];

  const results = chrono.parse(text, new Date(), { forwardDate: true });
  if (!results.length) return { checkin: '', checkout: '' };

  const first = results[0];
  const checkin = toISO(first.start.date());
  let checkout = first.end ? toISO(first.end.date()) : '';

  // A second separate date mention (no shared range), e.g. "June 20 and June 25"
  if (!checkout && results.length > 1) {
    checkout = toISO(results[1].start.date());
  }

  // chrono resolves "weekend" to a single Saturday with no end date — treat
  // it as a 1-night Saturday-to-Sunday stay.
  if (!checkout && /\bweekend\b/i.test(first.text)) {
    const nextDay = new Date(first.start.date());
    nextDay.setDate(nextDay.getDate() + 1);
    checkout = toISO(nextDay);
  }

  // chrono doesn't parse duration suffixes like "for 3 nights" — catch that
  // pattern separately and derive checkout from checkin + N nights.
  if (!checkout) {
    const nightsMatch = text.match(/(\d+)\s*nights?/i);
    if (nightsMatch) {
      const nights = parseInt(nightsMatch[1]);
      const derived = new Date(first.start.date());
      derived.setDate(derived.getDate() + nights);
      checkout = toISO(derived);
    }
  }

  if (!isValidDate(checkin) || (checkout && !isValidDate(checkout))) {
    return { checkin: '', checkout: '' };
  }
  return { checkin, checkout };
}

/** Extract a 1-based index selection from text like "2", "second", or a name substring handled by the caller. */
function extractSelection(text, max) {
  const words = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  };
  const lower = text.toLowerCase();
  const nums = text.match(/\d+/g)?.map(Number).filter((n) => n >= 1 && n <= max);
  if (nums?.length) return nums[0];
  for (const [word, val] of Object.entries(words)) {
    if (lower.includes(word) && val <= max) return val;
  }
  return 0;
}

/** Extract guest count from text like "2 adults", "two", "a couple". */
function extractGuestCount(text) {
  const words = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    to: 2, too: 2, for: 4,
    single: 1, couple: 2, pair: 2,
  };
  const lower = text.toLowerCase().trim();

  const nums = lower.match(/\d+/g)?.map(Number).filter((n) => n > 0);
  if (nums?.length) return nums[0];

  for (const [word, val] of Object.entries(words)) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(lower)) return val;
  }
  return 0;
}

/** Extract name/email/phone from a single free-text message, e.g. "John Doe, john@x.com, 555-1234". */
function extractGuestDetails(text, existing) {
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  const email = emailMatch ? emailMatch[0] : existing.email || '';

  const phoneMatch = text.match(/(\+?\d[\d\s\-().]{6,}\d)/);
  const phone = phoneMatch ? phoneMatch[0].replace(/[^\d+]/g, '') : existing.phone || '';

  // Whatever's left after stripping the matched email/phone is treated as the name,
  // if it looks like a plausible name (letters/spaces only, not just leftover punctuation).
  let remainder = text;
  if (emailMatch) remainder = remainder.replace(emailMatch[0], '');
  if (phoneMatch) remainder = remainder.replace(phoneMatch[0], '');
  remainder = remainder.replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim();

  // Guard against leftover filler ("my email is", "here's my number") being
  // mistaken for a name: require a plausible name shape (1-4 capitalized-ish
  // words, no common filler words) before overwriting whatever name we
  // already have on file.
  const FILLER_WORDS = /\b(email|phone|number|mobile|contact|is|my|here|this|the|and|address)\b/i;
  const wordCount = remainder.split(/\s+/).filter(Boolean).length;
  const looksLikeName =
    remainder.length > 0 &&
    wordCount >= 1 && wordCount <= 4 &&
    /^[a-zA-Z][a-zA-Z\s.'-]*$/.test(remainder) &&
    !FILLER_WORDS.test(remainder);
  const name = looksLikeName ? remainder : existing.name || '';

  return { name, email, phone };
}

module.exports = { extractDates, extractSelection, extractGuestCount, extractGuestDetails };
