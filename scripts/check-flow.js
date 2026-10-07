#!/usr/bin/env node
// Shows what Meta says about your calendar Flow and WhatsApp Business Account,
// e.g. to find out why sending the Flow fails with "(#139000) Blocked by Integrity".
//
//   WHATSAPP_ACCESS_TOKEN=<token> node scripts/check-flow.js <FLOW_ID>
//
// Read-only: it only does GET requests. The token comes from your own shell
// and is never printed. Some fields may be rejected for your account — each
// request is shown on its own, so one failure doesn't hide the others.

const GRAPH = 'https://graph.facebook.com/v21.0';
const DEFAULT_WABA_ID = '1819351045911420';

async function main({ fetchFn = fetch, env = process.env, log = console.log, argv = process.argv.slice(2) } = {}) {
  const token = env.WHATSAPP_ACCESS_TOKEN;
  const flowId = argv[0] || env.WHATSAPP_DATES_FLOW_ID;
  if (!token || !flowId) {
    log('Usage: WHATSAPP_ACCESS_TOKEN=<token> node scripts/check-flow.js <FLOW_ID>');
    return { ok: false };
  }
  const wabaId = env.WABA_ID || DEFAULT_WABA_ID;

  const get = async (label, path) => {
    log(`\n--- ${label}\nGET ${path}`);
    try {
      const res = await fetchFn(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      log(`HTTP ${res.status}\n${JSON.stringify(data, null, 2)}`);
      return { ok: res.ok, data };
    } catch (e) {
      log(`Request failed: ${e.message}`);
      return { ok: false };
    }
  };

  await get('The Flow (status, validation errors, health)', `/${flowId}?fields=id,name,status,categories,validation_errors,health_status,json_version`);
  await get('The WhatsApp Business Account (verification / review state)', `/${wabaId}?fields=id,name,business_verification_status,account_review_status`);
  await get('All Flows in the account', `/${wabaId}/flows?fields=id,name,status`);
  log('\nIf the Flow is a DRAFT with no validation errors but sending still fails with 139000,');
  log('the block is on the account (often business verification) — see Business Settings > Security Center,');
  log('or contact WhatsApp/Meta Business Support quoting error 139000.');
  return { ok: true };
}

if (require.main === module) {
  main().then((r) => process.exit(r.ok ? 0 : 1)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main };
