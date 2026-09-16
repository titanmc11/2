import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApi } from '../server/api.mjs';

const validOrder = {
  language: 'ru', property: 'home', service: 'regular', sizeIndex: 0, extras: ['oven'],
  date: '2099-08-20', time: 'morning', address: 'Батуми, Руставели 10',
  name: 'Анна Клиент', phone: '+995 555 123 456', comment: 'Позвонить заранее', consent: true,
};

async function harness(t, { prepareDatabase, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'royal-orders-test-'));
  const dbPath = join(directory, 'private', 'bookings.sqlite');
  await mkdir(join(directory, 'private'));
  if (prepareDatabase) prepareDatabase(dbPath);
  let api;
  let server;
  let origin;
  async function start() {
    api = createApi({ dbPath, ...options });
    server = createServer(async (req, res) => {
      if (!await api.handle(req, res)) { res.writeHead(404); res.end('Static fallback'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    api.close();
  }
  await start();
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  return {
    get dbPath() { return dbPath; },
    async restart() { await stop(); await start(); },
    async request(path, { method = 'GET', body, headers = {}, rawBody } = {}) {
      const requestHeaders = { ...headers };
      if (method === 'POST') {
        for (const [key, value] of Object.entries({ 'Content-Type': 'application/json', Origin: origin, 'X-Royal-Request': '1' })) {
          if (!Object.hasOwn(requestHeaders, key)) requestHeaders[key] = value;
        }
      }
      for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === null) delete requestHeaders[key];
      const response = await fetch(origin + path, {
        method, headers: requestHeaders,
        ...(method === 'POST' ? { body: rawBody === undefined ? JSON.stringify(body ?? {}) : rawBody } : {}),
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data, headers: response.headers };
    },
  };
}

function storedRequests(dbPath) {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare('SELECT * FROM booking_requests ORDER BY created_at').all(); }
  finally { db.close(); }
}

test('guest order is accepted without a cookie, recalculates price, and persists after restart', async t => {
  const app = await harness(t);
  const created = await app.request('/api/orders', {
    method: 'POST', body: { ...validOrder, total: 1, estimate: 1, price: 1, userId: 'forged-account' },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data, { success: true, order: { id: created.data.order.id, total: 135, currency: 'GEL', status: 'pending' } });
  assert.equal(created.headers.get('set-cookie'), null);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  await app.restart();
  const stored = storedRequests(app.dbPath);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, created.data.order.id);
  assert.equal(stored[0].total, 135);
  assert.equal(stored[0].status, 'pending');
  const details = JSON.parse(stored[0].details);
  assert.equal(details.phone, '+995555123456');
  assert.equal(details.consent, true);
  assert.equal(Object.hasOwn(details, 'userId'), false);
  assert.equal(Object.hasOwn(details, 'price'), false);
  const db = new DatabaseSync(app.dbPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
    assert.deepEqual(tables, ['booking_requests']);
  } finally { db.close(); }
});

test('booking initialization preserves unrelated existing tables and their data', async t => {
  const existingTables = ['users', 'sessions', 'orders'];
  const app = await harness(t, {
    prepareDatabase(dbPath) {
      const db = new DatabaseSync(dbPath);
      try {
        for (const name of existingTables) {
          db.exec(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, existing_data TEXT NOT NULL)`);
          db.prepare(`INSERT INTO ${name} VALUES (?, ?)`).run('existing-id', 'Preserve existing data');
        }
      } finally { db.close(); }
    },
  });
  assert.equal((await app.request('/api/orders', { method: 'POST', body: validOrder })).status, 201);
  const db = new DatabaseSync(app.dbPath);
  try {
    for (const name of existingTables) {
      assert.deepEqual({ ...db.prepare(`SELECT * FROM ${name}`).get() }, { id: 'existing-id', existing_data: 'Preserve existing data' });
    }
  } finally { db.close(); }
});

test('orders are never publicly listed and removed account endpoints return 404', async t => {
  const app = await harness(t);
  assert.equal((await app.request('/api/orders', { method: 'POST', body: validOrder })).status, 201);
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
    const result = await app.request('/api/orders', { method });
    assert.equal(result.status, 405);
    assert.equal(result.headers.get('allow'), 'POST');
    if (method !== 'HEAD') assert.deepEqual(result.data, { error: 'METHOD_NOT_ALLOWED' });
    assert.equal(JSON.stringify(result.data).includes(validOrder.phone), false);
  }
  for (const endpoint of ['session', 'register', 'login', 'logout']) {
    for (const method of ['GET', 'POST']) {
      const result = await app.request('/api/auth/' + endpoint, { method });
      assert.equal(result.status, 404);
      assert.deepEqual(result.data, { error: 'API_NOT_FOUND' });
      assert.equal(result.headers.get('set-cookie'), null);
    }
  }
  assert.deepEqual((await app.request('/api/orders/private-id')).data, { error: 'API_NOT_FOUND' });
  assert.equal((await app.request('/index.html')).data, 'Static fallback');
});

test('guest booking validates dates, package extras, layout, contact fields and consent', async t => {
  const app = await harness(t, { trustedProxyIps: ['127.0.0.1'] });
  const failures = [
    [{ date: '2099-02-31' }, 'date'], [{ date: '2020-01-01' }, 'date'],
    [{ sizeIndex: '0' }, 'sizeIndex'], [{ sizeIndex: 8 }, 'sizeIndex'],
    [{ service: 'deep', extras: ['oven'] }, 'extras'], [{ extras: ['oven', 'oven'] }, 'extras'],
    [{ extras: ['unknown'] }, 'extras'], [{ property: 'office' }, 'service'],
    [{ phone: '+995 12' }, 'phone'], [{ consent: 'true' }, 'consent'],
    [{ address: ' ' }, 'address'], [{ name: '' }, 'name'], [{ language: 'xx' }, 'language'],
    [{ time: 'invalid' }, 'time'], [{ comment: 'x'.repeat(2001) }, 'comment'],
  ];
  for (const [index, [change, field]] of failures.entries()) {
    const result = await app.request('/api/orders', {
      method: 'POST', headers: { 'X-Forwarded-For': `198.51.100.${index + 1}` }, body: { ...validOrder, ...change },
    });
    assert.equal(result.status, 400, JSON.stringify(change));
    assert.deepEqual(result.data, { error: 'VALIDATION_ERROR', field });
  }
  assert.equal(storedRequests(app.dbPath).length, 0);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const result = await app.request('/api/orders', { method: 'POST', body: { ...validOrder, date: today } });
  assert.equal(result.status, 201);
});

test('mutations reject foreign or missing origin, missing custom header, non-JSON and oversized bodies', async t => {
  const app = await harness(t);
  for (const headers of [
    { Origin: null }, { Origin: 'https://attacker.example' },
    { 'X-Royal-Request': null }, { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const result = await app.request('/api/orders', { method: 'POST', headers, body: validOrder });
    assert.equal(result.status, 403);
    assert.equal(result.data.error, 'REQUEST_FORBIDDEN');
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  const nonJson = await app.request('/api/orders', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: validOrder });
  assert.equal(nonJson.status, 415);
  const malformed = await app.request('/api/orders', { method: 'POST', rawBody: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.data.error, 'INVALID_JSON');
  const array = await app.request('/api/orders', { method: 'POST', body: [] });
  assert.equal(array.status, 400);
  assert.equal(array.data.error, 'INVALID_JSON');
  const tooLarge = await app.request('/api/orders', { method: 'POST', rawBody: JSON.stringify({ huge: 'x'.repeat(17000) }) });
  assert.equal(tooLarge.status, 413);
  assert.equal(storedRequests(app.dbPath).length, 0);
});

test('guest submission is limited to 10 requests per IP and spoofed forwarded headers cannot bypass it', async t => {
  const app = await harness(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => app.request('/api/orders', {
    method: 'POST', headers: { 'X-Forwarded-For': `192.0.2.${index + 1}` }, body: validOrder,
  })));
  assert.equal(results.filter(result => result.status === 201).length, 10);
  assert.equal(results.filter(result => result.status === 429).length, 2);
  for (const result of results.filter(result => result.status === 429)) {
    assert.equal(result.data.error, 'RATE_LIMITED');
    assert.equal(result.headers.get('retry-after'), '900');
  }
  assert.equal(storedRequests(app.dbPath).length, 10);
});

test('trusted immediate proxy uses valid rightmost forwarded IP and normalizes mapped IPv4', async t => {
  const app = await harness(t, { trustedProxyIps: ['::ffff:127.0.0.1'] });
  for (let index = 0; index < 10; index++) {
    const result = await app.request('/api/orders', {
      method: 'POST', headers: { 'X-Forwarded-For': `192.0.2.${index + 1}, ::ffff:198.51.100.10` }, body: validOrder,
    });
    assert.equal(result.status, 201);
  }
  const limited = await app.request('/api/orders', {
    method: 'POST', headers: { 'X-Forwarded-For': '192.0.2.99, 198.51.100.10' }, body: validOrder,
  });
  assert.equal(limited.status, 429);
  const otherClient = await app.request('/api/orders', {
    method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.11' }, body: validOrder,
  });
  assert.equal(otherClient.status, 201);
  for (let index = 0; index < 10; index++) {
    const invalid = await app.request('/api/orders', {
      method: 'POST', headers: { 'X-Forwarded-For': `192.0.2.${index + 1}, invalid:${index}` }, body: {},
    });
    assert.equal(invalid.status, 400);
  }
  const invalidLimited = await app.request('/api/orders', {
    method: 'POST', headers: { 'X-Forwarded-For': 'another invalid value' }, body: validOrder,
  });
  assert.equal(invalidLimited.status, 429);
});

test('production requires explicit HTTPS origin, and trusted proxy IPs must be valid', () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(() => createApi({ dbPath: ':memory:' }), /explicit allowedOrigins/);
    assert.throws(() => createApi({ dbPath: ':memory:', allowedOrigins: ['http://royal.example'] }), /HTTPS/);
    assert.throws(() => createApi({ dbPath: ':memory:', allowedOrigins: ['http://royal.example'], requireHttps: false }), /HTTPS/);
    assert.throws(() => createApi({ dbPath: ':memory:', allowedOrigins: ['https://royal.example/'] }), /exact http/);
    assert.throws(() => createApi({ dbPath: ':memory:', allowedOrigins: ['https://royal.example'], trustedProxyIps: ['127.0.0.1/8'] }), /exact IPv4/);
    const api = createApi({ dbPath: ':memory:', allowedOrigins: ['https://royal.example'] });
    api.close();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('configured origin is matched exactly and replaces localhost allowance', async t => {
  const app = await harness(t, { allowedOrigins: ['https://royal.example'] });
  assert.equal((await app.request('/api/orders', { method: 'POST', body: validOrder })).status, 403);
  assert.equal((await app.request('/api/orders', { method: 'POST', headers: { Origin: 'https://royal.example.attacker.test' }, body: validOrder })).status, 403);
  assert.equal((await app.request('/api/orders', { method: 'POST', headers: { Origin: 'https://royal.example' }, body: validOrder })).status, 201);
});
