import { startServer } from '../server/server.js';

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function testEndpoints() {
  const testPort = 3088;
  console.log(`Starting isolated test server on port ${testPort}...`);
  const instance = await startServer(testPort);

  try {
    console.log(`Testing server endpoints on http://localhost:${testPort} ...`);

    // 1. Test /api/settings
    const settings = await fetchJson(`http://localhost:${testPort}/api/settings`);
    console.log('  /api/settings:', settings);

    // 2. Test /api/search?q=ubuntu
    const search = await fetchJson(`http://localhost:${testPort}/api/search?q=ubuntu`);
    console.log(`  /api/search?q=ubuntu: found ${search.total} results (${search.instantCount} instant cached)`);

    // 3. Test /api/magnet/check-cache
    const cache = await fetchJson(`http://localhost:${testPort}/api/magnet/check-cache`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnets: '842783e3005495d5d1637f5364b59343c7844707' }),
    });
    console.log('  /api/magnet/check-cache:', cache);

    console.log('✅ ALL SERVER REST ENDPOINTS TESTED OK!');
  } finally {
    await new Promise((resolve) => instance.server.close(resolve));
    console.log('Test server shut down cleanly.');
  }
}

testEndpoints().catch((err) => {
  console.error('❌ Endpoint test failed:', err);
  process.exit(1);
});

