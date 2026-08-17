import http from 'http';

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function testEndpoints() {
  console.log('Testing server endpoints on http://localhost:3000 ...');

  // 1. Test /api/settings
  const settings = await fetchJson('http://localhost:3000/api/settings');
  console.log('  /api/settings:', settings);

  // 2. Test /api/search?q=ubuntu
  const search = await fetchJson('http://localhost:3000/api/search?q=ubuntu');
  console.log(`  /api/search?q=ubuntu: found ${search.total} results (${search.instantCount} instant cached)`);

  // 3. Test /api/magnet/check-cache
  const cache = await fetchJson('http://localhost:3000/api/magnet/check-cache', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ magnets: '842783e3005495d5d1637f5364b59343c7844707' }),
  });
  console.log('  /api/magnet/check-cache:', cache);

  console.log('✅ ALL SERVER REST ENDPOINTS TESTED OK!');
}

testEndpoints().catch((err) => {
  console.error('❌ Endpoint test failed:', err);
  process.exit(1);
});
