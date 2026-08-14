// Build-time data precompute for serverless deploys (and faster local starts).
// Fetches the big upstream datasets once and reduces them to two small files:
//   data/image-map.json         market_hash_name -> image URL
//   data/reference-prices.json  market_hash_name -> { steam, buff }
// The server loads these from disk when present instead of fetching tens of
// megabytes at runtime, which serverless cold starts cannot afford.
// Partial failure is fine: whatever was fetched gets written, the server
// falls back to runtime fetching for anything missing.

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data');

const IMAGE_DATASETS = [
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/stickers.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/agents.json',
];
const CSGOTRADER_URL = 'https://prices.csgotrader.app/latest/prices_v6.json';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'cs2-deal-finder-build/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

async function buildImageMap() {
  const map = {};
  let sources = 0;
  for (const url of IMAGE_DATASETS) {
    try {
      const data = await fetchJson(url);
      let added = 0;
      for (const o of Array.isArray(data) ? data : Object.values(data)) {
        if (o && o.market_hash_name && o.image && !map[o.market_hash_name]) {
          map[o.market_hash_name] = o.image;
          added++;
        }
      }
      sources++;
      console.log(`  ${url.split('/').pop()}: ${added} names`);
    } catch (err) {
      console.error(`  ${url.split('/').pop()} FAILED: ${err.message}`);
    }
  }
  if (sources === 0) return null;
  return map;
}

async function buildReferencePrices() {
  try {
    const data = await fetchJson(CSGOTRADER_URL);
    const map = {};
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
      if (entry.steam || entry.buff) map[name] = entry;
    }
    console.log(`  reference prices: ${Object.keys(map).length} names`);
    return map;
  } catch (err) {
    console.error(`  csgotrader FAILED: ${err.message}`);
    return null;
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('building image map...');
  const images = await buildImageMap();
  if (images) {
    fs.writeFileSync(path.join(OUT_DIR, 'image-map.json'), JSON.stringify(images));
    console.log(`wrote data/image-map.json (${Object.keys(images).length} names)`);
  } else {
    console.error('image map skipped, server will fetch at runtime');
  }

  console.log('building reference prices...');
  const refs = await buildReferencePrices();
  if (refs) {
    fs.writeFileSync(path.join(OUT_DIR, 'reference-prices.json'), JSON.stringify(refs));
    console.log(`wrote data/reference-prices.json (${Object.keys(refs).length} names)`);
  } else {
    console.error('reference prices skipped, server will fetch at runtime');
  }
})();
