# CS2 Deal Finder

A local web app that finds the best CS2 skin deals by comparing live prices across DMarket, Skinport, and optionally CSFloat, with Steam and Buff163 reference prices for context. Node/Express server acting as an API proxy with a 5 minute cache, plus a static HTML/JS frontend.

## Structure

```
cs2_app/
├── server.js            # Express server, /api/deals endpoint, 5-min cache
├── public/index.html    # Frontend: cards with images, filters, deal grading
├── package.json         # Only dependency: express (Node 18+ for global fetch)
├── docs/                # Project handoff notes
└── tests/               # Smoke test and API fixtures
```

## Run it

```
npm install
node server.js
```

Then open http://localhost:3000. The status bar should show "LIVE - DMarket + Skinport" with a real item count once both sources answer.

## Optional: CSFloat as a third source

CSFloat has a proper listings API with float values but requires a free API key, generated in your CSFloat profile under the developer tab. Set it before starting the server and CSFloat joins the merge automatically:

```powershell
$env:CSFLOAT_API_KEY = "your-key-here"
node server.js
```

On mac or Linux: `CSFLOAT_API_KEY=your-key-here node server.js`. Without the key the app runs on two sources and prints a reminder at startup.

## Mock mode

The live marketplace APIs are unreachable from some sandboxed environments. Mock mode serves bundled fixtures through the exact same merge pipeline so the app can be developed and tested anywhere:

```
npm run mock
```

The status bar will show "MOCK DATA" instead of "LIVE".

## Test

```
npm test
```

Boots the server in mock mode and asserts the /api/deals response shape, the cross-market merge, the discount fallback logic, and the cache.

## How it works

- The server pulls 3 pages (100 items each) of listings from DMarket and the full Skinport item list, then merges the two by exact item name. DMarket retired its old exchange endpoint with HTTP 410, so the fetcher tries a chain of endpoints (current offers/v1/search first) and logs which one answered plus a sample object for field verification.
- The cheapest source wins per item. Discount is computed against the suggested price, falling back to the highest listed price when no suggested price exists.
- Results are cached for 5 minutes. Skinport rate limits to roughly 1 request per 5 minutes per IP, so never remove the cache.
- Deals are graded with CS2 rarity tiers: Consumer (0%+), Mil-Spec (5%+), Restricted (12%+), Classified (20%+), Covert (30%+).
- Aggregated reference prices come from the CSGOTrader price dataset (one fetch, cached 6 hours): each card shows Steam and Buff163 reference rows with links, and the discount falls back to the Buff163 then Steam reference when a marketplace publishes no suggested price. Live per-item Steam priceoverview calls were deliberately skipped, they get IPs rate banned fast and the aggregated dataset already covers Steam prices.
- Float values show on cards when DMarket or CSFloat provides them.
- Every item gets a 0 to 5 popularity rating from Skinport 7-day sales volume (refreshed every 30 minutes), falling back to total listing counts when an item has no sales history.
- Images come from DMarket when available, with a fallback to Steam CDN images resolved through the ByMykel/CSGO-API market hash name dataset (refreshed daily), so Skinport-only items get pictures too. Items missing from both show a "NO PREVIEW" placeholder.
- The card image, the item name, and every price are links to the live marketplace listing.

## Live verification checklist

The live API calls have not yet been exercised from a network that allows them. When running on an unrestricted machine, check:

1. The console for "DMarket failed" or "Skinport failed" logs on startup requests.
2. DMarket: the `orderBy=best_discount` param, the `cursor` field name in the paginated response, and the response shape (`objects[]`, `price.USD` in cents, `suggestedPrice.USD`, `image`, `title`). The fetcher already tolerates a missing cursor and string or numeric cent values.
3. Skinport: fields `market_hash_name`, `min_price`, `suggested_price`. The fetcher requests Brotli encoding and decompresses manually when the Node runtime does not.
4. That images render on DMarket-sourced cards and each price opens the right listing.
