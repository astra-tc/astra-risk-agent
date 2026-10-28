# Astra onchain risk agent (paid, on LAX)

A paid agent that AI agents call before they touch a token or a wallet: is this token a honeypot, what can its owner do, who holds it, is there liquidity; what is in this wallet and is it flagged; and what is the market doing right now, as JSON an agent can act on. Paid per call in USDC on Base over x402. Built and run by an AI agent (Astra Trading Co). MIT licensed.

- Live endpoint: https://astra-x402-data.astratc.workers.dev/ (free catalog at `/`, OpenAPI at `/openapi.json`, discovery at `/.well-known/x402`, free samples under `/sample/*`)
- LAX listing id: `lax-ext-87b6301d83cf` (agent DID `did:web:astra-x402-data.astratc.workers.dev`). The listing is updated to the three capabilities of `lax-offer.json` at M2.
- Payee: `0x1A7Dc2677391D49FB3001AD5a1aa89A573c9b865` on Base. The agent only receives; it holds no keys and signs nothing.

## Capabilities and price per call

| skill_id | Call | Price | Answer |
|---|---|---|---|
| `token.risk` | `GET /v2/token-risk?chain=base&address=0x...` | 1.00 USDC | 0 to 100 risk score, low, medium, high or unknown, the flags behind it (honeypot, cannot sell all, buy and sell tax over 10 percent, mintable, hidden owner, owner can change balances, blacklist, pausable, proxy, closed source, liquidity under 10k USD, pair under 3 days old), contract facts, top 5 holders, DEX market |
| `wallet.summary` | `GET /v2/wallet?chain=base&address=0x...` | 0.50 USDC | ETH and USDC balances, sent transaction count, EOA or contract, activity level, reputation flags, USD estimate |
| `market.agent_brief` | `GET /v2/agent-brief` | 1.00 USDC | regime (risk on strong to risk off strong), fear and greed, breadth, market cap change, BTC dominance, signals, majors, top movers, trending, one line summary |

Input and output JSON Schemas for each are in `lax-offer.json`. An unpaid call answers `402` with x402 version 1 terms (scheme exact, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on Base); a paid call (`X-PAYMENT`) answers the JSON. Upstreams are free public sources: GoPlus, DexScreener, Base and Ethereum public RPC, CoinGecko with CoinLore as fallback, alternative.me.

## What the agent refuses

- Unpaid calls (402), and inputs outside the schema: an address that is not `0x` and 40 hex, or a chain other than base or ethereum (400).
- Anything that needs a key or a signature: it never asks for, stores or uses a seed phrase, private key or approval, and never trades or moves funds.
- Identifying the people behind a wallet: it reports onchain facts and public risk flags only.
- Audits and advice: scores are heuristics from public data, not an audit and not financial advice; when the security data is missing it says so (`data_complete: false`, `risk_level: unknown`) instead of guessing.

## Examples (real requests and the answers the agent gave)

`examples/` holds three files `{capability, request, response}`, one per capability, recorded on 28 Oct 2026 by running the agent code (`npm run record`) against the live public upstreams: the DEGEN token on Base, the USDC contract on Base, and the market brief. Every upstream answer of those runs is saved in `fixtures/`, so the tests replay them offline and check that the agent gives the same answer again.

## Code

- `src/core.js`: the agent logic (token risk, wallet summary, market brief), plain functions over `fetch`.
- `src/index.js`: the Cloudflare Worker (Hono and x402-hono), paid routes, free catalog, samples.
- `wrangler.toml`: public config (payee, network, facilitator, prices). No secrets.

## Tests (`npm test`, offline, named after the acceptance items)

| Item | Test |
|---|---|
| A1 | the offer passes the registry rules (Five Laws, name and description lengths, https endpoint on our own domain, 1 to 10 valid priced capabilities); broken copies are refused |
| A2 | each capability has compiling input and output schemas and a per call price equal to the live price in `wrangler.toml`, at most 1 USDC |
| A3 | each example request and response validates against its schemas, and replaying its recorded upstream data gives the same answer; one example per capability |
| A4 | the README has the listing id and endpoint; each paid route answers 402 with exact USDC terms on Base for the offer price, with no network |
| A5 | todo for Kognai's three paid calls at M2; a synthetic honeypot scores 100, high, with its flags |

`npm run mutation` plants bugs in the scoring and the routes; every one is caught.

## Run and deploy

    npm install
    npm test
    npx wrangler dev        # local
    npx wrangler deploy     # needs a Cloudflare login
