// Astra risk agent core: pure functions over free public upstreams (GoPlus, DexScreener, public RPC, CoinGecko, CoinLore, alternative.me).
// fetch is the global one, so tests replace it with recorded upstream answers.
export const CG = "https://api.coingecko.com/api/v3";
const STABLES = new Set(["tether","usd-coin","dai","first-digital-usd","ethena-usde","usds","paypal-usd","true-usd"]);

export async function j(url, env, ttl = 120, tries = 2) {
  const key = "c:" + url, cache = globalThis.caches?.default, ck = new Request("https://cache.astra/" + encodeURIComponent(url));
  if (env.CACHE) { const hit = await env.CACHE.get(key, "json"); if (hit) return hit; }
  if (cache) { const hit = await cache.match(ck); if (hit) return hit.json(); }
  let last;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; astra-x402/2.0)" } }).catch(e => ({ ok: false, status: e.message }));
    if (r.ok) {
      const txt = await r.text(); const d = JSON.parse(txt);
      if (d && (d.code === 4029 || d.status?.error_code === 429)) { last = 429; } else {
        if (cache) await cache.put(ck, new Response(txt, { headers: { "content-type": "application/json", "cache-control": `max-age=${Math.max(60, ttl)}` } }));
        if (env.CACHE) await env.CACHE.put(key, txt, { expirationTtl: Math.max(60, ttl) });
        return d;
      }
    } else last = r.status;
    if (i < tries - 1) await new Promise(res => setTimeout(res, 600 * (i + 1)));
  }
  throw new Error(`upstream ${last} ${url.split("?")[0]}`);
}

export async function paprika(env) { // CoinLore fallback (free, no key)
  const [g0, t] = await Promise.all([j("https://api.coinlore.net/api/global/", env, 300), j("https://api.coinlore.net/api/tickers/?start=0&limit=100", env, 300)]);
  const g = g0[0], n = v => v == null ? null : +v;
  const mk = t.data.map(x => ({ id: x.nameid, symbol: x.symbol.toLowerCase(), current_price: n(x.price_usd), price_change_percentage_24h_in_currency: n(x.percent_change_24h),
    price_change_percentage_7d_in_currency: n(x.percent_change_7d), market_cap: n(x.market_cap_usd), total_volume: n(x.volume24) }));
  return [{ data: { total_market_cap: { usd: g.total_mcap }, total_volume: { usd: g.total_volume }, market_cap_change_percentage_24h_usd: n(g.mcap_change),
    market_cap_percentage: { btc: n(g.btc_d), eth: n(g.eth_d) } } }, mk];
}
export async function snapshot(env) {
  let g, mk, src = "coingecko.com";
  try { [g, mk] = await Promise.all([j(`${CG}/global`, env), j(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h,7d`, env)]); }
  catch { [g, mk] = await paprika(env); src = "coinlore.com"; }
  const fg = await j("https://api.alternative.me/fng/?limit=1", env, 600).catch(() => null);
  return snapshotFrom(g, mk, fg, src);
}
export function snapshotFrom(g, mk, fg, src) {
  const coins = mk.filter(c => !STABLES.has(c.id));
  const by = k => [...coins].sort((a, b) => (b[k] ?? 0) - (a[k] ?? 0));
  const slim = c => ({ id: c.id, symbol: c.symbol, price: c.current_price, chg24h: c.price_change_percentage_24h_in_currency, chg7d: c.price_change_percentage_7d_in_currency, mcap: c.market_cap });
  const up = coins.filter(c => (c.price_change_percentage_24h_in_currency ?? 0) > 0).length;
  return {
    ts: new Date().toISOString(),
    global: { mcap_usd: g.data.total_market_cap.usd, vol_usd: g.data.total_volume.usd, mcap_chg24h_pct: g.data.market_cap_change_percentage_24h_usd, btc_dom: g.data.market_cap_percentage.btc, eth_dom: g.data.market_cap_percentage.eth },
    fear_greed: fg?.data?.[0] ? { value: +fg.data[0].value, label: fg.data[0].value_classification } : null,
    majors: mk.filter(c => ["bitcoin","ethereum","solana","binancecoin","ripple"].includes(c.id)).map(slim),
    breadth: { up, down: coins.length - up, n: coins.length },
    gainers: by("price_change_percentage_24h_in_currency").slice(0, 5).map(slim),
    losers: by("price_change_percentage_24h_in_currency").reverse().slice(0, 5).map(slim),
    sources: [src, "alternative.me"],
    note: "Not financial advice.",
  };
}


// ---- Premium (v2) helpers: free public upstreams only (GoPlus, DexScreener, Base public RPC, CoinGecko) ----
export const CHAINS = { base: 8453, ethereum: 1, eth: 1, bsc: 56, arbitrum: 42161, polygon: 137, optimism: 10 };
export const RPC = { base: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://1rpc.io/base"], ethereum: ["https://ethereum-rpc.publicnode.com", "https://1rpc.io/eth"] };
const USDC = { base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", eth: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" };
export async function goplus(url, env) {
  for (let i = 0; i < 3; i++) {
    const d = await j(url, env, 600, 1).catch(() => null);
    if (d && d.code === 1) return d;
    await new Promise(r => setTimeout(r, 700 * (i + 1)));
  }
  return null;
}
export const isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(a || "");
export async function rpc(chain, method, params) {
  let last;
  for (const url of [...RPC[chain], RPC[chain][0]]) {
    try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const d = await r.json(); if (d.result !== undefined) return d.result; last = d.error?.message || r.status; } catch (e) { last = e.message; }
  }
  throw new Error("rpc unavailable: " + last);
}
export async function tokenRisk(chain, addr, env) {
  const cid = CHAINS[chain];
  const [gp, ds] = await Promise.all([
    goplus(`https://api.gopluslabs.io/api/v1/token_security/${cid}?contract_addresses=${addr}`, env),
    j(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, env, 120).catch(() => null),
  ]);
  const t = gp?.result?.[addr.toLowerCase()] || null;
  const pairs = (ds?.pairs || []).filter(p => !chain || p.chainId === (chain === "eth" ? "ethereum" : chain));
  const liq = pairs.reduce((a, p) => a + (p.liquidity?.usd || 0), 0);
  const vol24 = pairs.reduce((a, p) => a + (p.volume?.h24 || 0), 0);
  const ageDays = pairs.length ? (Date.now() - Math.min(...pairs.map(p => p.pairCreatedAt || Date.now()))) / 864e5 : null;
  const flags = []; let score = 0; const add = (cond, pts, f) => { if (cond) { score += pts; flags.push(f); } };
  if (t) {
    add(t.is_honeypot === "1", 60, "honeypot");
    add(t.cannot_sell_all === "1", 25, "cannot_sell_all");
    add(+t.sell_tax > 0.1, 20, `sell_tax_${(+t.sell_tax * 100).toFixed(1)}pct`);
    add(+t.buy_tax > 0.1, 10, `buy_tax_${(+t.buy_tax * 100).toFixed(1)}pct`);
    add(t.is_mintable === "1", 10, "mintable");
    add(t.hidden_owner === "1", 15, "hidden_owner");
    add(t.can_take_back_ownership === "1", 15, "can_take_back_ownership");
    add(t.owner_change_balance === "1", 20, "owner_can_change_balance");
    add(t.is_blacklisted === "1", 10, "blacklist_function");
    add(t.transfer_pausable === "1", 10, "transfer_pausable");
    add(t.is_proxy === "1", 5, "proxy_upgradeable");
    add(t.is_open_source === "0", 15, "not_open_source");
    add(t.slippage_modifiable === "1", 10, "tax_modifiable");
  } else flags.push("contract_security_data_unavailable_retry_later");
  if (ds) {
    add(liq < 10000, 15, "low_liquidity_lt_10k");
    add(ageDays != null && ageDays < 3, 10, "new_pair_lt_3d");
    add(!pairs.length, 10, "no_dex_pairs");
  } else flags.push("market_data_unavailable_retry_later");
  const topHolders = (t?.holders || []).slice(0, 5).map(h => ({ address: h.address, pct: +(+h.percent * 100).toFixed(2), is_contract: h.is_contract === 1, locked: h.is_locked === 1, tag: h.tag || null }));
  score = Math.min(100, score);
  return { ts: new Date().toISOString(), chain, address: addr, name: t?.token_name || pairs[0]?.baseToken?.name || null, symbol: t?.token_symbol || pairs[0]?.baseToken?.symbol || null,
    risk_score: (!t && !ds) ? null : score, risk_level: (!t && !ds) ? "unknown" : score >= 50 ? "high" : score >= 20 ? "medium" : "low", data_complete: !!(t && ds), flags,
    contract: t ? { open_source: t.is_open_source === "1", proxy: t.is_proxy === "1", mintable: t.is_mintable === "1", honeypot: t.is_honeypot === "1", buy_tax: +t.buy_tax || 0, sell_tax: +t.sell_tax || 0, owner: t.owner_address || null, holders: +t.holder_count || null, total_supply: t.total_supply || null } : null,
    top_holders: topHolders,
    market: !ds ? null : { pairs: pairs.length, liquidity_usd: Math.round(liq), volume_24h_usd: Math.round(vol24), price_usd: pairs[0]?.priceUsd ? +pairs[0].priceUsd : null, oldest_pair_age_days: ageDays == null ? null : +ageDays.toFixed(1), top_pair: pairs[0]?.url || null },
    sources: ["gopluslabs.io", "dexscreener.com"], note: "Heuristic score 0-100 (higher = riskier). Not financial advice; not an audit." };
}
export async function walletSummary(chain, addr, env) {
  const usdcData = "0x70a08231000000000000000000000000" + addr.slice(2).toLowerCase();
  const bal = await rpc(chain, "eth_getBalance", [addr, "latest"]);
  const nonce = await rpc(chain, "eth_getTransactionCount", [addr, "latest"]);
  const code = await rpc(chain, "eth_getCode", [addr, "latest"]);
  const usdc = await rpc(chain, "eth_call", [{ to: USDC[chain], data: usdcData }, "latest"]).catch(() => "0x0");
  const [sec, eth] = await Promise.all([
    goplus(`https://api.gopluslabs.io/api/v1/address_security/${addr}?chain_id=${CHAINS[chain]}`, env),
    j(`${CG}/simple/price?ids=ethereum&vs_currencies=usd`, env, 120).catch(() => j("https://api.coinlore.net/api/ticker/?id=80", env, 120).then(x => ({ ethereum: { usd: +x[0].price_usd } })).catch(() => null)),
  ]);
  const ethBal = Number(BigInt(bal)) / 1e18, usdcBal = Number(BigInt(!usdc || usdc === "0x" ? "0x0" : usdc)) / 1e6, px = eth?.ethereum?.usd || null;
  const s = sec?.result || {}; const bad = Object.entries(s).filter(([k, v]) => v === "1" && k !== "contract_address").map(([k]) => k);
  return { ts: new Date().toISOString(), chain, address: addr, type: code && code !== "0x" ? "contract_or_smart_wallet" : "eoa",
    tx_count_sent: Number(BigInt(nonce)), balances: { eth: +ethBal.toFixed(6), usdc: +usdcBal.toFixed(2) },
    value_usd_est: px ? +(ethBal * px + usdcBal).toFixed(2) : null, eth_price_usd: px,
    reputation: { flagged: bad.length > 0, flags: bad, data_source: s.data_source || null },
    activity_level: Number(BigInt(nonce)) === 0 ? "none" : Number(BigInt(nonce)) < 20 ? "light" : Number(BigInt(nonce)) < 500 ? "active" : "heavy",
    sources: ["Base/Ethereum public RPC", "gopluslabs.io", "coingecko.com"], note: "Native ETH + USDC only. Not financial advice." };
}
/** Market regime from the 24h market cap change m (percent) and the share br of top-100 coins up. */
export const regimeOf = (m, br) => (m > 2 && br > 0.65) ? "risk_on_strong" : (m > 0 && br > 0.5) ? "risk_on" : (m < -2 && br < 0.35) ? "risk_off_strong" : (m < 0 && br < 0.5) ? "risk_off" : "neutral";
export async function agentBrief(env) {
  const [s, tr] = await Promise.all([snapshot(env), j(`${CG}/search/trending`, env, 600).catch(() => null)]);
  const fg = s.fear_greed?.value ?? 50, br = s.breadth.up / Math.max(1, s.breadth.n), m = s.global.mcap_chg24h_pct ?? 0;
  const regime = regimeOf(m, br);
  const signals = [];
  if (fg <= 25) signals.push({ type: "sentiment", text: "Extreme fear: historically elevated volatility; contrarian setups possible" });
  if (fg >= 75) signals.push({ type: "sentiment", text: "Extreme greed: elevated pullback risk" });
  if (s.global.btc_dom > 58) signals.push({ type: "rotation", text: "High BTC dominance: alts lagging" });
  if (br > 0.8) signals.push({ type: "breadth", text: "Broad rally across top-100" });
  if (br < 0.2) signals.push({ type: "breadth", text: "Broad sell-off across top-100" });
  const trending = (tr?.coins || []).slice(0, 7).map(x => ({ id: x.item.id, symbol: x.item.symbol, mcap_rank: x.item.market_cap_rank }));
  return { ts: s.ts, schema: "astra.agent_brief.v1", regime, scores: { fear_greed: fg, breadth_up_ratio: +br.toFixed(3), mcap_chg24h_pct: +m.toFixed(2), btc_dominance: +s.global.btc_dom.toFixed(2) },
    signals, majors: s.majors, movers: { gainers: s.gainers, losers: s.losers }, trending,
    summary: `Regime ${regime}. Total mcap ${(s.global.mcap_usd/1e12).toFixed(2)}T (${m.toFixed(2)}% 24h); F&G ${fg}; ${s.breadth.up}/${s.breadth.n} of top-100 up; BTC dom ${s.global.btc_dom.toFixed(1)}%.`,
    sources: s.sources.concat(["coingecko.com/trending"]), note: "Machine-readable market context for agents. Not financial advice." };
}


