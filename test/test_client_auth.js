import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('const TOKEN_STORAGE_KEY =');
const end = source.indexOf('function showTokenModal()', start);
assert.ok(start >= 0 && end > start, 'Authentication helpers must be present');

function createClient({ storedToken = 'stale-fixture-token', status = 200, storageThrows = false } = {}) {
  const requests = [];
  let modalCount = 0;
  const context = vm.createContext({
    Headers,
    localStorage: {
      getItem() {
        if (storageThrows) throw new Error('Storage unavailable');
        return storedToken;
      },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { status };
    },
    showTokenModal: () => { modalCount++; },
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    fetch: context.apiFetch,
    requests,
    modalCount: () => modalCount,
  };
}

for (const [label, headers] of [
  ['object', { Authorization: 'Bearer replacement-fixture-token' }],
  ['lowercase object', { authorization: 'Bearer replacement-fixture-token' }],
  ['Headers instance', new Headers({ Authorization: 'Bearer replacement-fixture-token' })],
  ['header tuples', [['Authorization', 'Bearer replacement-fixture-token']]],
]) {
  test(`explicit token overrides stale storage with ${label}`, async () => {
    const client = createClient();
    await client.fetch('/api/auth-check', { headers });
    const request = client.requests[0];
    assert.equal(request.url, '/api/auth-check');
    assert.equal(new Headers(request.options.headers).get('authorization'), 'Bearer replacement-fixture-token');
    assert.equal(client.modalCount(), 0);
  });
}

test('stored token is a fallback without mutating caller headers or options', async () => {
  const client = createClient();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const options = { method: 'POST', body: '{}', headers };
  await client.fetch('/api/downloads/add', options);
  const request = client.requests[0];
  assert.equal(request.url, '/api/downloads/add');
  assert.equal(new Headers(request.options.headers).get('authorization'), 'Bearer stale-fixture-token');
  assert.equal(new Headers(request.options.headers).get('content-type'), 'application/json');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body, '{}');
  assert.equal(headers.has('authorization'), false);
  assert.equal(options.headers, headers);
});

test('explicit empty authorization is not replaced by stored credentials', async () => {
  const client = createClient();
  await client.fetch('/api/auth-check', { headers: { Authorization: '' } });
  assert.equal(new Headers(client.requests[0].options.headers).get('authorization'), '');
});

test('missing or inaccessible storage does not attach credentials', async () => {
  for (const options of [{ storedToken: '' }, { storageThrows: true }]) {
    const client = createClient(options);
    await client.fetch('/api/auth-check');
    assert.equal(new Headers(client.requests[0].options.headers).has('authorization'), false);
    assert.equal(client.requests[0].url, '/api/auth-check');
  }
});

test('unauthorized responses still open the token modal and reject', async () => {
  const client = createClient({ status: 401 });
  await assert.rejects(client.fetch('/api/settings'), /Unauthorized: valid access token required/);
  assert.equal(client.modalCount(), 1);
});
