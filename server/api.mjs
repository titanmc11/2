import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isIP } from 'node:net';
import { types, availableExtras, quote } from '../assets/pricing.js';

const BODY_LIMIT = 16 * 1024;
const RATE_WINDOW = 15 * 60 * 1000;
const REQUESTS_PER_WINDOW = 10;

class ApiError extends Error {
  constructor(status, code, field) {
    super(code);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

function normalizedIp(value) {
  if (typeof value !== 'string' || !isIP(value)) return null;
  const lower = value.toLowerCase();
  return lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4 ? lower.slice(7) : lower;
}

function inputString(value, field, max, { optional = false, multiline = false } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', field);
  const trimmed = value.trim();
  const control = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if ((!optional && !trimmed) || trimmed.length > max || control.test(trimmed)) {
    throw new ApiError(400, 'VALIDATION_ERROR', field);
  }
  return trimmed;
}

function readJson(req) {
  if (Number(req.headers['content-length']) > BODY_LIMIT) {
    req.resume();
    throw new ApiError(413, 'BODY_TOO_LARGE');
  }
  return new Promise((resolveBody, reject) => {
    let bytes = 0;
    const chunks = [];
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = error => {
      cleanup();
      // Keep an error listener while draining a rejected/aborted upload.
      req.once('error', () => {});
      req.resume();
      reject(error);
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) return fail(new ApiError(413, 'BODY_TOO_LARGE'));
      chunks.push(chunk);
    };
    const onError = () => fail(new ApiError(400, 'INVALID_JSON'));
    const onAborted = () => fail(new ApiError(400, 'INVALID_JSON'));
    const onEnd = () => {
      cleanup();
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not an object');
        resolveBody(value);
      } catch { reject(new ApiError(400, 'INVALID_JSON')); }
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function validateOrder(body) {
  const { language, property, service, sizeIndex, extras, date, time } = body;
  for (const [field, valid] of [
    ['language', ['ru', 'uk', 'en', 'ka'].includes(language)],
    ['property', ['home', 'office'].includes(property)],
    ['service', types.includes(service) && (property === 'office' ? service === 'office' : service !== 'office')],
    ['sizeIndex', Number.isInteger(sizeIndex) && sizeIndex >= 0 && sizeIndex <= 7],
    ['time', ['morning', 'afternoon', 'evening'].includes(time)],
    ['consent', body.consent === true],
  ]) if (!valid) throw new ApiError(400, 'VALIDATION_ERROR', field);
  if (!Array.isArray(extras) || extras.length > 6 || new Set(extras).size !== extras.length ||
      extras.some(extra => !availableExtras(service).includes(extra))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'extras');
  }
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const parsedDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + 'T12:00:00Z') : null;
  if (!parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date || date < today) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'date');
  }
  const address = inputString(body.address, 'address', 250);
  const name = inputString(body.name, 'name', 100);
  const phone = inputString(body.phone, 'phone', 24).replace(/[\s()-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || (phone.startsWith('+995') && !/^\+995\d{9}$/.test(phone))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'phone');
  }
  const comment = inputString(body.comment, 'comment', 2000, { optional: true, multiline: true });
  return { language, property, service, sizeIndex, extras, date, time, address, name, phone, comment, consent: true };
}

/** Same-origin guest booking API. Never serve dbPath as a static file. */
export function createApi({ dbPath, allowedOrigins = [], requireHttps = process.env.NODE_ENV === 'production', trustedProxyIps = [] } = {}) {
  if (!dbPath || typeof dbPath !== 'string') throw new Error('createApi requires dbPath outside the public site directory.');
  if (!Array.isArray(allowedOrigins)) throw new Error('allowedOrigins must be an array of exact URL origins.');
  const mustUseHttps = process.env.NODE_ENV === 'production' || requireHttps;
  const origins = new Set(allowedOrigins.map(origin => {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('Each allowed origin must be an exact http(s) origin without a trailing slash.');
    }
    if (mustUseHttps && parsed.protocol !== 'https:') {
      throw new Error('Production requires an HTTPS public origin.');
    }
    return parsed.origin;
  }));
  if (mustUseHttps && !origins.size) {
    throw new Error('Production requires explicit allowedOrigins.');
  }
  if (!Array.isArray(trustedProxyIps)) throw new Error('trustedProxyIps must be an array of exact IP addresses.');
  const trustedProxies = new Set(trustedProxyIps.map(ip => {
    const normalized = normalizedIp(ip);
    if (!normalized) throw new Error('trustedProxyIps accepts exact IPv4/IPv6 addresses only, without CIDR or ports.');
    return normalized;
  }));
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS booking_requests (
      id TEXT PRIMARY KEY,
      details TEXT NOT NULL,
      total INTEGER NOT NULL CHECK(total >= 0),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS booking_requests_date ON booking_requests(created_at DESC);
  `);
  const insertOrder = db.prepare('INSERT INTO booking_requests (id, details, total, status, created_at) VALUES (?, ?, ?, ?, ?)');
  const rateBuckets = new Map();
  let lastCleanup = 0;

  function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < 60000) return;
    lastCleanup = now;
    for (const [ip, bucket] of rateBuckets) if (bucket.until <= now) rateBuckets.delete(ip);
  }

  function rateBucket(req) {
    const peer = normalizedIp(req.socket.remoteAddress) || 'unknown';
    // Only a configured immediate proxy may assert the final hop's client IP.
    // The proxy must overwrite X-Forwarded-For with $remote_addr, or append it.
    const forwarded = trustedProxies.has(peer) && typeof req.headers['x-forwarded-for'] === 'string'
      ? normalizedIp(req.headers['x-forwarded-for'].split(',').at(-1).trim()) : null;
    const ip = forwarded || peer;
    let bucket = rateBuckets.get(ip);
    if (!bucket || bucket.until <= Date.now()) {
      if (!bucket && rateBuckets.size >= 10000) throw new ApiError(503, 'SERVER_BUSY');
      bucket = { until: Date.now() + RATE_WINDOW, attempts: 0 };
      rateBuckets.set(ip, bucket);
    }
    if (bucket.attempts >= REQUESTS_PER_WINDOW) throw new ApiError(429, 'RATE_LIMITED');
    bucket.attempts++;
    return bucket;
  }

  function checkMutation(req) {
    const origin = req.headers.origin;
    let originAllowed = typeof origin === 'string' && origins.has(origin);
    if (!origins.size && process.env.NODE_ENV !== 'production') {
      try {
        const ownOrigin = new URL(`http://${req.headers.host}`);
        originAllowed = ['localhost', '127.0.0.1', '[::1]'].includes(ownOrigin.hostname) && ownOrigin.origin === origin;
      } catch { originAllowed = false; }
    }
    if (!originAllowed || req.headers['x-royal-request'] !== '1') throw new ApiError(403, 'REQUEST_FORBIDDEN');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'REQUEST_FORBIDDEN');
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json' ||
        (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
      throw new ApiError(415, 'JSON_REQUIRED');
    }
  }

  function json(res, status, data) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    res.end(JSON.stringify(data));
  }

  async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (path !== '/api' && !path.startsWith('/api/')) return false;
    try {
      cleanup();
      if (path !== '/api/orders') throw new ApiError(404, 'API_NOT_FOUND');
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      }
      checkMutation(req);
      rateBucket(req);
      const order = validateOrder(await readJson(req));
      const { total } = quote(order.service, order.sizeIndex, order.extras);
      const id = randomUUID();
      insertOrder.run(id, JSON.stringify(order), total, 'pending', Date.now());
      json(res, 201, { success: true, order: { id, total, currency: 'GEL', status: 'pending' } });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 429) res.setHeader('Retry-After', String(Math.ceil(RATE_WINDOW / 1000)));
        json(res, error.status, { error: error.code, ...(error.field ? { field: error.field } : {}) });
      } else {
        // Never log request bodies or personal booking information.
        console.error('Royal API internal failure:', error?.code || error?.name || 'UnknownError');
        json(res, 500, { error: 'SERVER_ERROR' });
      }
    }
    return true;
  }

  return { handle, close() { db.close(); rateBuckets.clear(); } };
}
