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
  assert(data.sources.dmarket.ok && data.sources.skinport.ok, 'both sources should be ok in mock mode');
  assert(Array.isArray(data.items) && data.items.length > 0, 'items should be a non-empty array');

  for (const it of data.items) {
    assert(typeof it.name === 'string' && it.name, `item missing name`);
    assert(typeof it.bestPrice === 'number' && it.bestPrice > 0, `${it.name}: bad bestPrice`);
    assert(['dmarket', 'skinport'].includes(it.bestSource), `${it.name}: bad bestSource`);
    assert(typeof it.bestUrl === 'string' && it.bestUrl.startsWith('http'), `${it.name}: bad bestUrl`);
    assert(typeof it.discount === 'number' && it.discount >= 0, `${it.name}: bad discount`);
    assert(Array.isArray(it.listings) && it.listings.length >= 1, `${it.name}: bad listings`);
    for (const l of it.listings) {
      assert(l.url && l.url.startsWith('http'), `${it.name}: listing without url`);
    }
  }

  // Cross-listed merge: AK-47 Redline FT exists in both fixtures,
  // DMarket at 52.50 vs Skinport at 54.90, so DMarket should win
  const ak = data.items.find((i) => i.name === 'AK-47 | Redline (Field-Tested)');
  assert(ak, 'AK-47 Redline should be present');
  assert(ak.crossListed === true, 'AK-47 Redline should be cross-listed');
  assert(ak.bestSource === 'dmarket' && ak.bestPrice === 52.5, `AK-47 best should be dmarket at 52.5, got ${ak.bestSource} at ${ak.bestPrice}`);
  assert(Math.abs(ak.spread - 2.4) < 0.001, `AK-47 spread should be 2.40, got ${ak.spread}`);
  assert(Math.abs(ak.discount - 32.7) < 0.1, `AK-47 discount should be ~32.7 (vs suggested 78), got ${ak.discount}`);
  assert(ak.image, 'AK-47 should carry the DMarket image');

  // No-suggested-price fallback: USP-S Kill Confirmed is DMarket-only with no
  // suggested price, single listing means reference = own price, discount 0
  const usp = data.items.find((i) => i.name === 'USP-S | Kill Confirmed (Field-Tested)');
  assert(usp, 'USP-S should be present');
  assert(usp.discount === 0, `USP-S discount should be 0, got ${usp.discount}`);

  // Skinport-only item has no image and links to its item page
  const gloves = data.items.find((i) => i.name === "Sport Gloves | Pandora's Box (Field-Tested)");
  assert(gloves, 'Sport Gloves should be present');
  assert(gloves.image === null, 'Skinport-only item should have no image');
  assert(gloves.bestUrl.includes('skinport.com'), 'Skinport item should link to skinport');

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

  console.log(`PASS: ${data.items.length} merged items, all assertions ok`);
  server.kill();
  process.exit(0);
})().catch((e) => fail(e.stack));
