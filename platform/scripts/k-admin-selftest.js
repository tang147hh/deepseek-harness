"use strict";

/**
 * In-process checks for plate K (admin control plane).
 * No Docker / Postgres required. Run: node platform/scripts/k-admin-selftest.js
 */

process.env.APP_HOST = process.env.APP_HOST || "app.localhost";
process.env.PAGES_PARENT = process.env.PAGES_PARENT || "pages.localhost";
process.env.RUNTIME_MANAGER_URL = process.env.RUNTIME_MANAGER_URL || "http://runtime-manager:8080";
process.env.RUNTIME_MANAGER_TOKEN = process.env.RUNTIME_MANAGER_TOKEN || "k-selftest-manager-token";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "k-selftest-session";
process.env.PLATFORM_TOKEN_SECRET = process.env.PLATFORM_TOKEN_SECRET || "k-selftest-platform";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { sendJson, normalizePath } = require("../control-plane/src/http");
const { isReservedControlPath, isAdminPath } = require("../control-plane/src/paths");
const { handleAdminRequest, credentialsFlag } = require("../control-plane/src/admin");
const { writeAudit } = require("../control-plane/src/audit");
const { isPlatformTokenAllowed } = require("../control-plane/src/platform-auth");
const { summarizeListed } = require("../runtime-manager/src/runtimes");
const { hashPassword, verifyPassword } = require("../control-plane/src/passwords");

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SITE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET_KEY = "sk-deepseek-MUST-NOT-LEAK-in-admin-json";

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

function createMemoryPool() {
  const store = {
    users: [
      {
        id: ADMIN_ID,
        username: "alice",
        email: null,
        role: "admin",
        status: "active",
        created_at: new Date("2026-01-01T00:00:00Z"),
        password_hash: "scrypt$placeholder",
      },
      {
        id: USER_ID,
        username: "bob",
        email: null,
        role: "user",
        status: "active",
        created_at: new Date("2026-01-02T00:00:00Z"),
        password_hash: "scrypt$placeholder",
      },
    ],
    sites: [
      {
        id: SITE_ID,
        user_id: USER_ID,
        slug: "bob-demo",
        status: "live",
        current_version: 1,
        created_at: new Date("2026-01-03T00:00:00Z"),
      },
    ],
    invites: [],
    audit: [],
  };

  async function query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (s.includes("INSERT INTO audit_log")) {
      store.audit.push({
        actor_id: params[0],
        action: params[1],
        target: params[2],
        meta: params[3] == null ? null : typeof params[3] === "string" ? JSON.parse(params[3]) : params[3],
      });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("FROM users") && s.includes("ORDER BY created_at")) {
      return {
        rows: store.users.map((u) => ({
          id: u.id,
          username: u.username,
          role: u.role,
          status: u.status,
          created_at: u.created_at,
        })),
      };
    }
    if (s.includes("UPDATE users SET status = 'disabled'")) {
      const u = store.users.find((x) => x.id === params[0]);
      if (!u) {
        return { rows: [], rowCount: 0 };
      }
      u.status = "disabled";
      return {
        rows: [{ id: u.id, username: u.username, role: u.role, status: u.status, created_at: u.created_at }],
        rowCount: 1,
      };
    }
    if (s.includes("UPDATE users SET password_hash")) {
      const u = store.users.find((x) => x.id === params[0]);
      if (!u) {
        return { rows: [], rowCount: 0 };
      }
      u.password_hash = params[1];
      return { rows: [{ id: u.id, username: u.username }], rowCount: 1 };
    }
    if (s.includes("INSERT INTO invites")) {
      if (store.invites.some((i) => i.code === params[0])) {
        const err = new Error("duplicate");
        err.code = "23505";
        throw err;
      }
      const row = {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        code: params[0],
        created_by: params[1],
        created_at: new Date(),
      };
      store.invites.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.includes("FROM sites s") && s.includes("JOIN users")) {
      return {
        rows: store.sites.map((site) => ({
          id: site.id,
          slug: site.slug,
          status: site.status,
          created_at: site.created_at,
          owner: store.users.find((u) => u.id === site.user_id)?.username || "",
        })),
      };
    }
    if (s.includes("FROM sites WHERE id = $1") && !s.includes("site_kv")) {
      const site = store.sites.find((x) => x.id === params[0]);
      return { rows: site ? [{ ...site }] : [] };
    }
    if (s.includes("UPDATE sites SET status = 'taken_down'")) {
      const site = store.sites.find((x) => x.id === params[0]);
      if (site) {
        site.status = "taken_down";
      }
      return { rows: [], rowCount: site ? 1 : 0 };
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
  if (session.status === "disabled") {
    sendJson(res, 403, { error: "disabled" });
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

function jsonOf(res) {
  return res.body ? JSON.parse(res.body) : {};
}

function assertNoSecret(payload) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  assert.ok(!raw.includes(SECRET_KEY), "admin payload leaked API Key plaintext");
  assert.ok(!raw.includes("DEEPSEEK_API_KEY"), "admin payload leaked DEEPSEEK_API_KEY");
}

async function main() {
  const usersRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-k-users-"));
  const snapshots = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-k-snap-"));
  process.env.SNAPSHOTS_ROOT = snapshots;
  process.env.USERS_ROOT = usersRoot;

  fs.mkdirSync(path.join(usersRoot, USER_ID, "home"), { recursive: true });
  fs.writeFileSync(path.join(usersRoot, USER_ID, "home", ".credentials.yaml"), `api_key: ${SECRET_KEY}\n`);
  fs.mkdirSync(path.join(usersRoot, ADMIN_ID, "home"), { recursive: true });

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

  const stopCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/list") && (init.method || "GET") === "GET") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            runtimes: [
              { name: `dsh-runtime-${USER_ID}`, userId: USER_ID, status: "running", running: true },
              { name: `dsh-runtime-${ADMIN_ID}`, userId: ADMIN_ID, status: "exited", running: false },
            ],
          });
        },
      };
    }
    if (u.endsWith("/stop") && init.method === "POST") {
      const body = JSON.parse(init.body || "{}");
      stopCalls.push(body);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            name: `dsh-runtime-${body.userId}`,
            status: "exited",
            running: false,
          });
        },
      };
    }
    const err = new Error(`unexpected fetch ${u}`);
    throw err;
  };

  try {
    await check("/admin and /admin/* are reserved; / and /api are not", () => {
      assert.equal(isAdminPath("/admin"), true);
      assert.equal(isAdminPath("/admin/users"), true);
      assert.equal(isReservedControlPath("/admin"), true);
      assert.equal(isReservedControlPath("/admin/users"), true);
      assert.equal(isReservedControlPath("/admin/sites/takedown"), true);
      assert.equal(isReservedControlPath("/"), false);
      assert.equal(isReservedControlPath("/api"), false);
      assert.equal(isReservedControlPath("/api/events.mux"), false);
    });

    await check("unauthenticated GET /admin → 401", async () => {
      const res = await adminGate({ session: null, method: "GET", url: "/admin", pool, usersRoot });
      assert.equal(res.statusCode, 401);
      assert.equal(jsonOf(res).error, "unauthenticated");
    });

    await check("role=user GET /admin/users → 403", async () => {
      const res = await adminGate({ session: bob, method: "GET", url: "/admin/users", pool, usersRoot });
      assert.equal(res.statusCode, 403);
      assert.equal(jsonOf(res).error, "forbidden");
    });

    await check("platform token is not allowed on /admin", () => {
      assert.equal(isPlatformTokenAllowed("GET", "/admin"), false);
      assert.equal(isPlatformTokenAllowed("GET", "/admin/users"), false);
      assert.equal(isPlatformTokenAllowed("POST", "/admin/invites"), false);
    });

    await check("admin lists users; credentials flag; no Key plaintext", async () => {
      assert.equal(await credentialsFlag(usersRoot, USER_ID), "configured");
      assert.equal(await credentialsFlag(usersRoot, ADMIN_ID), "missing");
      const res = await adminGate({ session: admin, method: "GET", url: "/admin/users", pool, usersRoot });
      assert.equal(res.statusCode, 200);
      const data = jsonOf(res);
      assert.equal(data.users.length, 2);
      const bobRow = data.users.find((u) => u.id === USER_ID);
      const aliceRow = data.users.find((u) => u.id === ADMIN_ID);
      assert.equal(bobRow.username, "bob");
      assert.equal(bobRow.role, "user");
      assert.equal(bobRow.status, "active");
      assert.equal(bobRow.credentials, "configured");
      assert.equal(aliceRow.credentials, "missing");
      assert.equal(Object.hasOwn(bobRow, "password_hash"), false);
      assertNoSecret(res.body);
      const credFile = fs.readFileSync(path.join(usersRoot, USER_ID, "home", ".credentials.yaml"), "utf8");
      assert.ok(credFile.includes(SECRET_KEY));
    });

    await check("admin GET /admin is control-plane HTML, not dsh", async () => {
      const res = await adminGate({ session: admin, method: "GET", url: "/admin", pool, usersRoot });
      assert.equal(res.statusCode, 200);
      assert.match(String(res.headers["content-type"] || ""), /text\/html/);
      assert.match(res.body, /管理面/);
      assert.ok(!res.body.includes("dsh-runtime-skeleton"));
    });

    await check("admin creates invite (generated or specified)", async () => {
      const generated = await adminGate({
        session: admin,
        method: "POST",
        url: "/admin/invites",
        body: "{}",
        pool,
        usersRoot,
      });
      assert.equal(generated.statusCode, 201);
      assert.ok(jsonOf(generated).code);
      const specified = await adminGate({
        session: admin,
        method: "POST",
        url: "/admin/invites",
        body: JSON.stringify({ code: "second-invite-k" }),
        pool,
        usersRoot,
      });
      assert.equal(specified.statusCode, 201);
      assert.equal(jsonOf(specified).code, "second-invite-k");
      assert.equal(store.invites.length, 2);
      assert.ok(store.audit.some((a) => a.action === "invite_create" && a.target === "second-invite-k"));
      assert.equal(store.audit.find((a) => a.action === "invite_create").actor_id, ADMIN_ID);
    });

    await check("admin disables user and stops that runtime", async () => {
      stopCalls.length = 0;
      const res = await adminGate({
        session: admin,
        method: "POST",
        url: "/admin/users/disable",
        body: JSON.stringify({ userId: USER_ID }),
        pool,
        usersRoot,
      });
      assert.equal(res.statusCode, 200);
      const data = jsonOf(res);
      assert.equal(data.user.status, "disabled");
      assert.equal(data.user.username, "bob");
      assert.equal(store.users.find((u) => u.id === USER_ID).status, "disabled");
      assert.equal(stopCalls.length, 1);
      assert.equal(stopCalls[0].userId, USER_ID);
      assert.ok(store.audit.some((a) => a.action === "user_disable" && a.target === USER_ID));
      assertNoSecret(res.body);
    });

    await check("admin lists all sites and takedowns any site", async () => {
      const listed = await adminGate({ session: admin, method: "GET", url: "/admin/sites", pool, usersRoot });
      assert.equal(listed.statusCode, 200);
      const sites = jsonOf(listed).sites;
      assert.equal(sites.length, 1);
      assert.equal(sites[0].slug, "bob-demo");
      assert.equal(sites[0].owner, "bob");
      assert.equal(sites[0].url, "https://bob-demo.pages.localhost/");
      const td = await adminGate({
        session: admin,
        method: "POST",
        url: "/admin/sites/takedown",
        body: JSON.stringify({ siteId: SITE_ID }),
        pool,
        usersRoot,
      });
      assert.equal(td.statusCode, 200);
      assert.equal(jsonOf(td).status, "taken_down");
      assert.equal(store.sites[0].status, "taken_down");
      assert.ok(store.audit.some((a) => a.action === "site_takedown" && a.target === SITE_ID));
      const index = fs.readFileSync(path.join(snapshots, ".index", "bob-demo.json"), "utf8");
      assert.match(index, /taken_down/);
    });

    await check("admin lists runtimes and stops one via manager POST /stop", async () => {
      stopCalls.length = 0;
      const listed = await adminGate({ session: admin, method: "GET", url: "/admin/runtimes", pool, usersRoot });
      assert.equal(listed.statusCode, 200);
      const runtimes = jsonOf(listed).runtimes;
      assert.equal(runtimes.length, 2);
      assert.equal(runtimes[0].status, "running");
      assert.equal(runtimes[1].status, "exited");
      const stopped = await adminGate({
        session: admin,
        method: "POST",
        url: "/admin/runtimes/stop",
        body: JSON.stringify({ userId: USER_ID }),
        pool,
        usersRoot,
      });
      assert.equal(stopped.statusCode, 200);
      assert.equal(stopCalls.length, 1);
      assert.equal(stopCalls[0].userId, USER_ID);
      assert.equal(jsonOf(stopped).status, "exited");
      assert.ok(store.audit.some((a) => a.action === "runtime_stop" && a.target === USER_ID));
    });

    await check("optional reset-password writes hash only (no plaintext in response)", async () => {
      const res = await adminGate({
        session: admin,
        method: "POST",
        url: "/admin/users/reset-password",
        body: JSON.stringify({ userId: USER_ID, password: "new-secret-pass" }),
        pool,
        usersRoot,
      });
      assert.equal(res.statusCode, 200);
      const data = jsonOf(res);
      assert.equal(data.ok, true);
      assert.equal(data.userId, USER_ID);
      assert.ok(!JSON.stringify(data).includes("new-secret-pass"));
      const stored = store.users.find((u) => u.id === USER_ID).password_hash;
      assert.ok(stored.startsWith("scrypt$"));
      assert.equal(await verifyPassword("new-secret-pass", stored), true);
      assert.ok(store.audit.some((a) => a.action === "user_reset_password"));
    });

    await check("login_failed audit stores username, never password", async () => {
      await writeAudit(pool, {
        actorId: null,
        action: "login_failed",
        target: "bob",
        meta: { reason: "invalid_credentials" },
      });
      const row = store.audit.find((a) => a.action === "login_failed");
      assert.ok(row);
      assert.equal(row.actor_id, null);
      assert.equal(row.target, "bob");
      assert.equal(row.meta.reason, "invalid_credentials");
      assert.ok(!JSON.stringify(row).includes("password"));
    });

    await check("manager summarizeListed only keeps dsh-runtime-*", () => {
      const rows = summarizeListed({
        Names: ["/dsh-runtime-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        State: "running",
        Labels: { "dsh.userId": USER_ID },
      });
      assert.equal(rows.name, `dsh-runtime-${USER_ID}`);
      assert.equal(rows.userId, USER_ID);
      assert.equal(rows.status, "running");
      assert.equal(rows.running, true);
      const other = summarizeListed({
        Names: ["/unrelated"],
        State: "exited",
        Labels: {},
      });
      assert.equal(other.name.startsWith("dsh-runtime-"), false);
    });
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(usersRoot, { recursive: true, force: true });
    fs.rmSync(snapshots, { recursive: true, force: true });
  }

  if (failed) {
    process.stderr.write(`\n${failed} check(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nall k-admin-selftest checks passed\n");
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
