// Smoke test: boots the server in mock mode and asserts the /api/deals shape
// and merge logic against the bundled fixtures. Run with: npm test

const { spawn } = require('child_process');
const path = require('path');

const PORT = 3177;
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, MOCK_DATA: '1', PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});

function fail(msg) {
  console.error('FAIL:', msg);
  server.kill();
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/deals`);
      if (res.ok) return res;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  fail('server did not start');
}

(async () => {
  const res = await waitForServer();
  const data = await res.json();

  assert(data.mock === true, 'expected mock mode');
  assert(data.sources.dmarket.ok && data.sources.skinport.ok && data.sources.csfloat.ok,
    'all three sources should be ok in mock mode');
  assert(Array.isArray(data.items) && data.items.length > 0, 'items should be a non-empty array');

  for (const it of data.items) {
    assert(typeof it.name === 'string' && it.name, `item missing name`);
    assert(typeof it.bestPrice === 'number' && it.bestPrice > 0, `${it.name}: bad bestPrice`);
    assert(['dmarket', 'skinport', 'csfloat'].includes(it.bestSource), `${it.name}: bad bestSource`);
    assert(typeof it.bestUrl === 'string' && it.bestUrl.startsWith('http'), `${it.name}: bad bestUrl`);
    assert(typeof it.discount === 'number' && it.discount >= 0, `${it.name}: bad discount`);
    assert(Array.isArray(it.listings) && it.listings.length >= 1, `${it.name}: bad listings`);
    for (const l of it.listings) {
      assert(l.url && l.url.startsWith('http'), `${it.name}: listing without url`);
    }
  }

  // Three-way merge: AK-47 Redline FT exists in all three fixtures,
  // CSFloat at 51.75 vs DMarket 52.50 vs Skinport 54.90, so CSFloat wins
  const ak = data.items.find((i) => i.name === 'AK-47 | Redline (Field-Tested)');
  assert(ak, 'AK-47 Redline should be present');
  assert(ak.crossListed === true && ak.listings.length === 3, 'AK-47 Redline should be listed on all three sources');
  assert(ak.bestSource === 'csfloat' && ak.bestPrice === 51.75, `AK-47 best should be csfloat at 51.75, got ${ak.bestSource} at ${ak.bestPrice}`);
  assert(Math.abs(ak.spread - 3.15) < 0.001, `AK-47 spread should be 3.15, got ${ak.spread}`);
  assert(Math.abs(ak.discount - 32.4) < 0.1, `AK-47 discount should be ~32.4 (vs csfloat predicted 76.50), got ${ak.discount}`);
  assert(ak.image, 'AK-47 should carry an image');

  // Reference rows come from the csgotrader fixture with listing links
  assert(ak.refs.length === 2, `AK-47 should have Steam and Buff163 reference rows, got ${JSON.stringify(ak.refs)}`);
  const steamRef = ak.refs.find((r) => r.label === 'Steam');
  assert(steamRef && steamRef.price === 55.2 && steamRef.url.includes('steamcommunity.com/market/listings/730/'),
    `AK-47 Steam ref wrong: ${JSON.stringify(steamRef)}`);

  // No-suggested-price fallback: USP-S Kill Confirmed has no marketplace
  // suggested price, so the Buff163 reference (68.00) drives the discount
  const usp = data.items.find((i) => i.name === 'USP-S | Kill Confirmed (Field-Tested)');
  assert(usp, 'USP-S should be present');
  assert(Math.abs(usp.discount - 10.3) < 0.1, `USP-S discount should be ~10.3 vs Buff163 68, got ${usp.discount}`);

  // Rarity comes from the catalog fixture
  assert(ak.rarity === 'Classified' && ak.rarityColor === '#d32ce6',
    `AK-47 rarity should be Classified #d32ce6, got ${ak.rarity} ${ak.rarityColor}`);
  const gloves2 = data.items.find((i) => i.name === "Sport Gloves | Pandora's Box (Field-Tested)");
  assert(gloves2.rarity === 'Extraordinary', `Gloves rarity should be Extraordinary, got ${gloves2.rarity}`);

  // CSFloat-only item carries its float value and links to csfloat
  const kara = data.items.find((i) => i.name === 'Karambit | Tiger Tooth (Factory New)');
  assert(kara, 'Karambit should be present');
  assert(kara.bestSource === 'csfloat' && kara.float === 0.018, `Karambit should be csfloat with float 0.018, got ${JSON.stringify({ s: kara.bestSource, f: kara.float })}`);
  assert(kara.bestUrl === 'https://csfloat.com/item/cf-002', `Karambit url wrong: ${kara.bestUrl}`);

  // Skinport-only item has no image and links to its item page
  const gloves = data.items.find((i) => i.name === "Sport Gloves | Pandora's Box (Field-Tested)");
  assert(gloves, 'Sport Gloves should be present');
  assert(gloves.image === null, 'Skinport-only item should have no image');
  assert(gloves.bestUrl.includes('skinport.com'), 'Skinport item should link to skinport');

  // Popularity: AK-47 has 811 sales in the 7-day fixture window, top tier
  assert(ak.popularity && ak.popularity.score === 5 && ak.popularity.basis === 'sales',
    `AK-47 popularity should be 5/sales, got ${JSON.stringify(ak.popularity)}`);
  assert(ak.popularity.volume7d === 811, `AK-47 volume7d should be 811, got ${ak.popularity.volume7d}`);

  // Items without sales history fall back to the listings-count signal
  const p250 = data.items.find((i) => i.name === 'P250 | See Ya Later (Field-Tested)');
  assert(p250, 'P250 should be present');
  assert(p250.popularity.basis === 'listings' && p250.popularity.score === 3,
    `P250 popularity should be 3/listings (150 listed), got ${JSON.stringify(p250.popularity)}`);

  // Unlisted items (null min_price) are excluded
  assert(!data.items.find((i) => i.name.includes('Nuclear Threat')), 'null min_price items should be excluded');

  // Sorted by discount descending by default
  for (let i = 1; i < data.items.length; i++) {
    assert(data.items[i - 1].discount >= data.items[i].discount, 'items should be sorted by discount desc');
  }

  // Cache: second request should be served from cache
  const res2 = await fetch(`http://localhost:${PORT}/api/deals`);
  const data2 = await res2.json();
  assert(data2.cached === true, 'second request should hit the cache');

  // Item cap: with MAX_ITEMS=5 the list is capped but every cross-listed
  // item survives the cut
  const CAP_PORT = PORT + 1;
  const capServer = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, MOCK_DATA: '1', PORT: String(CAP_PORT), MAX_ITEMS: '5' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    let capData = null;
    for (let i = 0; i < 40 && !capData; i++) {
      try {
        const r = await fetch(`http://localhost:${CAP_PORT}/api/deals`);
        if (r.ok) capData = await r.json();
      } catch {}
      if (!capData) await new Promise((r) => setTimeout(r, 250));
    }
    assert(capData, 'capped server did not start');
    assert(capData.items.length === 5, `capped list should have 5 items, got ${capData.items.length}`);
    assert(capData.totalBeforeCap === data.items.length, `totalBeforeCap should be ${data.items.length}, got ${capData.totalBeforeCap}`);
    const crossListedNames = data.items.filter((i) => i.crossListed).map((i) => i.name);
    for (const name of crossListedNames) {
      assert(capData.items.find((i) => i.name === name), `cross-listed ${name} should survive the cap`);
    }
  } finally {
    capServer.kill();
  }

  console.log(`PASS: ${data.items.length} merged items, all assertions ok`);
  server.kill();
  process.exit(0);
})().catch((e) => fail(e.stack));
