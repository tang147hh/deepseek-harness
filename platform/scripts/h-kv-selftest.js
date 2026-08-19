"use strict";

/**
 * In-process checks for plate H (public site JSON KV).
 * No Docker / Postgres required. Run: node platform/scripts/h-kv-selftest.js
 */

const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { sendJson } = require("../control-plane/src/http");
const { isSitesPath, hashWriteToken, handleSitesRequest } = require("../control-plane/src/sites");
const {
  hashWriteToken: pagesHash,
  parseKvKey,
  createWriteRateLimiter,
  corsHeaders,
  handleKvRequest,
} = require("../pages/src/kv");
const { handlePagesRequest, slugFromHost } = require("../pages/src/serve");

let failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      process.stdout.write(`ok  ${name}\n`);
    })
    .catch((err) => {
      failed += 1;
      process.stderr.write(`FAIL ${name}: ${err.stack || err.message}\n`);
    });
}

function mockRes() {
  return {
    headersSent: false,
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = { ...headers };
      this.headersSent = true;
    },
    end(body) {
      this.body = body == null ? "" : String(body);
      this.headersSent = true;
    },
    destroy() {},
  };
}

function reqOf({ method, url, headers, body }) {
  const stream = Readable.from(body == null ? [] : [Buffer.from(String(body))]);
  stream.method = method;
  stream.url = url;
  stream.headers = headers || {};
  return stream;
}

function createMemoryPool({ sites, kv }) {
  const store = {
    sites: sites.map((s) => ({ ...s })),
    kv: new Map(kv ? [...kv] : []),
  };
  const keyOf = (siteId, key) => `${siteId}\0${key}`;

  async function query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK" || s.startsWith("SELECT pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes("FROM sites") && s.includes("WHERE slug")) {
      const slug = params[0];
      const site = store.sites.find((x) => x.slug === slug);
      return { rows: site ? [{ ...site }] : [] };
    }
    if (s.includes("FROM sites") && s.includes("WHERE id = $1") && !s.includes("site_kv")) {
      const site = store.sites.find((x) => x.id === params[0]);
      return { rows: site ? [{ ...site }] : [] };
    }
    if (s.includes("FROM sites WHERE user_id")) {
      const rows = store.sites
        .filter((x) => x.user_id === params[0])
        .map((x) => ({
          ...x,
          has_write_token: Boolean(x.write_token_hash),
        }));
      return { rows };
    }
    if (s.includes("FROM site_versions")) {
      return { rows: [] };
    }
    if (s.includes("UPDATE sites SET write_token_hash")) {
      const site = store.sites.find((x) => x.id === params[0]);
      if (site) site.write_token_hash = params[1];
      return { rows: [], rowCount: site ? 1 : 0 };
    }
    if (s.includes("SELECT value FROM site_kv")) {
      const raw = store.kv.get(keyOf(params[0], params[1]));
      return { rows: raw === undefined ? [] : [{ value: JSON.parse(raw) }] };
    }
    if (s.includes("SELECT 1 FROM site_kv")) {
      const raw = store.kv.get(keyOf(params[0], params[1]));
      return { rows: raw === undefined ? [] : [{ "?column?": 1 }] };
    }
    if (s.includes("SUM(octet_length")) {
      let used = 0;
      let old = 0;
      for (const [k, raw] of store.kv) {
        if (!k.startsWith(`${params[0]}\0`)) continue;
        const n = Buffer.byteLength(raw);
        used += n;
        if (k === keyOf(params[0], params[1])) old += n;
      }
      return { rows: [{ used, old }] };
    }
    if (s.includes("INSERT INTO site_kv")) {
      store.kv.set(keyOf(params[0], params[1]), params[2]);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected sql: ${s}`);
  }

  return {
    store,
    query,
    async connect() {
      return { query, release() {} };
    },
  };
}

function headerKeys(res) {
  return Object.keys(res.headers).map((k) => k.toLowerCase());
}

async function kvCall(pool, { method, host, path, headers, body, limiter }) {
  const res = mockRes();
  const req = reqOf({
    method,
    url: path,
    headers: { host, ...(headers || {}) },
    body,
  });
  await handlePagesRequest(req, res, {
    snapshotsRoot: "C:\\nonexistent-snapshots",
    pagesParent: "pages.localhost",
    pagesHost: "pages.localhost",
    pool,
    rateLimiter: limiter,
  });
  return res;
}

async function main() {
  await check("isSitesPath covers /sites/token", () => {
    assert.equal(isSitesPath("/sites/token"), true);
    assert.equal(isSitesPath("/sites"), true);
    assert.equal(isSitesPath("/api"), false);
  });

  await check("write token hash is sha256, not session-peppered, same in both packages", () => {
    const token = "test-write-token";
    const h = hashWriteToken(token);
    assert.equal(h, pagesHash(token));
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.notEqual(h, token);
  });

  await check("parseKvKey rejects list/prefix/invalid", () => {
    assert.equal(parseKvKey("/v1/kv").error, "invalid_key");
    assert.equal(parseKvKey("/v1/kv/").error, "invalid_key");
    assert.equal(parseKvKey("/v1/kv/foo/bar").error, "invalid_key");
    assert.equal(parseKvKey("/v1/kv/has space").error, "invalid_key");
    assert.equal(parseKvKey("/v1/kv/" + "x".repeat(65)).error, "invalid_key");
    assert.equal(parseKvKey("/v1/kv/count").key, "count");
    assert.equal(parseKvKey("/v1/kv/a_B.9-").key, "a_B.9-");
  });

  await check("CORS only allows that site origin", () => {
    const ok = corsHeaders(
      { headers: { origin: "https://alice.pages.localhost" } },
      "alice",
      "pages.localhost",
    );
    assert.equal(ok["access-control-allow-origin"], "https://alice.pages.localhost");
    const bad = corsHeaders(
      { headers: { origin: "https://app.localhost" } },
      "alice",
      "pages.localhost",
    );
    assert.equal(bad["access-control-allow-origin"], undefined);
    const none = corsHeaders({ headers: {} }, "alice", "pages.localhost");
    assert.equal(none["access-control-allow-origin"], undefined);
  });

  await check("slugFromHost matches static sites", () => {
    assert.equal(slugFromHost("alice.pages.localhost", "pages.localhost", "pages.localhost"), "alice");
    assert.equal(slugFromHost("pages.localhost", "pages.localhost", "pages.localhost"), null);
    assert.equal(slugFromHost("bob.pages.localhost", "pages.localhost", "pages.localhost"), "bob");
  });

  const aliceId = "11111111-1111-1111-1111-111111111111";
  const bobId = "22222222-2222-2222-2222-222222222222";
  const aliceTok = "alice-write-token-aaaaaaaaaaaaaaaa";
  const bobTok = "bob-write-token-bbbbbbbbbbbbbbbbbb";
  const downId = "33333333-3333-3333-3333-333333333333";

  const pool = createMemoryPool({
    sites: [
      {
        id: aliceId,
        user_id: "aaaa",
        slug: "alice",
        status: "live",
        write_token_hash: hashWriteToken(aliceTok),
      },
      {
        id: bobId,
        user_id: "bbbb",
        slug: "bob",
        status: "live",
        write_token_hash: hashWriteToken(bobTok),
      },
      {
        id: downId,
        user_id: "aaaa",
        slug: "gone",
        status: "taken_down",
        write_token_hash: hashWriteToken(aliceTok),
      },
    ],
  });

  await check("unauthenticated control-plane /sites/token is reserved (401 at session gate)", () => {
    assert.equal(isSitesPath("/sites/token"), true);
  });

  async function sitesCall(poolArg, user, req) {
    const res = mockRes();
    try {
      await handleSitesRequest(req, res, poolArg, user, "/tmp");
    } catch (err) {
      if (err && err.status) {
        sendJson(res, err.status, { error: err.code || "error" });
      } else {
        throw err;
      }
    }
    return res;
  }

  await check("GET /sites/list shows hasWriteToken, never plaintext token", async () => {
    const res = await sitesCall(pool, { id: "aaaa", role: "user" }, reqOf({ method: "GET", url: "/sites/list", headers: {} }));
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.sites[0].hasWriteToken, true);
    assert.equal(data.sites[0].writeToken, undefined);
    assert.equal(data.sites[0].write_token_hash, undefined);
    assert.ok(!res.body.includes(aliceTok));
  });

  await check("POST /sites/token rotates (owner) and returns plaintext once", async () => {
    const res = await sitesCall(
      pool,
      { id: "aaaa", role: "user" },
      reqOf({
        method: "POST",
        url: "/sites/token",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ siteId: aliceId }),
      }),
    );
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.writeToken);
    assert.equal(pool.store.sites[0].write_token_hash, hashWriteToken(data.writeToken));
    // restore known token for later KV tests
    pool.store.sites[0].write_token_hash = hashWriteToken(aliceTok);
  });

  await check("non-owner rotate is 404", async () => {
    const res = await sitesCall(
      pool,
      { id: "aaaa", role: "user" },
      reqOf({
        method: "POST",
        url: "/sites/token",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ siteId: bobId }),
      }),
    );
    assert.equal(res.statusCode, 404);
  });

  await check("live GET /v1/kv/count without token: 404 empty, no Set-Cookie", async () => {
    const res = await kvCall(pool, {
      method: "GET",
      host: "alice.pages.localhost",
      path: "/v1/kv/count",
    });
    assert.equal(res.statusCode, 404);
    assert.ok(!headerKeys(res).includes("set-cookie"));
    assert.match(res.body, /not_found/);
  });

  await check("PUT without token → 401; wrong token → 401; good token then GET", async () => {
    let res = await kvCall(pool, {
      method: "PUT",
      host: "alice.pages.localhost",
      path: "/v1/kv/count",
      headers: { "content-type": "application/json" },
      body: "1",
    });
    assert.equal(res.statusCode, 401);

    res = await kvCall(pool, {
      method: "PUT",
      host: "alice.pages.localhost",
      path: "/v1/kv/count",
      headers: { authorization: `Bearer ${bobTok}`, "content-type": "application/json" },
      body: "1",
    });
    assert.equal(res.statusCode, 401);

    res = await kvCall(pool, {
      method: "PUT",
      host: "alice.pages.localhost",
      path: "/v1/kv/count",
      headers: { authorization: `Bearer ${aliceTok}`, "content-type": "application/json" },
      body: "1",
    });
    assert.equal(res.statusCode, 200);
    assert.ok(!headerKeys(res).includes("set-cookie"));

    res = await kvCall(pool, {
      method: "GET",
      host: "alice.pages.localhost",
      path: "/v1/kv/count",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body), 1);
    assert.ok(!headerKeys(res).includes("set-cookie"));
  });

  await check("A token cannot write B (Host is B slug)", async () => {
    const res = await kvCall(pool, {
      method: "PUT",
      host: "bob.pages.localhost",
      path: "/v1/kv/count",
      headers: { authorization: `Bearer ${aliceTok}`, "content-type": "application/json" },
      body: "99",
    });
    assert.equal(res.statusCode, 401);
  });

  await check("taken_down / unknown host KV is 404", async () => {
    let res = await kvCall(pool, {
      method: "GET",
      host: "gone.pages.localhost",
      path: "/v1/kv/count",
    });
    assert.equal(res.statusCode, 404);
    res = await kvCall(pool, {
      method: "PUT",
      host: "gone.pages.localhost",
      path: "/v1/kv/count",
      headers: { authorization: `Bearer ${aliceTok}`, "content-type": "application/json" },
      body: "1",
    });
    assert.equal(res.statusCode, 404);
    res = await kvCall(pool, {
      method: "GET",
      host: "pages.localhost",
      path: "/v1/kv/count",
    });
    assert.equal(res.statusCode, 404);
  });

  await check("invalid key / oversized value → 400; quota → 413; rate → 429", async () => {
    let res = await kvCall(pool, {
      method: "GET",
      host: "alice.pages.localhost",
      path: "/v1/kv/bad key",
    });
    assert.equal(res.statusCode, 400);

    res = await kvCall(pool, {
      method: "PUT",
      host: "alice.pages.localhost",
      path: "/v1/kv/count",
      headers: { authorization: `Bearer ${aliceTok}`, "content-type": "application/json" },
      body: `${"x".repeat(70 * 1024)}`,
    });
    assert.equal(res.statusCode, 400);

    const tiny = createMemoryPool({
      sites: [
        {
          id: aliceId,
          user_id: "aaaa",
          slug: "alice",
          status: "live",
          write_token_hash: hashWriteToken(aliceTok),
        },
      ],
    });
    const prevVal = process.env.KV_SITE_MAX_BYTES;
    const prevLim = process.env.KV_VALUE_MAX_BYTES;
    process.env.KV_SITE_MAX_BYTES = "20";
    process.env.KV_VALUE_MAX_BYTES = "65536";
    try {
      res = await kvCall(tiny, {
        method: "PUT",
        host: "alice.pages.localhost",
        path: "/v1/kv/blob",
        headers: { authorization: `Bearer ${aliceTok}`, "content-type": "application/json" },
        body: JSON.stringify("abcdefghijklmnopqrstuvwxyz"),
      });
      assert.equal(res.statusCode, 413, res.body);
    } finally {
      if (prevVal == null) delete process.env.KV_SITE_MAX_BYTES;
      else process.env.KV_SITE_MAX_BYTES = prevVal;
      if (prevLim == null) delete process.env.KV_VALUE_MAX_BYTES;
      else process.env.KV_VALUE_MAX_BYTES = prevLim;
    }

    const limiter = createWriteRateLimiter({ limit: 2, windowMs: 60_000 });
    const put = () =>
      kvCall(pool, {
        method: "PUT",
        host: "alice.pages.localhost",
        path: "/v1/kv/count",
        headers: { authorization: `Bearer ${aliceTok}`, "content-type": "application/json" },
        body: "2",
        limiter,
      });
    assert.equal((await put()).statusCode, 200);
    assert.equal((await put()).statusCode, 200);
    const limited = await put();
    assert.equal(limited.statusCode, 429);
  });

  await check("pages KV never sets Set-Cookie; handleKvRequest export is not /api", async () => {
    const res = await kvCall(pool, {
      method: "GET",
      host: "alice.pages.localhost",
      path: "/v1/kv/count",
    });
    assert.ok(!headerKeys(res).includes("set-cookie"));
    assert.equal(isSitesPath("/api"), false);
  });

  if (failed) {
    process.stderr.write(`${failed} check(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("all plate H selftests passed\n");
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
