// Astra onchain risk agent (Cloudflare Workers). Receives USDC on Base over x402; never signs or spends.
import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import { CG, j, snapshot, tokenRisk, walletSummary, agentBrief, isAddr, CHAINS, RPC } from "./core.js";

const app = new Hono();

// Text tools (Workers AI)
async function getText(c) {
  let t = c.req.query("text"), u = c.req.query("url"), lang = c.req.query("to"), b = {};
  if (c.req.method === "POST") { try { b = await c.req.json(); } catch {} t = b.text || t; u = b.url || u; lang = b.to || lang; }
  if (!t && u && /^https?:\/\//.test(u)) { const r = await fetch(u, { headers: { "user-agent": "astra-x402" } }); t = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "); }
  return { text: (t || "").slice(0, 12000), to: (lang || "es").toLowerCase().slice(0, 12) };
}
async function summarize(text, env) {
  const inp = { max_tokens: 400, messages: [{ role: "system", content: "Summarize the user's text as exactly 5 concise bullet points, then one line starting 'TL;DR:'. No preamble." }, { role: "user", content: text }] };
  let r, err;
  for (const m of ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct"]) { try { r = await env.AI.run(m, inp); break; } catch (e) { err = e; } }
  if (!r) throw err;
  return { ts: new Date().toISOString(), chars_in: text.length, summary: (r.response || "").trim() };
}
async function translate(text, to, env) {
  const r = await env.AI.run("@cf/meta/m2m100-1.2b", { text, source_lang: "en", target_lang: to });
  return { ts: new Date().toISOString(), target_lang: to, chars_in: text.length, translation: r.translated_text };
}

// Free endpoints (discovery + health)
app.get("/", c => c.json({
  name: "Astra market data (x402)", payTo: c.env.PAY_TO, network: c.env.NETWORK,
  endpoints: {
    "GET /v1/snapshot": `${c.env.PRICE_SNAPSHOT} - top-100 market snapshot (global, F&G, majors, breadth, gainers/losers)`,
    "GET /v1/coin?id=bitcoin": `${c.env.PRICE_COIN} - one coin price/changes`,
    "GET /v1/brief": `${c.env.PRICE_BRIEF} - today's Astra Daily Crypto Brief (markdown)`,
    "GET /v2/token-risk?chain=base&address=0x...": `${c.env.PRICE_RISK} - token risk check (honeypot, taxes, owner powers, holders, liquidity) with 0-100 score`,
    "GET /v2/wallet?chain=base&address=0x...": `${c.env.PRICE_WALLET} - wallet summary (ETH+USDC balances, tx count, EOA/contract, reputation flags)`,
    "GET /v2/agent-brief": `${c.env.PRICE_AGENT_BRIEF} - machine-readable market brief for agents (regime, scores, signals, movers, trending)`,
    "GET|POST /v2/summarize?text=..|url=..": `${c.env.PRICE_SUMMARIZE} - 5-bullet summary + TL;DR of text or a web page (max 12k chars)`,
    "GET|POST /v2/translate?text=..&to=es": `${c.env.PRICE_TRANSLATE} - translate English text (max 12k chars) to es, fr, de, pt, ja, ko, zh, ru, tr, id and more`,
  },
  free_samples: { "GET /sample/token-risk": "cached example output", "GET /sample/wallet": "example output", "GET /sample/agent-brief": "example output", "GET /sample/summarize": "example output", "GET /sample/translate": "example output" },
  docs: "https://astratc.github.io/llms.txt", openapi: "/openapi.json", listings: { payapi_market: "https://payapi.market/api/astra-crypto-market-data" }, example: "https://github.com/astratc/x402-crypto-data-example",
}));
app.get("/health", c => c.text("ok"));
const BASE = "https://astra-x402-data.astratc.workers.dev";
app.get("/.well-known/x402", c => c.json({ version: 1, resources: [`${BASE}/v1/coin`, `${BASE}/v1/snapshot`, `${BASE}/v1/brief`, `${BASE}/v2/token-risk`, `${BASE}/v2/wallet`, `${BASE}/v2/agent-brief`, `${BASE}/v2/summarize`, `${BASE}/v2/translate`], instructions: "GET routes; pay via x402 v1 (exact, USDC on Base). Free catalog at /. Docs: https://astratc.github.io/llms.txt" }));
const CHP = { name: "chain", in: "query", required: false, schema: { type: "string", default: "base", enum: ["base", "ethereum"] } };
const ADP = { name: "address", in: "query", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } };
app.get("/openapi.json", c => {
  const op = (summary, amount, mime, params) => ({ get: { summary, ...(params ? { parameters: params } : {}),
    "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount } },
    responses: { "200": { description: "OK", content: { [mime]: {} } }, "402": { description: "Payment required (x402, USDC on Base)" } } } });
  return c.json({ openapi: "3.1.0",
    info: { title: "Astra market data (x402)", version: "2.0.0", description: "Pay-per-call crypto market data for AI agents. USDC on Base via x402. Not financial advice.",
      "x-guidance": "GET /v1/coin?id=<coingecko id> for one coin ($0.01); GET /v1/snapshot for a top-100 market snapshot ($0.05); GET /v1/brief for the daily markdown brief ($0.25); GET /v2/token-risk?chain=base&address=0x.. for a token risk check ($1.00); GET /v2/wallet?chain=base&address=0x.. for a wallet summary ($0.50); GET /v2/agent-brief for a JSON market regime brief ($1.00); GET/POST /v2/summarize?text=..|url=.. ($0.10); GET/POST /v2/translate?text=..&to=es ($0.10). Free samples under /sample/*. No API key; pay the 402 challenge." },
    servers: [{ url: BASE }],
    paths: {
      "/v1/coin": op("Single coin price and 24h/7d change", "0.01", "application/json", [{ name: "id", in: "query", required: false, schema: { type: "string", default: "bitcoin" }, description: "CoinGecko coin id" }]),
      "/v1/snapshot": op("Top-100 crypto market snapshot (global, Fear & Greed, majors, breadth, movers)", "0.05", "application/json"),
      "/v1/brief": op("Astra Daily Crypto Brief (markdown)", "0.25", "text/markdown"),
      "/v2/token-risk": op("Token risk check: honeypot, taxes, owner powers, top holders, liquidity; 0-100 risk score", "1.00", "application/json", [CHP, ADP]),
      "/v2/wallet": op("Wallet summary: ETH and USDC balances, tx count, EOA/contract, reputation flags", "0.50", "application/json", [CHP, ADP]),
      "/v2/agent-brief": op("Agent-ready JSON market brief: regime, scores, signals, movers, trending", "1.00", "application/json"),
      "/v2/summarize": op("Summarize text or a web page URL: 5 bullets + TL;DR (POST JSON {text|url} also accepted)", "0.10", "application/json", [{ name: "text", in: "query", required: false, schema: { type: "string" } }, { name: "url", in: "query", required: false, schema: { type: "string" } }]),
      "/v2/translate": op("Translate English text to a target language (POST JSON {text,to} also accepted)", "0.10", "application/json", [{ name: "text", in: "query", required: true, schema: { type: "string" } }, { name: "to", in: "query", required: false, schema: { type: "string", default: "es" } }]),
    } });
});

// Free samples (fixed example inputs, cached 15 min per colo) so agents can see the shape before paying
app.use("/sample/*", async (c, next) => {
  const cache = caches.default, key = new Request(c.req.url);
  const hit = await cache.match(key); if (hit) return hit;
  await next();
  if (c.res.status === 200) { const r = new Response(c.res.clone().body, c.res); r.headers.set("cache-control", "max-age=900"); c.executionCtx.waitUntil(cache.put(key, r)); }
});
app.get("/sample/token-risk", async c => c.json({ sample: true, ...(await tokenRisk("base", "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", c.env)) }));
app.get("/sample/wallet", async c => c.json({ sample: true, ...(await walletSummary("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", c.env)) }));
app.get("/sample/summarize", async c => c.json({ sample: true, ...(await summarize("x402 is an open payment protocol that uses the HTTP 402 Payment Required status code so APIs and AI agents can pay per request in stablecoins such as USDC. A server answers an unpaid request with 402 and payment requirements; the client signs a payment payload and retries; a facilitator verifies and settles it onchain. It removes API keys and subscriptions for machine-to-machine commerce.", c.env)) }));
app.get("/sample/translate", async c => c.json({ sample: true, ...(await translate("Pay per call with USDC on Base. No API key needed.", "es", c.env)) }));
app.get("/sample/agent-brief", async c => { const b = await agentBrief(c.env); return c.json({ sample: true, ts: b.ts, schema: b.schema, regime: b.regime, scores: b.scores, signals: b.signals, summary: b.summary, note: "Sample omits movers/trending; full output via paid /v2/agent-brief." }); });

// Paid routes
app.use("/v2/*", (c, next) => paymentMiddleware(
  c.env.PAY_TO,
  {
    "/v2/token-risk": { price: c.env.PRICE_RISK, network: c.env.NETWORK, config: { inputSchema: { queryParams: { chain: { type: "string", enum: ["base", "ethereum"], default: "base" }, address: { type: "string", description: "0x-prefixed 40-hex address", required: true } } }, outputSchema: { type: "object", properties: { risk_score: { type: "number" }, risk_level: { type: "string" }, flags: { type: "array" }, contract: { type: "object" }, top_holders: { type: "array" }, market: { type: "object" } } },  description: "Token risk check (honeypot, taxes, owner powers, holders, liquidity) with 0-100 score. Query: chain=base|ethereum, address=0x..", mimeType: "application/json", discoverable: true } },
    "/v2/wallet": { price: c.env.PRICE_WALLET, network: c.env.NETWORK, config: { inputSchema: { queryParams: { chain: { type: "string", enum: ["base", "ethereum"], default: "base" }, address: { type: "string", description: "0x-prefixed 40-hex address", required: true } } }, outputSchema: { type: "object", properties: { type: { type: "string" }, tx_count_sent: { type: "number" }, balances: { type: "object" }, value_usd_est: { type: "number" }, reputation: { type: "object" }, activity_level: { type: "string" } } },  description: "Wallet summary: ETH+USDC balances, tx count, EOA/contract, reputation flags. Query: chain=base|ethereum, address=0x..", mimeType: "application/json", discoverable: true } },
    "/v2/agent-brief": { price: c.env.PRICE_AGENT_BRIEF, network: c.env.NETWORK, config: { inputSchema: { queryParams: {} }, outputSchema: { type: "object", properties: { regime: { type: "string" }, scores: { type: "object" }, signals: { type: "array" }, majors: { type: "array" }, movers: { type: "object" }, trending: { type: "array" }, summary: { type: "string" } } },  description: "Agent-ready JSON crypto market brief: regime, scores, signals, movers, trending", mimeType: "application/json", discoverable: true } },
    "/v2/summarize": { price: c.env.PRICE_SUMMARIZE, network: c.env.NETWORK, config: { inputSchema: { queryParams: { text: { type: "string", description: "text to summarize (or use url)" }, url: { type: "string", description: "http(s) page to summarize" } } }, outputSchema: { type: "object", properties: { summary: { type: "string" }, chars_in: { type: "number" } } }, description: "Summarize text or a web page: 5 bullets + TL;DR. Max 12k chars.", mimeType: "application/json", discoverable: true } },
    "/v2/translate": { price: c.env.PRICE_TRANSLATE, network: c.env.NETWORK, config: { inputSchema: { queryParams: { text: { type: "string", required: true }, to: { type: "string", default: "es", description: "target language code" } } }, outputSchema: { type: "object", properties: { translation: { type: "string" }, target_lang: { type: "string" } } }, description: "Translate English text to a target language. Max 12k chars.", mimeType: "application/json", discoverable: true } },
  },
  { url: c.env.FACILITATOR_URL },
)(c, next));
const chainQ = c => { const ch = (c.req.query("chain") || "base").toLowerCase(); return ch === "eth" ? "ethereum" : ch; };
app.get("/v2/token-risk", async c => { const a = c.req.query("address"), ch = chainQ(c); if (!isAddr(a) || !CHAINS[ch]) return c.json({ error: "need chain=base|ethereum and address=0x..40hex" }, 400); return c.json(await tokenRisk(ch, a, c.env)); });
app.get("/v2/wallet", async c => { const a = c.req.query("address"), ch = chainQ(c); if (!isAddr(a) || !RPC[ch]) return c.json({ error: "need chain=base|ethereum and address=0x..40hex" }, 400); return c.json(await walletSummary(ch, a, c.env)); });
app.get("/v2/agent-brief", async c => c.json(await agentBrief(c.env)));
const sumH = async c => { const { text } = await getText(c); if (text.length < 20) return c.json({ error: "need text=.. (20+ chars) or url=http(s)://.." }, 400); return c.json(await summarize(text, c.env)); };
const trH = async c => { const { text, to } = await getText(c); if (!text) return c.json({ error: "need text=.. and to=<lang code>" }, 400); return c.json(await translate(text, to, c.env)); };
app.get("/v2/summarize", sumH); app.post("/v2/summarize", sumH);
app.get("/v2/translate", trH); app.post("/v2/translate", trH);

app.use("/v1/*", (c, next) => paymentMiddleware(
  c.env.PAY_TO,
  {
    "/v1/snapshot": { price: c.env.PRICE_SNAPSHOT, network: c.env.NETWORK, config: { inputSchema: { queryParams: {} }, outputSchema: { type: "object", properties: { global: { type: "object" }, fear_greed: { type: "object" }, majors: { type: "array" }, breadth: { type: "object" }, gainers: { type: "array" }, losers: { type: "array" } } },  description: "Top-100 crypto market snapshot JSON", mimeType: "application/json", discoverable: true } },
    "/v1/coin": { price: c.env.PRICE_COIN, network: c.env.NETWORK, config: { inputSchema: { queryParams: { id: { type: "string", default: "bitcoin", description: "CoinGecko coin id" } } }, outputSchema: { type: "object", properties: { id: { type: "string" }, price: { type: "number" }, chg24h: { type: "number" }, chg7d: { type: "number" }, mcap: { type: "number" } } },  description: "Single coin price and 24h/7d change", mimeType: "application/json", discoverable: true } },
    "/v1/brief": { price: c.env.PRICE_BRIEF, network: c.env.NETWORK, config: { inputSchema: { queryParams: {} }, outputSchema: { type: "string", format: "markdown" },  description: "Astra Daily Crypto Brief, markdown", mimeType: "text/markdown", discoverable: true } },
  },
  { url: c.env.FACILITATOR_URL },
)(c, next));

app.get("/v1/snapshot", async c => c.json(await snapshot(c.env)));
app.get("/v1/coin", async c => {
  const id = (c.req.query("id") || "bitcoin").toLowerCase().replace(/[^a-z0-9-]/g, "");
  let d; try { d = await j(`${CG}/coins/markets?vs_currency=usd&ids=${id}&price_change_percentage=24h,7d`, c.env); }
  catch { const [, mk] = await paprika(c.env); d = mk.filter(x => x.id === id); }
  if (!d.length) return c.json({ error: "unknown id" }, 404);
  const x = d[0];
  return c.json({ ts: new Date().toISOString(), id: x.id, symbol: x.symbol, price: x.current_price, chg24h: x.price_change_percentage_24h_in_currency, chg7d: x.price_change_percentage_7d_in_currency, mcap: x.market_cap, vol: x.total_volume, source: "coingecko.com" });
});
app.get("/v1/brief", async c => {
  const r = await fetch("https://astratc.github.io/brief/latest.md");
  if (r.ok) return c.body(await r.text(), 200, { "content-type": "text/markdown; charset=utf-8" });
  const s = await snapshot(c.env);
  const f = n => n == null ? "n/a" : n.toFixed(2);
  const md = `# Astra Daily Crypto Brief (${s.ts.slice(0,10)})\n\n- Total market cap: $${(s.global.mcap_usd/1e12).toFixed(2)}T (${f(s.global.mcap_chg24h_pct)}% 24h)\n- BTC dominance: ${f(s.global.btc_dom)}%\n- Fear & Greed: ${s.fear_greed ? s.fear_greed.value + " (" + s.fear_greed.label + ")" : "n/a"}\n- Breadth (top-100 ex-stables): ${s.breadth.up} up / ${s.breadth.down} down\n\n## Majors\n${s.majors.map(m => `- ${m.symbol.toUpperCase()}: $${m.price} (${f(m.chg24h)}% 24h, ${f(m.chg7d)}% 7d)`).join("\n")}\n\n## Top gainers\n${s.gainers.map(m => `- ${m.symbol.toUpperCase()} ${f(m.chg24h)}%`).join("\n")}\n\n## Top losers\n${s.losers.map(m => `- ${m.symbol.toUpperCase()} ${f(m.chg24h)}%`).join("\n")}\n\n_Sources: CoinGecko, alternative.me. Not financial advice._\n`;
  return c.body(md, 200, { "content-type": "text/markdown; charset=utf-8" });
});
app.onError((e, c) => c.json({ error: "upstream_error", detail: String(e.message).slice(0, 200) }, 502));

export default app;
