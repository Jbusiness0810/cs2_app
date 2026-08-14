// CS2 Deal Finder server
// Proxies and merges live prices from DMarket, Skinport, and optionally
// CSFloat, enriched with CSGOTrader aggregated reference prices. Caches for
// 5 minutes. Node 18+ required (global fetch). MOCK_DATA=1 serves bundled
// fixtures instead of hitting the live APIs.

const express = require('express');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const MOCK = process.env.MOCK_DATA === '1';
const CSFLOAT_API_KEY = process.env.CSFLOAT_API_KEY || null;

const CACHE_TTL_MS = 5 * 60 * 1000; // Skinport allows few requests per 5 min per IP. Never lower this.
const HISTORY_TTL_MS = 30 * 60 * 1000; // sales volume moves slowly, refresh sparingly
const IMAGES_TTL_MS = 24 * 60 * 60 * 1000;
const REFERENCE_TTL_MS = 6 * 60 * 60 * 1000; // csgotrader updates a few times a day
let cache = { at: 0, payload: null };
let historyCache = { at: 0, volumes: null };
let imageMap = { at: 0, map: null, loading: null };
let referenceMap = { at: 0, map: null, loading: null };

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
const CSFLOAT_PAGES = 3;
const CSFLOAT_URL = (page, sortBy) =>
  `https://csfloat.com/api/v1/listings?page=${page}&limit=50&sort_by=${sortBy}`;
// Aggregated cross-market prices (Steam, Buff163 and more), no key needed
const CSGOTRADER_URL = 'https://prices.csgotrader.app/latest/prices_v6.json';

// market_hash_name to Steam CDN image mapping, so items without a marketplace
// image still get pictures. Handoff improvement #2.
const IMAGE_DATASETS = [
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/stickers.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/agents.json',
];

const STEAM_LISTING = (name) =>
  `https://steamcommunity.com/market/listings/730/${encodeURIComponent(name)}`;
const BUFF_SEARCH = (name) =>
  `https://buff.163.com/market/csgo#tab=selling&page_num=1&search=${encodeURIComponent(name)}`;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'cs2-deal-finder/1.0', ...headers },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    // Surface the body: API error responses often carry migration instructions
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

// Money values arrive in several shapes across APIs and API generations:
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

function centsToUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 100;
}

function dmarketLink(title) {
  return `https://dmarket.com/ingame-items/item-list/csgo-skins?title=${encodeURIComponent(title)}`;
}

// ---------------------------------------------------------------------------
// Source fetchers
// ---------------------------------------------------------------------------

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

// CSFloat is optional: set CSFLOAT_API_KEY to enable it as a third source.
// Prices are cents. The response has been a bare array historically and a
// {data: [...]} wrapper in newer versions, so accept both. sort_by=best_deal
// mirrors the best-discount intent, with lowest_price as a fallback.
function normalizeCSFloatListing(l) {
  const item = l.item || {};
  const name = item.market_hash_name || l.market_hash_name;
  const price = centsToUsd(l.price);
  if (!name || price === null) return null;
  const suggested = centsToUsd(l.reference && (l.reference.predicted_price ?? l.reference.base_price));
  const float = Number(item.float_value ?? l.float_value);
  return {
    name,
    price,
    suggested,
    image: item.icon_url
      ? `https://community.fastly.steamstatic.com/economy/image/${item.icon_url}`
      : null,
    float: Number.isFinite(float) ? float : null,
    listingsCount: null,
    url: l.id ? `https://csfloat.com/item/${l.id}` : `https://csfloat.com/search?market_hash_name=${encodeURIComponent(name)}`,
  };
}

async function fetchCSFloat() {
  const headers = { Authorization: CSFLOAT_API_KEY };
  const errors = [];
  for (const sortBy of ['best_deal', 'lowest_price']) {
    try {
      const items = [];
      let sampleLogged = false;
      for (let page = 0; page < CSFLOAT_PAGES; page++) {
        const data = await fetchJson(CSFLOAT_URL(page, sortBy), headers);
        const listings = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
        if (listings.length && !sampleLogged) {
          sampleLogged = true;
          console.log(`CSFloat via sort_by=${sortBy}, sample: ${JSON.stringify(listings[0]).slice(0, 400)}`);
        }
        for (const l of listings) {
          const it = normalizeCSFloatListing(l);
          if (it) items.push(it);
        }
        if (listings.length < 50) break;
      }
      if (items.length > 0) return items;
      errors.push(`sort_by=${sortBy}: 0 items`);
    } catch (err) {
      errors.push(`sort_by=${sortBy}: ${err.message}`);
    }
  }
  throw new Error(errors.join(' || '));
}

// ---------------------------------------------------------------------------
// Enrichment: sales volumes, reference prices, images
// ---------------------------------------------------------------------------

// Skinport 7-day sales volume per item name, cached for 30 minutes.
// Soft-fails so a hiccup here never blocks the deal list.
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

// CSGOTrader aggregated prices: one fetch covers Steam and Buff163 reference
// prices for the whole catalog, refreshed every 6 hours. This deliberately
// replaces per-item Steam priceoverview calls, which get IPs banned fast.
// Build-time snapshots (scripts/build-data.js) load from disk instantly.
// Serverless cold starts rely on these, and they speed local startup too.
function readPrebuilt(file) {
  try {
    const p = path.join(__dirname, 'data', file);
    if (!fs.existsSync(p)) return null;
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    const map = new Map(Object.entries(obj));
    return map.size ? map : null;
  } catch {
    return null;
  }
}

async function getReferencePrices() {
  const now = Date.now();
  if (referenceMap.map && now - referenceMap.at < REFERENCE_TTL_MS) return referenceMap.map;
  if (referenceMap.loading) return referenceMap.loading;
  if (!MOCK && !referenceMap.map) {
    const prebuilt = readPrebuilt('reference-prices.json');
    if (prebuilt) {
      // Treat the snapshot as always fresh: it refreshes on each deploy and
      // reference prices only move a few times a day anyway
      referenceMap = { at: Infinity, map: prebuilt, loading: null };
      console.log(`reference prices loaded from snapshot, ${prebuilt.size} names`);
      return prebuilt;
    }
  }
  const loading = (async () => {
    const map = new Map();
    try {
      const data = MOCK ? readFixture('csgotrader.json') : await fetchJson(CSGOTRADER_URL);
      for (const [name, p] of Object.entries(data)) {
        if (!p || typeof p !== 'object') continue;
        const steamRaw = p.steam || {};
        const steam = Number(
          steamRaw.last_24h ?? steamRaw.last_7d ?? steamRaw.last_30d ?? steamRaw.last_90d
        );
        const buffRaw = (p.buff163 && p.buff163.starting_at) || {};
        const buff = Number(buffRaw.price ?? buffRaw);
        const entry = {};
        if (Number.isFinite(steam) && steam > 0) entry.steam = steam;
        if (Number.isFinite(buff) && buff > 0) entry.buff = buff;
        if (entry.steam || entry.buff) map.set(name, entry);
      }
      if (map.size) console.log(`reference prices loaded, ${map.size} names`);
    } catch (err) {
      console.error('CSGOTrader reference prices failed:', err.message);
    }
    referenceMap = { at: Date.now(), map, loading: null };
    return map;
  })();
  referenceMap.loading = loading;
  return loading;
}

// market_hash_name to image URL map, loaded lazily, refreshed daily.
// Soft-fails to an empty map, cards then show the NO PREVIEW placeholder.
async function getImageMap() {
  const now = Date.now();
  if (imageMap.map && now - imageMap.at < IMAGES_TTL_MS) return imageMap.map;
  if (imageMap.loading) return imageMap.loading;
  if (!MOCK && !imageMap.map) {
    const prebuilt = readPrebuilt('image-map.json');
    if (prebuilt) {
      imageMap = { at: Infinity, map: prebuilt, loading: null };
      console.log(`image map loaded from snapshot, ${prebuilt.size} names`);
      return prebuilt;
    }
  }
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
// the documented response shapes of the APIs.
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

async function fetchCSFloatMock() {
  const data = readFixture('csfloat.json');
  return data.map(normalizeCSFloatListing).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Merge: exact name match across sources, cheapest source wins, discount is
// computed against the best reference price available.
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

function mergeSources(sourceItems, volumes, images, references) {
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

  for (const [source, items] of Object.entries(sourceItems)) {
    for (const it of items) add(source, it);
  }

  const items = [];
  for (const entry of byName.values()) {
    const listings = Object.entries(entry.sources).map(([source, s]) => ({ source, ...s }));
    listings.sort((a, b) => a.price - b.price);
    const best = listings[0];
    const highestListed = listings[listings.length - 1].price;

    const ref = references.get(entry.name) || {};
    // Discount reference, most trustworthy first: a marketplace suggested
    // price, then Buff163 (the de facto market benchmark), then Steam,
    // then the highest price the item is listed at anywhere
    const suggested =
      listings.map((l) => l.suggested).find((s) => s !== null && s !== undefined) ?? null;
    const reference = suggested ?? ref.buff ?? ref.steam ?? highestListed;
    const discount = reference > 0 ? Math.max(0, ((reference - best.price) / reference) * 100) : 0;

    const spread =
      listings.length > 1 ? listings[listings.length - 1].price - listings[0].price : 0;

    const vol = volumes.get(entry.name);
    const popularity = popularityFor(vol ? vol.volume7d : null, entry.listings || null);

    const refs = [];
    if (ref.steam) refs.push({ label: 'Steam', price: ref.steam, url: STEAM_LISTING(entry.name) });
    if (ref.buff) refs.push({ label: 'Buff163', price: ref.buff, url: BUFF_SEARCH(entry.name) });

    items.push({
      name: entry.name,
      image: entry.image || images.get(entry.name) || null,
      float: entry.float,
      bestPrice: best.price,
      bestSource: best.source,
      bestUrl: best.url,
      suggestedPrice: reference,
      discount: Math.round(discount * 10) / 10,
      spread: Math.round(spread * 100) / 100,
      crossListed: listings.length > 1,
      popularity,
      refs,
      listings: listings.map((l) => ({ source: l.source, price: l.price, url: l.url })),
    });
  }

  items.sort((a, b) => b.discount - a.discount);
  return items;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const CSFLOAT_ENABLED = MOCK || Boolean(CSFLOAT_API_KEY);

async function buildPayload() {
  const tasks = {
    dmarket: MOCK ? fetchDMarketMock() : fetchDMarket(),
    skinport: MOCK ? fetchSkinportMock() : fetchSkinport(),
    csfloat: CSFLOAT_ENABLED ? (MOCK ? fetchCSFloatMock() : fetchCSFloat()) : Promise.resolve([]),
  };
  const [dm, sp, cf, volumes, images, references] = await Promise.allSettled([
    tasks.dmarket,
    tasks.skinport,
    tasks.csfloat,
    getSalesVolumes(),
    getImageMap(),
    getReferencePrices(),
  ]);

  if (dm.status === 'rejected') console.error('DMarket failed:', dm.reason.message);
  if (sp.status === 'rejected') console.error('Skinport failed:', sp.reason.message);
  if (cf.status === 'rejected') console.error('CSFloat failed:', cf.reason.message);

  const sourceItems = {
    dmarket: dm.status === 'fulfilled' ? dm.value : [],
    skinport: sp.status === 'fulfilled' ? sp.value : [],
    csfloat: cf.status === 'fulfilled' ? cf.value : [],
  };
  const vols = volumes.status === 'fulfilled' ? volumes.value : new Map();
  const imgs = images.status === 'fulfilled' ? images.value : new Map();
  const refs = references.status === 'fulfilled' ? references.value : new Map();

  const sourceStatus = (settled, items, enabled = true) => ({
    enabled,
    ok: enabled && settled.status === 'fulfilled',
    count: items.length,
    error: enabled && settled.status === 'rejected' ? settled.reason.message : null,
  });

  return {
    mock: MOCK,
    fetchedAt: new Date().toISOString(),
    sources: {
      dmarket: sourceStatus(dm, sourceItems.dmarket),
      skinport: sourceStatus(sp, sourceItems.skinport),
      csfloat: sourceStatus(cf, sourceItems.csfloat, CSFLOAT_ENABLED),
    },
    referenceCount: refs.size,
    items: mergeSources(sourceItems, vols, imgs, refs),
  };
}

app.get('/api/deals', async (req, res) => {
  // On Vercel the CDN honors s-maxage, giving the 5 minute cache across
  // stateless invocations. Harmless for local single-process serving.
  res.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_TTL_MS) {
    return res.json({ ...cache.payload, cached: true });
  }
  try {
    const payload = await buildPayload();
    // Only refresh the cache clock when at least one source answered, so a
    // total outage retries on the next request instead of caching emptiness
    if (Object.values(payload.sources).some((s) => s.ok)) {
      cache = { at: now, payload };
    }
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error('deal build failed:', err);
    if (cache.payload) return res.json({ ...cache.payload, cached: true, stale: true });
    res.status(502).json({ error: 'All marketplace sources are unavailable right now' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Local: run the server directly. Vercel: api/index.js imports the app and
// each request is handled by a serverless invocation instead of listen()
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`CS2 Deal Finder running at http://localhost:${PORT}${MOCK ? ' (mock data mode)' : ''}`);
    if (!CSFLOAT_ENABLED) console.log('CSFloat disabled, set CSFLOAT_API_KEY to enable it as a third source');
    if (!MOCK) {
      getImageMap(); // start warming the image map right away
      getReferencePrices();
    }
  });
}

module.exports = app;
