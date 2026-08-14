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

const CACHE_TTL_MS = 5 * 60 * 1000; // Skinport allows few requests per 5 min per IP. Never lower this.
const HISTORY_TTL_MS = 30 * 60 * 1000; // sales volume moves slowly, refresh sparingly
const IMAGES_TTL_MS = 24 * 60 * 60 * 1000;
let cache = { at: 0, payload: null };
let historyCache = { at: 0, volumes: null };
let imageMap = { at: 0, map: null, loading: null };

const DMARKET_PAGES = 3;
const DMARKET_PAGE_SIZE = 100;
// DMarket retired /exchange/v1/market/items (HTTP 410). Their swagger now
// documents /offers/v1/search on the dmarket.com host, with the older
// /offers-search/v1/search still answering as a deprecated alias. Try the
// current one first and fall through, keeping the retired one last in case
// a mirror still serves it.
const DMARKET_ENDPOINTS = [
  {
    name: 'offers/v1/search',
    url: (page) =>
      `https://dmarket.com/offers/v1/search?gameId=a8db&currency=USD&limit=${DMARKET_PAGE_SIZE}&offset=${page * DMARKET_PAGE_SIZE}&orderBy=updated&orderDir=desc`,
  },
  {
    name: 'offers-search/v1/search',
    url: (page) =>
      `https://dmarket.com/offers-search/v1/search?gameId=a8db&currency=USD&limit=${DMARKET_PAGE_SIZE}&offset=${page * DMARKET_PAGE_SIZE}&orderBy=updated&orderDir=desc`,
  },
  {
    name: 'exchange/v1/market/items',
    url: (page, cursor) =>
      `https://api.dmarket.com/exchange/v1/market/items?gameId=a8db&currency=USD&limit=${DMARKET_PAGE_SIZE}&orderBy=best_discount&orderDir=desc` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
    cursorPaged: true,
  },
];
const SKINPORT_ITEMS_URL = 'https://api.skinport.com/v1/items?app_id=730&currency=USD';
const SKINPORT_HISTORY_URL = 'https://api.skinport.com/v1/sales/history?app_id=730&currency=USD';

// market_hash_name to Steam CDN image mapping, so Skinport-only items still
// get pictures (Skinport's public API has no images). Handoff improvement #2.
const IMAGE_DATASETS = [
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/stickers.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/agents.json',
];

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'cs2-deal-finder/1.0', ...headers },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    // Surface the body: DMarket's 410 responses carry migration instructions
    const snippet = buf.toString('utf8').slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}${snippet ? ` | body: ${snippet}` : ''}`);
  }
  // Node's fetch auto-decompresses encodings it knows. Older Node 18 builds do
  // not decode Brotli, so if plain parsing fails try a manual Brotli pass.
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return JSON.parse(zlib.brotliDecompressSync(buf).toString('utf8'));
  }
}

// DMarket money values arrive in several shapes across API generations:
// {"USD":"1234"} cents, {"amount":1234} cents, "1234" cents, "12.34" dollars,
// or plain numbers. Returns dollars or null.
function parseMoney(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    return parseMoney(value.USD ?? value.usd ?? value.amount ?? value.Amount);
  }
  if (typeof value === 'string') {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return value.includes('.') ? n : n / 100;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Number.isInteger(value) ? value / 100 : value;
  }
  return null;
}

function dmarketLink(title) {
  return `https://dmarket.com/ingame-items/item-list/csgo-skins?title=${encodeURIComponent(title)}`;
}

// Normalize one raw DMarket object regardless of which endpoint produced it
function normalizeDMarketObject(o) {
  const title = o.title || o.marketHashName || o.name;
  const price = parseMoney(o.price ?? o.cheapestOfferPrice ?? o.minPrice);
  if (!title || price === null) return null;
  return {
    name: title,
    price,
    suggested: parseMoney(o.suggestedPrice ?? o.recommendedPrice),
    image: o.image || o.imageUrl || null,
    float:
      o.extra && Number.isFinite(Number(o.extra.floatValue)) ? Number(o.extra.floatValue) : null,
    listingsCount: Number.isFinite(Number(o.totalSellOffers)) ? Number(o.totalSellOffers) : null,
    url: dmarketLink(title),
  };
}

async function fetchDMarket() {
  const errors = [];
  for (const ep of DMARKET_ENDPOINTS) {
    try {
      const items = [];
      let cursor = null;
      let sampleLogged = false;
      for (let page = 0; page < DMARKET_PAGES; page++) {
        const data = await fetchJson(ep.url(page, cursor));
        const objects = Array.isArray(data.objects) ? data.objects : Array.isArray(data.items) ? data.items : [];
        if (objects.length && !sampleLogged) {
          sampleLogged = true;
          console.log(`DMarket via ${ep.name}, sample object: ${JSON.stringify(objects[0]).slice(0, 400)}`);
        }
        for (const o of objects) {
          const it = normalizeDMarketObject(o);
          if (it) items.push(it);
        }
        if (ep.cursorPaged) {
          cursor = data.cursor ?? (data.paging && data.paging.cursor) ?? null;
          if (!cursor) break;
        }
        if (objects.length < DMARKET_PAGE_SIZE) break;
      }
      if (items.length > 0) return items;
      errors.push(`${ep.name}: 0 items`);
    } catch (err) {
      errors.push(`${ep.name}: ${err.message}`);
    }
  }
  throw new Error(errors.join(' || '));
}

async function fetchSkinport() {
  // Skinport requires Brotli accept-encoding and rate limits aggressively.
  // The caches above keep us at roughly 1 items request and at most 1 history
  // request per 5 minute window.
  const data = await fetchJson(SKINPORT_ITEMS_URL, { 'Accept-Encoding': 'br' });
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
      image: null,
      float: null,
      listingsCount: Number.isFinite(Number(o.quantity)) ? Number(o.quantity) : null,
      url:
        o.item_page ||
        o.market_page ||
        `https://skinport.com/market?search=${encodeURIComponent(name)}`,
    });
  }
  return items;
}

// Skinport 7-day sales volume per item name, cached for 30 minutes.
// Soft-fails to null so a hiccup here never blocks the deal list.
async function getSalesVolumes() {
  const now = Date.now();
  if (historyCache.volumes && now - historyCache.at < HISTORY_TTL_MS) return historyCache.volumes;
  try {
    const data = MOCK
      ? readFixture('skinport_history.json')
      : await fetchJson(SKINPORT_HISTORY_URL, { 'Accept-Encoding': 'br' });
    const volumes = new Map();
    for (const o of data) {
      if (!o.market_hash_name) continue;
      const v7 = o.last_7_days && Number(o.last_7_days.volume);
      const v24 = o.last_24_hours && Number(o.last_24_hours.volume);
      volumes.set(o.market_hash_name, {
        volume7d: Number.isFinite(v7) ? v7 : null,
        volume24h: Number.isFinite(v24) ? v24 : null,
      });
    }
    historyCache = { at: now, volumes };
    return volumes;
  } catch (err) {
    console.error('Skinport sales history failed:', err.message);
    return historyCache.volumes || new Map();
  }
}

// market_hash_name to image URL map, loaded lazily, refreshed daily.
// Soft-fails to an empty map, cards then show the NO PREVIEW placeholder.
async function getImageMap() {
  const now = Date.now();
  if (imageMap.map && now - imageMap.at < IMAGES_TTL_MS) return imageMap.map;
  if (imageMap.loading) return imageMap.loading;
  const loading = (async () => {
    const map = new Map();
    if (!MOCK) {
      for (const url of IMAGE_DATASETS) {
        try {
          const data = await fetchJson(url);
          for (const o of Array.isArray(data) ? data : Object.values(data)) {
            if (o && o.market_hash_name && o.image) map.set(o.market_hash_name, o.image);
          }
        } catch (err) {
          console.error(`image dataset failed (${url.split('/').pop()}):`, err.message);
        }
      }
      if (map.size) console.log(`image map loaded, ${map.size} names`);
    }
    imageMap = { at: Date.now(), map, loading: null };
    return map;
  })();
  imageMap.loading = loading;
  return loading;
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
  return data.objects.map(normalizeDMarketObject).filter(Boolean);
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
      listingsCount: o.quantity ?? null,
      url: o.item_page || `https://skinport.com/market?search=${encodeURIComponent(o.market_hash_name)}`,
    }));
}

// ---------------------------------------------------------------------------
// Merge: exact name match across sources, cheapest source wins, discount is
// computed against suggested price with a fallback to the highest listed price.
// ---------------------------------------------------------------------------

// 0 to 5 popularity from 7-day sales volume, with total listing count as a
// weaker fallback signal when volume data is missing for an item
function popularityFor(volume7d, listings) {
  if (volume7d !== null && volume7d !== undefined) {
    const score =
      volume7d >= 500 ? 5 : volume7d >= 150 ? 4 : volume7d >= 40 ? 3 : volume7d >= 10 ? 2 : volume7d > 0 ? 1 : 0;
    return { score, basis: 'sales', volume7d };
  }
  if (listings !== null && listings > 0) {
    const score = listings >= 500 ? 4 : listings >= 100 ? 3 : listings >= 25 ? 2 : 1;
    return { score, basis: 'listings', listings };
  }
  return { score: 0, basis: 'none' };
}

function mergeSources(dmarketItems, skinportItems, volumes, images) {
  const byName = new Map();

  const add = (source, item) => {
    let entry = byName.get(item.name);
    if (!entry) {
      entry = { name: item.name, image: null, float: null, listings: 0, sources: {} };
      byName.set(item.name, entry);
    }
    // Keep the cheapest listing per source if a name repeats within one source
    const existing = entry.sources[source];
    if (!existing || item.price < existing.price) {
      entry.sources[source] = { price: item.price, url: item.url, suggested: item.suggested };
    }
    if (item.image && !entry.image) entry.image = item.image;
    if (item.float !== null && entry.float === null) entry.float = item.float;
    if (item.listingsCount) entry.listings += item.listingsCount;
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

    const vol = volumes.get(entry.name);
    const popularity = popularityFor(vol ? vol.volume7d : null, entry.listings || null);

    items.push({
      name: entry.name,
      image: entry.image || images.get(entry.name) || null,
      float: entry.float,
      bestPrice: best.price,
      bestSource: best.source,
      bestUrl: best.url,
      suggestedPrice: suggested,
      discount: Math.round(discount * 10) / 10,
      spread: Math.round(spread * 100) / 100,
      crossListed: listings.length > 1,
      popularity,
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
  const [dm, sp, volumes, images] = await Promise.allSettled([
    MOCK ? fetchDMarketMock() : fetchDMarket(),
    MOCK ? fetchSkinportMock() : fetchSkinport(),
    getSalesVolumes(),
    getImageMap(),
  ]);

  if (dm.status === 'rejected') console.error('DMarket failed:', dm.reason.message);
  if (sp.status === 'rejected') console.error('Skinport failed:', sp.reason.message);

  const dmItems = dm.status === 'fulfilled' ? dm.value : [];
  const spItems = sp.status === 'fulfilled' ? sp.value : [];
  const vols = volumes.status === 'fulfilled' ? volumes.value : new Map();
  const imgs = images.status === 'fulfilled' ? images.value : new Map();

  return {
    mock: MOCK,
    fetchedAt: new Date().toISOString(),
    sources: {
      dmarket: { ok: dm.status === 'fulfilled', count: dmItems.length, error: dm.status === 'rejected' ? dm.reason.message : null },
      skinport: { ok: sp.status === 'fulfilled', count: spItems.length, error: sp.status === 'rejected' ? sp.reason.message : null },
    },
    items: mergeSources(dmItems, spItems, vols, imgs),
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
  if (!MOCK) getImageMap(); // start warming the image map right away
});
