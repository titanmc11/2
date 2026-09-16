import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteServer, environmentOptions, projectRoot } from '../server/app.mjs';

async function siteHarness(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'royal-server-test-'));
  const site = await createSiteServer({ dbPath: path.join(directory, 'accounts.sqlite'), ...options });
  await new Promise(resolve => site.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${site.server.address().port}`;
  t.after(async () => {
    site.server.closeAllConnections();
    await site.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    origin,
    async request(url, { method = 'GET', body, cookie, headers = {}, redirect = 'manual' } = {}) {
      const response = await fetch(origin + url, {
        method, redirect,
        headers: {
          ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: origin, 'X-Royal-Request': '1' } : {}),
          ...(cookie ? { Cookie: cookie } : {}), ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, headers: response.headers, text, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    },
  };
}

test('real server delivers generated pages, CSS, JavaScript, images, and security headers', async t => {
  const app = await siteHarness(t);
  const home = await app.request('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Royal UA Cleaning/i);
  assert.match(home.headers.get('content-type'), /^text\/html/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.match(home.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  const cssPath = home.text.match(/href="([^"\s]+\.css)"/)[1];
  const scriptPath = home.text.match(/src="([^"\s]+\.js)"/)[1];
  const css = await app.request('/' + cssPath);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.ok(css.text.length > 1000);
  const script = await app.request('/' + scriptPath);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /^text\/javascript/);
  assert.ok(script.text.length > 1000);
  assert.equal((await app.request('/assets/images/living.jpg')).headers.get('content-type'), 'image/jpeg');
  for (const language of ['en', 'uk', 'ka']) {
    const translated = await app.request(`/${language}-book.html`);
    assert.equal(translated.status, 200);
    assert.match(translated.text, new RegExp(`<html[^>]+lang="${language}"`));
  }
});

test('unknown routes and private/source files return the custom 404 without disclosing contents', async t => {
  const app = await siteHarness(t);
  const notFound = await app.request('/404.html');
  assert.equal(notFound.status, 404);
  assert.match(notFound.text, /404/);
  for (const url of [
    '/sdfgfg', '/.env', '/.root-export-manifest.json', '/.git/config', '/.openai/hosting.json',
    '/server/app.mjs', '/server/api.mjs', '/scripts/build.mjs', '/tests/auth.test.mjs',
    '/package.json', '/data/royal.sqlite', '/data/royal.sqlite-wal', '/node_modules/',
    '/assets/.env', '/assets/../server/api.mjs', '/assets/%2e%2e%2fserver%2fapi.mjs',
    '/assets/%2e%2e%5cserver%5capi.mjs', '/assets/%00style.css', '/assets/%zz.css',
  ]) {
    const response = await app.request(url);
    assert.equal(response.status, 404, url);
    assert.equal(response.text, notFound.text, url);
  }
  const privatePost = await app.request('/server/app.mjs', { method: 'POST', body: {} });
  assert.equal(privatePost.status, 405);
  assert.equal(privatePost.headers.get('allow'), 'GET, HEAD');
});

test('HEAD returns matching headers without response bodies; health and route redirects work', async t => {
  const app = await siteHarness(t);
  for (const url of ['/', '/assets/style.css', '/not-a-page']) {
    const get = await app.request(url);
    const head = await app.request(url, { method: 'HEAD' });
    assert.equal(head.status, get.status);
    assert.equal(head.text, '');
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
    if (get.status === 200) assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
  }
  assert.deepEqual((await app.request('/healthz')).data, { status: 'ok' });
  assert.equal((await app.request('/healthz', { method: 'HEAD' })).text, '');
  const old = await app.request('/en/services/deep/?from=old');
  assert.equal(old.status, 308);
  assert.equal(old.headers.get('location'), '/en-services-deep.html?from=old');
  assert.equal((await app.request('/api/unknown')).status, 404);
  assert.deepEqual((await app.request('/api/unknown')).data, { error: 'API_NOT_FOUND' });
});

test('real server authenticates accounts and protects booking submission on the same origin', async t => {
  const app = await siteHarness(t);
  const anonymous = await app.request('/api/orders', { method: 'POST', body: {} });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.data.error, 'AUTH_REQUIRED');
  const registration = await app.request('/api/auth/register', {
    method: 'POST', body: {
      firstName: 'Олена', lastName: 'Клиент', login: 'site.integration',
      password: 'Integration 123!', confirmPassword: 'Integration 123!',
    },
  });
  assert.equal(registration.status, 201);
  assert.match(registration.headers.get('set-cookie'), /HttpOnly/);
  const session = await app.request('/api/auth/session', { cookie: registration.cookie });
  assert.deepEqual(session.data.user, registration.data.user);
  const order = await app.request('/api/orders', {
    method: 'POST', cookie: registration.cookie, body: {
      language: 'uk', property: 'home', service: 'deep', sizeIndex: 1, extras: ['manager'],
      date: '2099-01-20', time: 'afternoon', address: 'Батумі, Руставелі 20',
      name: 'Олена Клиент', phone: '+995 555 123 456', comment: '', consent: true, total: 1,
    },
  });
  assert.equal(order.status, 201);
  assert.equal(order.data.order.total, 200);
  assert.equal(order.data.order.status, 'pending');
  assert.equal((await app.request('/api/orders', { cookie: registration.cookie })).data.orders.length, 1);
  const csrf = await app.request('/api/orders', {
    method: 'POST', cookie: registration.cookie, headers: { Origin: 'https://evil.example' }, body: {},
  });
  assert.equal(csrf.status, 403);
  await app.request('/api/auth/logout', { method: 'POST', cookie: registration.cookie, body: {} });
  assert.equal((await app.request('/api/auth/session', { cookie: registration.cookie })).data.user, null);
});

test('subdirectory serving preserves static paths, redirects, and API routing', async t => {
  const app = await siteHarness(t, { base: '/royal/' });
  assert.equal((await app.request('/')).status, 404);
  assert.equal((await app.request('/royal/')).status, 200);
  assert.equal((await app.request('/royal/assets/style.css')).status, 200);
  const redirect = await app.request('/royal/uk/services/');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/royal/uk-services.html');
  assert.deepEqual((await app.request('/royal/api/auth/session')).data, { user: null });
  assert.equal((await app.request('/api/auth/session')).status, 404);
  assert.equal((await app.request('/royal/assets/%2e%2e%2fserver%2fapp.mjs')).status, 404);
});

test('asset symlinks cannot disclose files outside the public assets directory', async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'royal-static-boundary-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'public');
  const privateDirectory = path.join(fixture, 'private');
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await mkdir(privateDirectory);
  await writeFile(path.join(root, 'index.html'), '<!doctype html><h1>Public site</h1>');
  await writeFile(path.join(root, '404.html'), '<!doctype html><h1>404</h1>');
  await writeFile(path.join(root, '.root-export-manifest.json'), JSON.stringify(['index.html', '404.html', 'assets']));
  await writeFile(path.join(privateDirectory, 'secret.txt'), 'DO_NOT_PUBLISH_THIS_SECRET');
  await symlink(privateDirectory, path.join(root, 'assets', 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  const app = await siteHarness(t, { publicRoot: root });
  const result = await app.request('/assets/external/secret.txt');
  assert.equal(result.status, 404);
  assert.doesNotMatch(result.text, /DO_NOT_PUBLISH_THIS_SECRET/);
});

test('production environment validates origin, HTTPS, port and private database configuration', async () => {
  const keys = ['NODE_ENV', 'PUBLIC_ORIGIN', 'DATA_DIR', 'PORT', 'HOST', 'TRUSTED_PROXY_IPS'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.NODE_ENV = 'production';
    assert.throws(environmentOptions, /PUBLIC_ORIGIN/);
    process.env.PUBLIC_ORIGIN = 'http://royal.example';
    await assert.rejects(createSiteServer({ ...environmentOptions(), dbPath: ':memory:' }), /HTTPS/);
    process.env.PUBLIC_ORIGIN = 'https://royal.example';
    process.env.DATA_DIR = '../royal-private-data';
    process.env.PORT = '8080';
    process.env.HOST = '127.0.0.1';
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1, ::1';
    const options = environmentOptions();
    assert.deepEqual(options.allowedOrigins, ['https://royal.example']);
    assert.equal(options.secureCookies, true);
    assert.equal(options.port, 8080);
    assert.deepEqual(options.trustedProxyIps, ['127.0.0.1', '::1']);
    assert.equal(options.dbPath, path.resolve(projectRoot, '../royal-private-data', 'royal.sqlite'));
    process.env.PORT = '-1';
    assert.throws(environmentOptions, /Invalid PORT/);
    process.env.PORT = '70000';
    assert.throws(environmentOptions, /Invalid PORT/);
    process.env.PORT = 'not-a-number';
    assert.throws(environmentOptions, /Invalid PORT/);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
