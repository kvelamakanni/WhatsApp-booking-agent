// Direct HTTPS calls to Devara Hotels MCP — no proxy hop.
//
// This ports the JSON-RPC wrapping logic straight out of ai-booking's
// server/proxy.cjs (its POST /mcp/call route, lines 97-134), which is a
// pure pass-through to https://devara-hotel-site.vercel.app/api/mcp with no
// dependency on Ollama/Whisper/Piper whatsoever. Calling it directly means
// this app needs no local AI backend at all.

const MCP_URL = process.env.MCP_URL || 'https://devara-hotel-site.vercel.app/api/mcp';

async function mcpCall(tool, args) {
  const payload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: tool, arguments: args || {} },
  };

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  console.log('MCP', tool, '→', res.status, raw.slice(0, 400));

  if (!res.ok) throw new Error(`MCP ${res.status}: ${raw.slice(0, 120)}`);

  const d = JSON.parse(raw);
  if (d.error) throw new Error(`MCP error: ${JSON.stringify(d.error)}`);

  const content = d.result?.content;
  if (!content) throw new Error(`Empty MCP result for ${tool}`);

  const text = Array.isArray(content)
    ? content.map((c) => c.text ?? '').join('')
    : String(content);

  return JSON.parse(text);
}

async function searchHotels(params) {
  const data = await mcpCall('search_hotels', params);
  return Array.isArray(data) ? data : data.hotels ?? data.results ?? [];
}

async function getHotelDetails(hotelId) {
  const data = await mcpCall('get_hotel_details', { hotel_id: hotelId });
  return Array.isArray(data) ? data : data.rooms ?? data.room_types ?? data.products ?? [];
}

async function createBookingSession(params) {
  return mcpCall('create_booking_session', params);
}

async function completeBooking(params) {
  return mcpCall('complete_booking', params);
}

module.exports = { searchHotels, getHotelDetails, createBookingSession, completeBooking };
