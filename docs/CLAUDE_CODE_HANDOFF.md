# CS2 Deal Finder - Claude Code Handoff

## What this is
A local web app that finds the best CS2 skin deals by comparing live prices across DMarket and Skinport. Built as a Node/Express server (API proxy + cache) with a static HTML/JS frontend. The starting code is in `cs2-deal-finder.zip` (unzip it first) with this structure:

```
cs2-deal-finder/
  server.js          # Express server, /api/deals endpoint, 5-min cache
  public/index.html  # Frontend: cards with images, filters, deal grading
  package.json       # Only dependency: express (Node 18+ for global fetch)
  README.md
```

## First task: verify it works end to end
The code boots and serves correctly but the live marketplace API calls have NOT been tested (they were blocked in the environment where this was written). So:

1. `npm install && node server.js`, open http://localhost:3000
2. Confirm `/api/deals` returns real data from both sources. Watch the console for "DMarket failed" or "Skinport failed" logs.
3. Known risk areas to check and fix if broken:
   - DMarket endpoint: `https://api.dmarket.com/exchange/v1/market/items?gameId=a8db&currency=USD&limit=100&orderBy=best_discount&orderDir=desc` with cursor pagination (3 pages). Verify the `orderBy=best_discount` param, the `cursor` field name, and the response shape (`objects[]`, `price.USD` in cents, `suggestedPrice.USD`, `image`, `title`).
   - Skinport endpoint: `https://api.skinport.com/v1/items?app_id=730&currency=USD`. It requires Brotli accept-encoding and is rate limited to ~1 request per 5 minutes per IP. The server caches for 5 minutes to respect this. Verify fields `market_hash_name`, `min_price`, `suggested_price`.
4. Fix whatever is broken until the status bar shows "LIVE - DMarket + Skinport" with a real item count and images render on cards.

## How the app works
- Server merges both sources by exact item name, finds the cheapest source per item, and computes discount vs `suggested_price` (falls back to the highest listed price when no suggested price exists).
- Frontend grades each deal using CS2 rarity tiers: Consumer (0%+), Mil-Spec (5%+), Restricted (12%+), Classified (20%+), Covert (30%+), with matching CS2 rarity colors (#4b69ff, #8847ff, #d32ce6, #eb4b4b).
- Filters: search, min/max price, only-cross-listed, only-with-images. Sorts: discount, cross-market spread, price asc/desc.
- Images come from DMarket only (Skinport's public API has no images). Skinport-only items show a "NO PREVIEW" placeholder.

## Improvements to make after it works (in priority order)
1. **More market coverage from DMarket**: 3 pages x 100 items only covers top best-discount listings. Add more pagination or additional sorted pulls (e.g. by popularity) and dedupe.
2. **Images for Skinport-only items**: resolve Steam CDN icon URLs (e.g. via a market hash name to icon mapping such as the ByMykel/CSGO-API dataset on GitHub) so every card has a picture.
3. **Watchlist + alerts**: let the user star items and set a target price, persist to a local JSON file, and surface hits at the top.
4. **Price history**: append each 5-min snapshot to a local file and add a sparkline per item.
5. **More marketplaces**: CSFloat and Buff163 require auth/API keys; Steam Market has an unauthenticated priceoverview endpoint but is heavily rate limited, so fetch it lazily per-item, server side, and cache aggressively.
6. **Float/pattern data**: show float value where DMarket provides it in item `extra` fields.

## Style and preferences (keep these)
- Keep the existing dark CS2-styled UI, Chakra Petch + IBM Plex Sans fonts, rarity-color deal grading, and the wear-bar style deal meter.
- No em dashes anywhere in copy or docs. No semicolons in user-facing text.
- Keep it dependency-light. Express only unless something genuinely requires more.
- Respect API rate limits, especially Skinport's 5-minute rule. Never remove the cache.
- Prices in USD. Every price shown must link to the actual live listing.

## Definition of done for the first session
Status bar shows LIVE with both sources, images render, filters and sorts work against real data, and clicking any price opens the correct marketplace listing.
