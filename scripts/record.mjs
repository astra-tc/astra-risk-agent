// Records three real examples by running the agent core against the live public upstreams,
// and saves every upstream answer under fixtures/ so the tests replay them offline.
import { writeFileSync, mkdirSync } from 'node:fs';
import { tokenRisk, walletSummary, agentBrief } from '../src/core.js';
const realFetch = globalThis.fetch;
const cases = [
  { name: 'token-risk-degen-base', capability: 'token.risk', request: { chain: 'base', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' }, run: r => tokenRisk(r.chain, r.address, {}) },
  { name: 'wallet-usdc-contract-base', capability: 'wallet.summary', request: { chain: 'base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, run: r => walletSummary(r.chain, r.address, {}) },
  { name: 'agent-brief', capability: 'market.agent_brief', request: {}, run: () => agentBrief({}) },
];
mkdirSync('examples', { recursive: true }); mkdirSync('fixtures', { recursive: true });
for (const c of cases) {
  const tape = [];
  globalThis.fetch = async (url, init) => {
    const r = await realFetch(url, init); const body = await r.text();
    tape.push({ url: String(url), body_sent: init?.body ?? null, status: r.status, body });
    return new Response(body, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  const response = await c.run(c.request);
  globalThis.fetch = realFetch;
  writeFileSync(`examples/${c.name}.json`, JSON.stringify({ capability: c.capability, request: c.request, response }, null, 2) + '\n');
  writeFileSync(`fixtures/${c.name}.tape.json`, JSON.stringify(tape) + '\n');
  console.log(c.name, tape.length, 'upstream calls');
}
