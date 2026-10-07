#!/usr/bin/env node
// Creates the "stay dates" calendar Flow (flows/stay-dates.json) in your
// WhatsApp Business Account through the Graph API, and prints its Flow ID.
//
//   WHATSAPP_ACCESS_TOKEN=<token> node scripts/create-flow.js            # create as a DRAFT
//   WHATSAPP_ACCESS_TOKEN=<token> node scripts/create-flow.js --publish  # create and publish
//
// The token needs the whatsapp_business_management permission (a System User
// token is best; the temporary one from API Setup also works for ~24h).
// It is read from your own shell environment and never printed.
//
// Optional: WABA_ID (defaults to the account in your webhook payloads),
// FLOW_JSON_VERSION (overrides the "version" in the JSON if Meta rejects it).

const fs = require('fs');
const path = require('path');

const GRAPH = 'https://graph.facebook.com/v21.0';
const DEFAULT_WABA_ID = '1819351045911420';

async function main({ fetchFn = fetch, env = process.env, log = console.log, argv = process.argv.slice(2) } = {}) {
  const token = env.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    log('Set WHATSAPP_ACCESS_TOKEN first, e.g.:\n  WHATSAPP_ACCESS_TOKEN=... node scripts/create-flow.js');
    return { ok: false };
  }

  const wabaId = env.WABA_ID || DEFAULT_WABA_ID;
  const flow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flows', 'stay-dates.json'), 'utf8'));
  if (env.FLOW_JSON_VERSION) flow.version = env.FLOW_JSON_VERSION;

  const call = async (url, body) => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  };

  log(`Creating Flow in WhatsApp Business Account ${wabaId} (Flow JSON version ${flow.version})...`);
  const created = await call(`${GRAPH}/${wabaId}/flows`, {
    name: `Hotel stay dates ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    categories: ['OTHER'],
    flow_json: JSON.stringify(flow),
  });

  if (!created.ok || !created.data.id) {
    log(`Meta rejected the request (HTTP ${created.status}):\n${JSON.stringify(created.data, null, 2)}`);
    return { ok: false };
  }

  const flowId = created.data.id;
  const errors = created.data.validation_errors ?? [];
  log(`Created Flow ${flowId}.`);
  if (errors.length) {
    log(`Meta reported ${errors.length} validation problem(s) with the Flow JSON:`);
    for (const e of errors) log(`  - ${e.error}: ${e.message}`);
    log('\nFix flows/stay-dates.json (or try FLOW_JSON_VERSION=...) and run again.');
    return { ok: false, flowId, errors };
  }
  log('Flow JSON passed Meta\'s validation.');

  let published = false;
  if (argv.includes('--publish')) {
    const pub = await call(`${GRAPH}/${flowId}/publish`, {});
    if (!pub.ok) {
      log(`Publish failed (HTTP ${pub.status}): ${JSON.stringify(pub.data)}`);
      return { ok: false, flowId };
    }
    published = true;
    log('Published.');
  }

  log('\nNext, in Vercel -> Settings -> Environment Variables (Production):');
  log(`  WHATSAPP_DATES_FLOW_ID = ${flowId}`);
  if (!published) log('  WHATSAPP_FLOW_MODE     = draft     (this Flow is a draft, so it must be sent in draft mode)');
  log('then redeploy. Unset WHATSAPP_DATES_FLOW_ID at any time to go back to typed dates.');
  return { ok: true, flowId, published };
}

if (require.main === module) {
  main().then((r) => process.exit(r.ok ? 0 : 1)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main };
