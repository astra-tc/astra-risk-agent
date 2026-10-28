import { readFileSync } from 'node:fs';
export const load = p => JSON.parse(readFileSync(new URL('../' + p, import.meta.url)));
export const offer = load('lax-offer.json');
export const EXAMPLES = ['token-risk-degen-base', 'wallet-usdc-contract-base', 'agent-brief'];
export const FIVE_LAWS = ['Solidarity Oath', 'Renewal Mandate', 'Treasury Equilibrium', 'Harm Shield', 'Transparency Covenant'];
export const ENV = { PAY_TO: '0x1A7Dc2677391D49FB3001AD5a1aa89A573c9b865', NETWORK: 'base', FACILITATOR_URL: 'https://facilitator.payai.network' };
// Prices come from wrangler.toml so the test proves the live config and the offer agree.
for (const line of readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^(PRICE_[A-Z_]+)\s*=\s*"([^"]+)"/); if (m) ENV[m[1]] = m[2];
}
export const ROUTES = { 'token.risk': ['/v2/token-risk', 'PRICE_RISK'], 'wallet.summary': ['/v2/wallet', 'PRICE_WALLET'], 'market.agent_brief': ['/v2/agent-brief', 'PRICE_AGENT_BRIEF'] };

/** Replace fetch with a recorded tape: answers are matched by url and request body; any other call fails. */
export function replay(tape) {
  const real = globalThis.fetch, used = [];
  globalThis.fetch = async (url, init) => {
    const hit = tape.find((t, i) => !used.includes(i) && t.url === String(url) && (t.body_sent ?? null) === (init?.body ?? null));
    if (!hit) throw new Error('no recorded answer for ' + url);
    used.push(tape.indexOf(hit));
    return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json' } });
  };
  return () => { globalThis.fetch = real; };
}
export function validateOffer(o) {
  const p = [];
  if (typeof o.name !== 'string' || o.name.length < 3 || o.name.length > 80) p.push('name must be 3 to 80 characters');
  if (typeof o.description !== 'string' || o.description.length < 20 || o.description.length > 600) p.push('description must be 20 to 600 characters');
  let host = '';
  try { const u = new URL(o.endpoint); if (u.protocol !== 'https:') p.push('endpoint must be https'); host = u.hostname; } catch { p.push('endpoint must be an https url'); }
  if (host === 'kognai.ai' || host.endsWith('.kognai.ai')) p.push('endpoint must be on your own domain, not kognai.ai');
  if (o.category && (o.category.length < 2 || o.category.length > 40)) p.push('category must be 2 to 40 characters');
  if (!Array.isArray(o.capabilities) || o.capabilities.length < 1 || o.capabilities.length > 10) p.push('capabilities must have 1 to 10 items');
  for (const [i, c] of (o.capabilities || []).entries()) {
    if (!c.skill_id) p.push(`capabilities[${i}].skill_id is required`);
    const pr = c.pricing || {};
    if (!['per_call', 'per_minute', 'flat', 'free'].includes(pr.model) || pr.currency !== 'USDC' || pr.rail !== 'x402' || !/^\d+(\.\d{1,6})?$/.test(pr.amount || '')) p.push(`capabilities[${i}].pricing is not valid`);
  }
  for (const law of FIVE_LAWS) if (!(o.constitutional_constraints || []).includes(law)) p.push(`constitutional_constraints must include ${law}`);
  return p;
}
