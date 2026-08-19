"use strict";

/**
 * In-process checks for plate L (JSON logs + audit list + backup script).
 * No Docker / Postgres required. Run: node platform/scripts/l-ops-selftest.js
 */

process.env.APP_HOST = process.env.APP_HOST || "app.localhost";
process.env.PAGES_PARENT = process.env.PAGES_PARENT || "pages.localhost";
process.env.RUNTIME_MANAGER_URL = process.env.RUNTIME_MANAGER_URL || "http://runtime-manager:8080";
process.env.RUNTIME_MANAGER_TOKEN = process.env.RUNTIME_MANAGER_TOKEN || "l-selftest-manager-token";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "l-selftest-session-secret-value";
process.env.PLATFORM_TOKEN_SECRET = process.env.PLATFORM_TOKEN_SECRET || "l-selftest-platform";
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "l-selftest-postgres-password";
process.env.DNS_API_TOKEN = process.env.DNS_API_TOKEN || "l-selftest-dns-token";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { sendJson, normalizePath } = require("../control-plane/src/http");
const { isAdminPath } = require("../control-plane/src/paths");
const { handleAdminRequest } = require("../control-plane/src/admin");
const { writeAudit, scrubMeta } = require("../control-plane/src/audit");
const { formatLogLine, redact, logError, attachRequestLog, REDACTED } = require("../control-plane/src/log");
const pagesLog = require("../pages/src/log");
const managerLog = require("../runtime-manager/src/log");

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECRET_BEARER = "tok_LIVE_must_not_appear_in_logs";
const SECRET_COOKIE = "ck_LIVE_must_not_appear_in_logs";
const SECRET_WRITE_TOKEN = "PLAINTEXT-WRITE-TOKEN-MUST-MASK";

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
  stream.headers = headers || { "content-type": "application/json" };
  return stream;
}

function jsonOf(res) {
  return res.body ? JSON.parse(res.body) : {};
}

async function withCaptured(stream, fn) {
  const chunks = [];
  const orig = stream.write;
  stream.write = (c, enc, cb) => {
    chunks.push(Buffer.isBuffer(c) ? c.toString("utf8") : String(c));
    if (typeof enc === "function") {
      enc();
    } else if (typeof cb === "function") {
      cb();
    }
    return true;
  };
  try {
    await fn();
    return chunks.join("");
  } finally {
    stream.write = orig;
  }
}

function createMemoryPool() {
  const store = {
    audit: [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        actor_id: ADMIN_ID,
        action: "legacy_with_token",
        target: "site-1",
        meta: {
          writeToken: SECRET_WRITE_TOKEN,
          cookie: `dsh_session=${SECRET_COOKIE}`,
          authorization: `Bearer ${SECRET_BEARER}`,
        },
        created_at: new Date("2026-06-01T00:00:00Z"),
      },
    ],
  };

  async function query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (s.includes("INSERT INTO audit_log")) {
      store.audit.push({
        id: `audit-${store.audit.length + 1}`,
        actor_id: params[0],
        action: params[1],
        target: params[2],
        meta: params[3] == null ? null : typeof params[3] === "string" ? JSON.parse(params[3]) : params[3],
        created_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("FROM audit_log") && s.includes("ORDER BY created_at DESC")) {
      const limit = Number(params[0]) || 50;
      const rows = store.audit
        .slice()
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, limit);
      return { rows };
    }
    return { rows: [], rowCount: 0 };
  }

  return { store, query };
}

async function adminGate({ session, method, url, body, pool, usersRoot }) {
  const pathname = normalizePath(url);
  const req = reqOf({ method, url, body });
  const res = mockRes();
  if (!session) {
    sendJson(res, 401, { error: "unauthenticated" });
    return res;
  }
  if (isAdminPath(pathname) && session.role !== "admin") {
    sendJson(res, 403, { error: "forbidden" });
    return res;
  }
  try {
    await handleAdminRequest(req, res, pool, session, usersRoot);
  } catch (err) {
    if (res.headersSent) {
      return res;
    }
    if (err && err.status) {
      sendJson(res, err.status, { error: err.code || "error" });
      return res;
    }
    throw err;
  }
  return res;
}

function assertNoSecrets(raw) {
  const text = String(raw);
  assert.ok(!text.includes(SECRET_BEARER), "log leaked Authorization bearer");
  assert.ok(!text.includes(SECRET_COOKIE), "log leaked Cookie value");
  assert.ok(!text.includes(SECRET_WRITE_TOKEN), "log leaked writeToken");
  assert.ok(!text.includes(`Bearer ${SECRET_BEARER}`), "log leaked Bearer plaintext");
  assert.ok(!text.includes(process.env.SESSION_SECRET), "log leaked SESSION_SECRET");
  assert.ok(!text.includes(process.env.POSTGRES_PASSWORD), "log leaked POSTGRES_PASSWORD");
  assert.ok(!text.includes(process.env.DNS_API_TOKEN), "log leaked DNS_API_TOKEN");
}

async function main() {
  const usersRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-l-users-"));
  const admin = {
    id: ADMIN_ID,
    username: "alice",
    email: null,
    role: "admin",
    status: "active",
    created_at: new Date("2026-01-01T00:00:00Z"),
  };
  const bob = {
    id: USER_ID,
    username: "bob",
    email: null,
    role: "user",
    status: "active",
    created_at: new Date("2026-01-02T00:00:00Z"),
  };
  const { store, query } = createMemoryPool();
  const pool = { query };

  try {
    await check("access log is one JSON line with method/path/status/ms", async () => {
      const req = {
        method: "GET",
        url: "/me",
        headers: {
          authorization: `Bearer ${SECRET_BEARER}`,
          cookie: `dsh_session=${SECRET_COOKIE}`,
        },
      };
      const res = new EventEmitter();
      res.statusCode = 200;
      const out = await withCaptured(process.stdout, async () => {
        attachRequestLog(req, res, { svc: "control-plane", userId: ADMIN_ID });
        res.emit("finish");
      });
      const line = out.trim();
      assert.equal(line.includes("\n"), false);
      const rec = JSON.parse(line);
      assert.equal(rec.method, "GET");
      assert.equal(rec.path, "/me");
      assert.equal(rec.status, 200);
      assert.equal(typeof rec.ms, "number");
      assert.equal(rec.userId, ADMIN_ID);
      assert.equal(rec.svc, "control-plane");
      assert.ok(!Object.hasOwn(rec, "authorization"));
      assert.ok(!Object.hasOwn(rec, "cookie"));
      assertNoSecrets(line);
    });

    await check("fake Authorization / Cookie values never appear in log string", async () => {
      const stack = [
        "Error: boom",
        `Authorization: Bearer ${SECRET_BEARER}`,
        `Cookie: dsh_session=${SECRET_COOKIE}`,
        `api_key in .credentials.yaml: sk-not-this-either`,
      ].join("\n");
      const line = formatLogLine({
        method: "POST",
        path: "/auth/login",
        status: 401,
        authorization: `Bearer ${SECRET_BEARER}`,
        cookie: `dsh_session=${SECRET_COOKIE}`,
        password: "super-secret-password",
        writeToken: SECRET_WRITE_TOKEN,
        stack,
      });
      assertNoSecrets(line);
      assert.ok(!line.includes("super-secret-password"));
      const rec = JSON.parse(line);
      assert.equal(rec.authorization, REDACTED);
      assert.equal(rec.cookie, REDACTED);
      assert.equal(rec.password, REDACTED);
      assert.equal(rec.writeToken, REDACTED);
      assert.ok(!rec.stack.includes(SECRET_BEARER));
      assert.ok(!rec.stack.includes(SECRET_COOKIE));
    });

    await check("error stack is logged only after redact", async () => {
      const err = new Error(`failed Cookie: dsh_session=${SECRET_COOKIE}`);
      err.stack = `${err.message}\nAuthorization: Bearer ${SECRET_BEARER}\nSESSION ${process.env.SESSION_SECRET}`;
      const out = await withCaptured(process.stderr, () => {
        logError(err, { svc: "control-plane", method: "GET", path: "/me" });
      });
      assertNoSecrets(out);
      const rec = JSON.parse(out.trim());
      assert.equal(rec.level, "error");
      assert.equal(rec.method, "GET");
      assert.equal(rec.path, "/me");
    });

    await check("pages and runtime-manager log modules redact the same secrets", () => {
      for (const mod of [pagesLog, managerLog]) {
        const line = mod.formatLogLine({
          authorization: `Bearer ${SECRET_BEARER}`,
          cookie: `dsh_session=${SECRET_COOKIE}`,
        });
        assertNoSecrets(line);
      }
    });

    await check("env secrets in strings are masked", () => {
      const line = formatLogLine({
        err: `pwd=${process.env.POSTGRES_PASSWORD} dns=${process.env.DNS_API_TOKEN} sess=${process.env.SESSION_SECRET}`,
      });
      assertNoSecrets(line);
      assert.ok(line.includes(REDACTED));
    });

    await check("unauthenticated GET /admin/audit → 401", async () => {
      const res = await adminGate({ session: null, method: "GET", url: "/admin/audit", pool, usersRoot });
      assert.equal(res.statusCode, 401);
      assert.equal(jsonOf(res).error, "unauthenticated");
    });

    await check("role=user GET /admin/audit → 403", async () => {
      const res = await adminGate({ session: bob, method: "GET", url: "/admin/audit?limit=10", pool, usersRoot });
      assert.equal(res.statusCode, 403);
      assert.equal(jsonOf(res).error, "forbidden");
    });

    await check("admin GET /admin/audit lists rows and masks token meta", async () => {
      const res = await adminGate({ session: admin, method: "GET", url: "/admin/audit?limit=20", pool, usersRoot });
      assert.equal(res.statusCode, 200);
      const data = jsonOf(res);
      assert.ok(Array.isArray(data.entries));
      assert.ok(data.entries.length >= 1);
      const leaked = JSON.stringify(data);
      assertNoSecrets(leaked);
      const row = data.entries.find((e) => e.action === "legacy_with_token");
      assert.ok(row);
      assert.equal(row.meta.writeToken, REDACTED);
      assert.equal(row.meta.cookie, REDACTED);
      assert.equal(row.meta.authorization, REDACTED);
    });

    await check("writeAudit scrubs token fields before insert; GET HTML has 最近审计", async () => {
      await writeAudit(pool, {
        actorId: ADMIN_ID,
        action: "invite_create",
        target: "unused",
        meta: { writeToken: SECRET_WRITE_TOKEN, username: "bob" },
      });
      const stored = store.audit.find((a) => a.action === "invite_create");
      assert.ok(stored);
      assert.equal(stored.meta.writeToken, REDACTED);
      assert.equal(stored.meta.username, "bob");
      assert.equal(scrubMeta({ password: "x" }).password, REDACTED);

      const page = await adminGate({ session: admin, method: "GET", url: "/admin", pool, usersRoot });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /最近审计/);
      assert.match(page.body, /\/admin\/audit/);
    });

    await check("backup script exists and uses docker exec pg_dump", () => {
      const script = path.join(__dirname, "backup-postgres.sh");
      assert.equal(fs.existsSync(script), true);
      const body = fs.readFileSync(script, "utf8");
      assert.match(body, /docker exec/);
      assert.match(body, /pg_dump/);
      assert.match(body, /dsh-postgres/);
      assert.match(body, /\/data\/backups/);
      assert.ok(!body.includes("POSTGRES_PASSWORD="));
    });
  } finally {
    fs.rmSync(usersRoot, { recursive: true, force: true });
  }

  if (failed) {
    process.stderr.write(`\n${failed} check(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nall l-ops-selftest checks passed\n");
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
