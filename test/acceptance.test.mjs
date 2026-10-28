import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import app from '../src/index.js';
import { tokenRisk, walletSummary, agentBrief, regimeOf, RPC } from '../src/core.js';
import { load, offer, EXAMPLES, ENV, ROUTES, replay, validateOffer } from './helpers.mjs';

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
const cap = id => offer.capabilities.find(c => c.skill_id === id);
const RUN = { 'token.risk': r => tokenRisk(r.chain, r.address, {}), 'wallet.summary': r => walletSummary(r.chain, r.address, {}), 'market.agent_brief': () => agentBrief({}) };
const noTs = o => { const { ts, ...rest } = o; return rest; };

test('A1 the offer passes the LAX registry validation with the Five Laws, on our own domain', () => {
  assert.deepEqual(validateOffer(offer), []);
  assert.equal(new URL(offer.endpoint).hostname, 'astra-x402-data.astratc.workers.dev');
  assert.match(validateOffer({ ...offer, endpoint: 'https://lax.kognai.ai/x' }).join(), /own domain/);
  assert.match(validateOffer({ ...offer, constitutional_constraints: offer.constitutional_constraints.slice(1) }).join(), /Solidarity Oath/);
  assert.match(validateOffer({ ...offer, capabilities: [] }).join(), /1 to 10/);
  assert.equal(offer.agent_did, 'did:web:astra-x402-data.astratc.workers.dev');
});

test('A2 each capability has an input schema, an output schema and a per call price that matches the live config', () => {
  assert.equal(offer.capabilities.length, 3);
  for (const c of offer.capabilities) {
    for (const k of ['input_schema', 'output_schema']) {
      assert.equal(c[k].type, 'object', `${c.skill_id} ${k}`);
      assert.ok(ajv.compile(c[k]), `${c.skill_id} ${k} compiles`);
    }
    assert.equal(c.pricing.model, 'per_call');
    const [, priceVar] = ROUTES[c.skill_id];
    assert.equal(Number(c.pricing.amount), Number(ENV[priceVar].replace('$', '')), `${c.skill_id} offer price equals ${priceVar}`);
    assert.ok(Number(c.pricing.amount) <= 1, 'Kognai pays at most 1 USDC per test call');
  }
  const input = ajv.compile(cap('token.risk').input_schema);
  assert.equal(input({ chain: 'base', address: '0x12' }), false);
  assert.equal(input({ chain: 'solana', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' }), false);
});

for (const name of EXAMPLES) {
  test(`A3 example ${name}: request and response match the schemas, and the agent gives the same answer from the recorded upstream data`, async () => {
    const ex = load(`examples/${name}.json`);
    const c = cap(ex.capability);
    assert.ok(c, `capability ${ex.capability} is in the offer`);
    const inV = ajv.compile(c.input_schema), outV = ajv.compile(c.output_schema);
    assert.ok(inV(ex.request), JSON.stringify(inV.errors));
    assert.ok(outV(ex.response), JSON.stringify(outV.errors));
    const restore = replay(load(`fixtures/${name}.tape.json`));
    try {
      const again = await RUN[ex.capability](ex.request);
      const strip = o => { const x = noTs(o); if (x.market) x.market = { ...x.market, oldest_pair_age_days: null }; return x; };
      assert.deepEqual(strip(again), strip(ex.response));
    } finally { restore(); }
  });
}
test('A3 there are at least three examples, one per capability', () => {
  assert.deepEqual(new Set(EXAMPLES.map(n => load(`examples/${n}.json`).capability)), new Set(offer.capabilities.map(c => c.skill_id)));
});

test('A4 the listing id is in the README and every paid route answers 402 with x402 terms in USDC on Base when unpaid, offline', async () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /lax-ext-87b6301d83cf/);
  assert.match(readme, /https:\/\/astra-x402-data\.astratc\.workers\.dev/);
  const real = globalThis.fetch; globalThis.fetch = async u => { throw new Error('network used: ' + u); };
  try {
    for (const c of offer.capabilities) {
      const [path, priceVar] = ROUTES[c.skill_id];
      const r = await app.request(path + '?chain=base&address=0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', {}, ENV);
      assert.equal(r.status, 402, path);
      const b = await r.json();
      assert.equal(b.x402Version, 1);
      const a = b.accepts[0];
      assert.equal(a.scheme, 'exact'); assert.equal(a.network, 'base');
      assert.equal(a.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
      assert.equal(a.payTo, ENV.PAY_TO);
      assert.equal(a.maxAmountRequired, String(Math.round(Number(c.pricing.amount) * 1e6)));
    }
    assert.equal((await app.request('/health', {}, ENV)).status, 200);
  } finally { globalThis.fetch = real; }
});

test('A5 three paid test calls by Kognai, one per example, answered well', { todo: 'done by Kognai at M2 against the live endpoint; the answers are the same code as A3' }, () => {});

test('A5 the scoring flags a honeypot as high risk with the flags behind the score', async () => {
  const addr = '0x000000000000000000000000000000000000dEaD';
  const gp = { code: 1, result: { [addr.toLowerCase()]: { is_honeypot: '1', cannot_sell_all: '1', sell_tax: '0.99', buy_tax: '0', is_open_source: '0', holders: [], token_name: 'Trap', token_symbol: 'TRAP' } } };
  const tape = [
    { url: `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${addr}`, body_sent: null, status: 200, body: JSON.stringify(gp) },
    { url: `https://api.dexscreener.com/latest/dex/tokens/${addr}`, body_sent: null, status: 200, body: JSON.stringify({ pairs: [] }) },
  ];
  let restore = replay(tape);
  try {
    const r = await tokenRisk('base', addr, {});
    assert.equal(r.risk_level, 'high'); assert.equal(r.risk_score, 100);
    for (const f of ['honeypot', 'cannot_sell_all', 'sell_tax_99.0pct', 'not_open_source', 'no_dex_pairs']) assert.ok(r.flags.includes(f), f);
    assert.ok(ajv.compile(cap('token.risk').output_schema)(r));
  } finally { restore(); }
});

test('A5 the market regime follows the market cap change and breadth', () => {
  assert.equal(regimeOf(3, 0.7), 'risk_on_strong');
  assert.equal(regimeOf(1, 0.6), 'risk_on');
  assert.equal(regimeOf(1, 0.45), 'neutral');
  assert.equal(regimeOf(-3, 0.3), 'risk_off_strong');
  assert.equal(regimeOf(-1, 0.4), 'risk_off');
  assert.equal(regimeOf(-1, 0.6), 'neutral');
});

test('A5 a wallet summary reads ETH with 18 decimals and USDC with 6, and grades activity', async () => {
  const addr = '0x1111111111111111111111111111111111111111';
  const url = RPC.base[0];
  const rpcAns = (method, result) => ({ url, status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }), method });
  const calls = [rpcAns('eth_getBalance', '0x1bc16d674ec80000'), rpcAns('eth_getTransactionCount', '0x2a'), rpcAns('eth_getCode', '0x'), rpcAns('eth_call', '0x' + (12345670000n).toString(16).padStart(64, '0'))];
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (init?.body) { const m = JSON.parse(init.body).method; const hit = calls.find(c => c.method === m); return new Response(hit.body, { status: 200 }); }
    if (String(u).includes('gopluslabs')) return new Response(JSON.stringify({ code: 1, result: { cybercrime: '0', phishing_activities: '1', data_source: 'test' } }));
    if (String(u).includes('coingecko')) return new Response(JSON.stringify({ ethereum: { usd: 2000 } }));
    throw new Error('unexpected ' + u);
  };
  try {
    const w = await walletSummary('base', addr, {});
    assert.deepEqual(w.balances, { eth: 2, usdc: 12345.67 });
    assert.equal(w.value_usd_est, 16345.67);
    assert.equal(w.type, 'eoa'); assert.equal(w.tx_count_sent, 42); assert.equal(w.activity_level, 'active');
    assert.deepEqual(w.reputation.flags, ['phishing_activities']);
    assert.ok(ajv.compile(cap('wallet.summary').output_schema)(w));
  } finally { globalThis.fetch = real; }
});
