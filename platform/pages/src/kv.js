"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");

const KV_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_VALUE_MAX = 64 * 1024;
const DEFAULT_SITE_MAX = 1024 * 1024;
const DEFAULT_WRITES_PER_MIN = 30;

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

function valueMaxBytes() {
  const n = Number.parseInt(process.env.KV_VALUE_MAX_BYTES ?? String(DEFAULT_VALUE_MAX), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_VALUE_MAX;
}

function siteMaxBytes() {
  const n = Number.parseInt(process.env.KV_SITE_MAX_BYTES ?? String(DEFAULT_SITE_MAX), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SITE_MAX;
}

function writesPerMinute() {
  const n = Number.parseInt(process.env.KV_WRITE_PER_MINUTE ?? String(DEFAULT_WRITES_PER_MIN), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WRITES_PER_MIN;
}

/** Must match control-plane hashWriteToken: sha256 hex, no SESSION_SECRET. */
function hashWriteToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

function bearerMatches(storedHash, token) {
  if (!storedHash || !token) {
    return false;
  }
  const a = Buffer.from(String(storedHash), "utf8");
  const b = Buffer.from(hashWriteToken(token), "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function parseBearer(req) {
  const raw = String(req.headers.authorization ?? req.headers.Authorization ?? "");
  const m = raw.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : "";
}

function isKvPath(pathname) {
  return pathname === "/v1/kv" || pathname.startsWith("/v1/kv/");
}

function parseKvKey(pathname) {
  const path = String(pathname ?? "");
  if (path === "/v1/kv" || path === "/v1/kv/") {
    return { error: "invalid_key" };
  }
  if (!path.startsWith("/v1/kv/")) {
    return { error: "not_found" };
  }
  const rest = path.slice("/v1/kv/".length);
  if (!rest || rest.includes("/")) {
    return { error: "invalid_key" };
  }
  let key = rest;
  try {
    key = decodeURIComponent(rest);
  } catch {
    return { error: "invalid_key" };
  }
  if (!KV_KEY_RE.test(key)) {
    return { error: "invalid_key" };
  }
  return { key };
}

function createWriteRateLimiter({ limit, windowMs = 60_000 } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? limit : writesPerMinute();
  const hits = new Map();
  return {
    allow(siteId) {
      const now = Date.now();
      let arr = hits.get(siteId) || [];
      arr = arr.filter((t) => now - t < windowMs);
      if (arr.length >= cap) {
        hits.set(siteId, arr);
        return false;
      }
      arr.push(now);
      hits.set(siteId, arr);
      return true;
    },
    reset() {
      hits.clear();
    },
  };
}

const defaultLimiter = createWriteRateLimiter();

function siteOrigin(slug, pagesParent) {
  return `https://${slug}.${pagesParent}`;
}

function corsHeaders(req, slug, pagesParent) {
  const origin = String(req.headers.origin ?? "").trim();
  if (!origin || !slug || !pagesParent) {
    return {};
  }
  const allowed = siteOrigin(slug, pagesParent);
  if (origin.toLowerCase() !== allowed.toLowerCase()) {
    return {};
  }
  return {
    "access-control-allow-origin": allowed,
    vary: "Origin",
    "access-control-allow-methods": "GET, PUT, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-max-age": "600",
  };
}

function kvSecurityHeaders() {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-origin": "user-generated",
  };
}

function sendKv(res, status, obj, extra = {}) {
  res.writeHead(status, {
    ...kvSecurityHeaders(),
    "content-type": "application/json; charset=utf-8",
    ...extra,
  });
  res.end(`${JSON.stringify(obj)}\n`);
}

function sendKvRaw(res, status, jsonText, extra = {}) {
  res.writeHead(status, {
    ...kvSecurityHeaders(),
    "content-type": "application/json; charset=utf-8",
    ...extra,
  });
  res.end(jsonText);
}

function readJsonValue(req, { maxBytes }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;

    const fail = (err) => {
      if (done) {
        return;
      }
      done = true;
      reject(err);
    };

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(httpError(400, "value_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) {
        return;
      }
      done = true;
      if (size === 0) {
        fail(httpError(400, "invalid_json"));
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const value = JSON.parse(raw);
        resolve({ value, raw, bytes: Buffer.byteLength(raw) });
      } catch {
        fail(httpError(400, "invalid_json"));
      }
    });
    req.on("error", fail);
  });
}

async function loadLiveSite(pool, slug) {
  const { rows } = await pool.query(
    `SELECT id, slug, status, write_token_hash
     FROM sites
     WHERE slug = $1`,
    [slug],
  );
  const site = rows[0];
  if (!site || site.status !== "live") {
    return null;
  }
  return site;
}

async function handleKvGet(res, pool, site, key, extraHeaders) {
  const { rows } = await pool.query(
    `SELECT value FROM site_kv WHERE site_id = $1 AND key = $2`,
    [site.id, key],
  );
  if (!rows[0]) {
    sendKv(res, 404, { error: "not_found" }, extraHeaders);
    return;
  }
  sendKvRaw(res, 200, `${JSON.stringify(rows[0].value)}\n`, extraHeaders);
}

async function handleKvPut(req, res, pool, site, key, extraHeaders, limiter) {
  const token = parseBearer(req);
  if (!token) {
    sendKv(res, 401, { error: "unauthorized" }, extraHeaders);
    return;
  }
  if (!bearerMatches(site.write_token_hash, token)) {
    sendKv(res, 401, { error: "unauthorized" }, extraHeaders);
    return;
  }
  if (!limiter.allow(site.id)) {
    sendKv(res, 429, { error: "rate_limited" }, { ...extraHeaders, "retry-after": "60" });
    return;
  }

  const maxVal = valueMaxBytes();
  const parsed = await readJsonValue(req, { maxBytes: maxVal });
  const siteCap = siteMaxBytes();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [site.id]);
    const usage = await client.query(
      `SELECT
         COALESCE(SUM(octet_length(value::text)), 0)::int AS used,
         COALESCE(SUM(octet_length(value::text)) FILTER (WHERE key = $2), 0)::int AS old
       FROM site_kv
       WHERE site_id = $1`,
      [site.id, key],
    );
    const used = Number(usage.rows[0]?.used ?? 0);
    const old = Number(usage.rows[0]?.old ?? 0);
    if (used - old + parsed.bytes > siteCap) {
      await client.query("ROLLBACK");
      sendKv(res, 413, { error: "quota_exceeded" }, extraHeaders);
      return;
    }
    await client.query(
      `INSERT INTO site_kv (site_id, key, value, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (site_id, key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now()`,
      [site.id, key, parsed.raw],
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // keep original
    }
    throw err;
  } finally {
    client.release();
  }

  sendKv(res, 200, { ok: true, key }, extraHeaders);
}

async function handleKvRequest(req, res, opts = {}) {
  const method = req.method ?? "GET";
  const pathname = opts.pathname ?? "/";
  const slug = opts.slug;
  const pagesParent = opts.pagesParent;
  const extra = corsHeaders(req, slug, pagesParent);

  try {
    await dispatchKv(req, res, opts, method, pathname, slug, extra);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err && err.status) {
      sendKv(res, err.status, { error: err.code || "error" }, extra);
      return;
    }
    throw err;
  }
}

async function dispatchKv(req, res, opts, method, pathname, slug, extra) {
  if (method === "OPTIONS") {
    if (extra["access-control-allow-origin"]) {
      res.writeHead(204, { ...kvSecurityHeaders(), ...extra });
      res.end();
      return;
    }
    sendKv(res, 403, { error: "origin_not_allowed" });
    return;
  }

  const parsedKey = parseKvKey(pathname);
  if (parsedKey.error === "not_found") {
    sendKv(res, 404, { error: "not_found" }, extra);
    return;
  }
  if (parsedKey.error) {
    sendKv(res, 400, { error: parsedKey.error }, extra);
    return;
  }

  if (method !== "GET" && method !== "HEAD" && method !== "PUT") {
    sendKv(res, 405, { error: "method_not_allowed" }, { ...extra, allow: "GET, HEAD, PUT, OPTIONS" });
    return;
  }

  if (!slug) {
    sendKv(res, 404, { error: "not_found" }, extra);
    return;
  }

  const pool = opts.pool;
  if (!pool) {
    sendKv(res, 503, { error: "kv_unavailable" }, extra);
    return;
  }

  const site = await loadLiveSite(pool, slug);
  if (!site) {
    sendKv(res, 404, { error: "not_found" }, extra);
    return;
  }

  if (method === "GET" || method === "HEAD") {
    if (method === "HEAD") {
      const { rows } = await pool.query(
        `SELECT 1 FROM site_kv WHERE site_id = $1 AND key = $2`,
        [site.id, parsedKey.key],
      );
      res.writeHead(rows[0] ? 200 : 404, {
        ...kvSecurityHeaders(),
        "content-type": "application/json; charset=utf-8",
        ...extra,
      });
      res.end();
      return;
    }
    await handleKvGet(res, pool, site, parsedKey.key, extra);
    return;
  }

  await handleKvPut(req, res, pool, site, parsedKey.key, extra, opts.rateLimiter ?? defaultLimiter);
}

module.exports = {
  KV_KEY_RE,
  hashWriteToken,
  bearerMatches,
  isKvPath,
  parseKvKey,
  createWriteRateLimiter,
  corsHeaders,
  handleKvRequest,
  siteOrigin,
};
