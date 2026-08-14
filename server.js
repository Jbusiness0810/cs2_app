// CS2 Deal Finder server
// Proxies and merges live prices from DMarket and Skinport, caches for 5 minutes.
// Node 18+ required (global fetch). MOCK_DATA=1 serves bundled fixtures instead
// of hitting the live APIs (useful in environments where they are unreachable).

const express = require('express');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const MOCK = process.env.MOCK_DATA === '1';

const CACHE_TTL_MS = 5 * 60 * 1000; // Skinport allows ~1 request per 5 min per IP. Never lower this.
let cache = { at: 0, payload: null };

const DMARKET_PAGES = 3;
const DMARKET_URL =
  'https://api.dmarket.com/exchange/v1/market/items' +
  '?gameId=a8db&currency=USD&limit=100&orderBy=best_discount&orderDir=desc';
const SKINPORT_URL = 'https://api.skinport.com/v1/items?app_id=730&currency=USD';

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'cs2-deal-finder/1.0', ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Node's fetch auto-decompresses encodings it knows. Older Node 18 builds do
  // not decode Brotli, so if plain parsing fails try a manual Brotli pass.
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return JSON.parse(zlib.brotliDecompressSync(buf).toString('utf8'));
  }
}

// DMarket prices arrive as cents, sometimes as strings. Returns dollars or null.
function centsToUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 100;
}

async function fetchDMarket() {
  const items = [];
  let cursor = null;
  for (let page = 0; page < DMARKET_PAGES; page++) {
    const url = cursor ? `${DMARKET_URL}&cursor=${encodeURIComponent(cursor)}` : DMARKET_URL;
    const data = await fetchJson(url);
    const objects = Array.isArray(data.objects) ? data.objects : [];
    for (const o of objects) {
      const title = o.title || o.marketHashName;
      const price = centsToUsd(o.price && (o.price.USD ?? o.price.usd));
      if (!title || price === null) continue;
      items.push({
        name: title,
        price,
        suggested: centsToUsd(o.suggestedPrice && (o.suggestedPrice.USD ?? o.suggestedPrice.usd)),
        image: o.image || null,
        float: o.extra && Number.isFinite(Number(o.extra.floatValue)) ? Number(o.extra.floatValue) : null,
        url: `https://dmarket.com/ingame-items/item-list/csgo-skins?title=${encodeURIComponent(title)}`,
      });
    }
    cursor = data.cursor ?? (data.paging && data.paging.cursor) ?? null;
    if (!cursor || objects.length === 0) break;
  }
  return items;
}

async function fetchSkinport() {
  // Skinport requires Brotli accept-encoding and rate limits to ~1 request
  // per 5 minutes per IP. The cache above is what keeps us compliant.
  const data = await fetchJson(SKINPORT_URL, { 'Accept-Encoding': 'br' });
  if (!Array.isArray(data)) throw new Error('Skinport response is not an array');
  const items = [];
  for (const o of data) {
    const name = o.market_hash_name;
    const price = Number(o.min_price);
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    const suggested = Number(o.suggested_price);
    items.push({
      name,
      price,
      suggested: Number.isFinite(suggested) && suggested > 0 ? suggested : null,
      image: null, // Skinport's public API has no images
      float: null,
      url:
        o.item_page ||
        o.market_page ||
        `https://skinport.com/market?search=${encodeURIComponent(name)}`,
      quantity: Number.isFinite(Number(o.quantity)) ? Number(o.quantity) : null,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Mock mode: same merge pipeline, data comes from bundled fixtures that match
// the documented response shapes of both APIs.
// ---------------------------------------------------------------------------

function readFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'tests', 'fixtures', file), 'utf8'));
}

async function fetchDMarketMock() {
  const data = readFixture('dmarket.json');
  return data.objects.map((o) => ({
    name: o.title,
    price: centsToUsd(o.price.USD),
    suggested: centsToUsd(o.suggestedPrice && o.suggestedPrice.USD),
    image: o.image || null,
    float: o.extra && Number.isFinite(Number(o.extra.floatValue)) ? Number(o.extra.floatValue) : null,
    url: `https://dmarket.com/ingame-items/item-list/csgo-skins?title=${encodeURIComponent(o.title)}`,
  }));
}

async function fetchSkinportMock() {
  const data = readFixture('skinport.json');
  return data
    .filter((o) => o.min_price !== null)
    .map((o) => ({
      name: o.market_hash_name,
      price: Number(o.min_price),
      suggested: o.suggested_price ? Number(o.suggested_price) : null,
      image: null,
      float: null,
      url: o.item_page || `https://skinport.com/market?search=${encodeURIComponent(o.market_hash_name)}`,
      quantity: o.quantity ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Merge: exact name match across sources, cheapest source wins, discount is
// computed against suggested price with a fallback to the highest listed price.
// ---------------------------------------------------------------------------

function mergeSources(dmarketItems, skinportItems) {
  const byName = new Map();

  const add = (source, item) => {
    let entry = byName.get(item.name);
    if (!entry) {
      entry = { name: item.name, image: null, float: null, sources: {} };
      byName.set(item.name, entry);
    }
    // Keep the cheapest listing per source if a name repeats within one source
    const existing = entry.sources[source];
    if (!existing || item.price < existing.price) {
      entry.sources[source] = { price: item.price, url: item.url, suggested: item.suggested };
    }
    if (item.image && !entry.image) entry.image = item.image;
    if (item.float !== null && entry.float === null) entry.float = item.float;
  };

  for (const it of dmarketItems) add('dmarket', it);
  for (const it of skinportItems) add('skinport', it);

  const items = [];
  for (const entry of byName.values()) {
    const listings = Object.entries(entry.sources).map(([source, s]) => ({ source, ...s }));
    listings.sort((a, b) => a.price - b.price);
    const best = listings[0];
    const highestListed = listings[listings.length - 1].price;

    const suggested =
      listings.map((l) => l.suggested).find((s) => s !== null && s !== undefined) ?? null;
    const reference = suggested ?? highestListed;
    const discount = reference > 0 ? Math.max(0, ((reference - best.price) / reference) * 100) : 0;

    const spread =
      listings.length > 1 ? listings[listings.length - 1].price - listings[0].price : 0;

    items.push({
      name: entry.name,
      image: entry.image,
      float: entry.float,
      bestPrice: best.price,
      bestSource: best.source,
      bestUrl: best.url,
      suggestedPrice: suggested,
      discount: Math.round(discount * 10) / 10,
      spread: Math.round(spread * 100) / 100,
      crossListed: listings.length > 1,
      listings: listings.map((l) => ({ source: l.source, price: l.price, url: l.url })),
    });
  }

  items.sort((a, b) => b.discount - a.discount);
  return items;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function buildPayload() {
  const [dm, sp] = await Promise.allSettled(
    MOCK ? [fetchDMarketMock(), fetchSkinportMock()] : [fetchDMarket(), fetchSkinport()]
  );

  if (dm.status === 'rejected') console.error('DMarket failed:', dm.reason.message);
  if (sp.status === 'rejected') console.error('Skinport failed:', sp.reason.message);

  const dmItems = dm.status === 'fulfilled' ? dm.value : [];
  const spItems = sp.status === 'fulfilled' ? sp.value : [];

  return {
    mock: MOCK,
    fetchedAt: new Date().toISOString(),
    sources: {
      dmarket: { ok: dm.status === 'fulfilled', count: dmItems.length, error: dm.status === 'rejected' ? dm.reason.message : null },
      skinport: { ok: sp.status === 'fulfilled', count: spItems.length, error: sp.status === 'rejected' ? sp.reason.message : null },
    },
    items: mergeSources(dmItems, spItems),
  };
}

app.get('/api/deals', async (req, res) => {
  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_TTL_MS) {
    return res.json({ ...cache.payload, cached: true });
  }
  try {
    const payload = await buildPayload();
    // Only refresh the cache clock when at least one source answered, so a
    // total outage retries on the next request instead of caching emptiness
    if (payload.sources.dmarket.ok || payload.sources.skinport.ok) {
      cache = { at: now, payload };
    }
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error('deal build failed:', err);
    if (cache.payload) return res.json({ ...cache.payload, cached: true, stale: true });
    res.status(502).json({ error: 'Both marketplace sources are unavailable right now' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`CS2 Deal Finder running at http://localhost:${PORT}${MOCK ? ' (mock data mode)' : ''}`);
});
