"use strict";

/**
 * In-process checks for plate J (official plugin preset packages).
 * No Docker / Postgres required. Run: node platform/scripts/j-plugins-selftest.js
 */

process.env.APP_HOST = process.env.APP_HOST || "app.localhost";
process.env.RUNTIME_MANAGER_URL = process.env.RUNTIME_MANAGER_URL || "http://runtime-manager:8080";
process.env.RUNTIME_MANAGER_TOKEN = process.env.RUNTIME_MANAGER_TOKEN || "j-selftest-manager-token";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "j-selftest-session";
process.env.PLATFORM_TOKEN_SECRET = process.env.PLATFORM_TOKEN_SECRET || "j-selftest-platform";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Readable } = require("node:stream");
const { sendJson, normalizePath } = require("../control-plane/src/http");
const { isReservedControlPath } = require("../control-plane/src/paths");
const { isPlatformTokenAllowed } = require("../control-plane/src/platform-auth");
const { handleAdminRequest } = require("../control-plane/src/admin");
const { HOME_PATCH_CONTENTS } = require("../runtime-manager/src/runtimes");
const {
  FALLBACK_OFFICIAL_PLUGIN_IDS,
  SEED_WEB_DEFAULT_ID,
  SEED_DISABLE_HMR_ID,
  extractOfficialPluginIds,
  looksLikeUserFileRef,
  assertOfficialPluginIds,
  assertPresetPayload,
  repoWebAppPatchPath,
} = require("../control-plane/src/official-plugins");
const {
  parsePatchYaml,
  applyOfficialPreset,
  disabledOfficialIds,
  PLATFORM_PUBLISH_SITE_ID,
  PLATFORM_PUBLISH_SITE_NAME,
} = require("../control-plane/src/plugin-patch");
const {
  isPluginsPath,
  handlePluginsRequest,
} = require("../control-plane/src/plugins");
const { loadOfficialPluginIds } = require("../control-plane/src/official-plugins");

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const B_SECRET = "B-ONLY-SECRET-must-not-leak-or-copy";
const A_PRIVATE = "alice-private";

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

function createMemoryPool() {
  const store = {
    presets: [
      {
        id: SEED_WEB_DEFAULT_ID,
        name: "默认 Web",
        plugin_ids: [],
        description: "官方 Web 默认组合。",
        created_at: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: SEED_DISABLE_HMR_ID,
        name: "关闭 hmr",
        plugin_ids: ["hmr"],
        description: "关闭官方 hmr。",
        created_at: new Date("2026-01-02T00:00:00Z"),
      },
    ],
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
    if (s.includes("FROM plugin_presets") && s.includes("WHERE id")) {
      const row = store.presets.find((p) => p.id === params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (s.includes("FROM plugin_presets") && s.includes("ORDER BY")) {
      return {
        rows: store.presets.map((p) => ({
          id: p.id,
          name: p.name,
          plugin_ids: p.plugin_ids,
        })),
      };
    }
    if (s.includes("INSERT INTO plugin_presets")) {
      const name = params[0];
      if (store.presets.some((p) => p.name === name)) {
        const err = new Error("duplicate");
        err.code = "23505";
        throw err;
      }
      const row = {
        id: randomUUID(),
        name,
        plugin_ids: params[1] || [],
        description: params[2],
        created_at: new Date(),
      };
      store.presets.push(row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return { store, query };
}

async function pluginsGate({ session, method, url, body, pool, usersRoot }) {
  const pathname = normalizePath(url);
  const req = reqOf({ method, url, body });
  const res = mockRes();
  if (!session) {
    sendJson(res, 401, { error: "unauthenticated" });
    return res;
  }
  if (!isPluginsPath(pathname) && !String(pathname).startsWith("/admin")) {
    sendJson(res, 404, { error: "not_found" });
    return res;
  }
  try {
    if (isPluginsPath(pathname)) {
      await handlePluginsRequest(req, res, pool, session, usersRoot);
    }
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

async function adminGate({ session, method, url, body, pool, usersRoot }) {
  const req = reqOf({ method, url, body });
  const res = mockRes();
  if (!session) {
    sendJson(res, 401, { error: "unauthenticated" });
    return res;
  }
  if (session.role !== "admin") {
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

function patchOf(usersRoot, userId) {
  return path.join(usersRoot, userId, "home", "cordis.patch.yml");
}

async function main() {
  const usersRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-j-users-"));
  process.env.USERS_ROOT = usersRoot;

  fs.mkdirSync(path.join(usersRoot, USER_A, "home"), { recursive: true });
  fs.mkdirSync(path.join(usersRoot, USER_B, "home"), { recursive: true });
  fs.mkdirSync(path.join(usersRoot, ADMIN_ID, "home"), { recursive: true });

  const alicePatch = `# Alice overlay
- insert:
    - id: platform-publish-site
      name: /opt/dsh-platform/agent-bridge/index.js
    - id: ${A_PRIVATE}
      name: ./plugins/alice.js
`;
  const bobPatch = `# ${B_SECRET}
- insert:
    - id: bob-private
      name: ./plugins/bob.js
`;
  fs.writeFileSync(patchOf(usersRoot, USER_A), alicePatch);
  fs.writeFileSync(patchOf(usersRoot, USER_B), bobPatch);
  const bobBefore = fs.readFileSync(patchOf(usersRoot, USER_B), "utf8");

  const alice = {
    id: USER_A,
    username: "alice",
    email: null,
    role: "user",
    status: "active",
    created_at: new Date("2026-01-01T00:00:00Z"),
  };
  const bob = {
    id: USER_B,
    username: "bob",
    email: null,
    role: "user",
    status: "active",
    created_at: new Date("2026-01-02T00:00:00Z"),
  };
  const admin = {
    id: ADMIN_ID,
    username: "root",
    email: null,
    role: "admin",
    status: "active",
    created_at: new Date("2026-01-03T00:00:00Z"),
  };

  const { store, query } = createMemoryPool();
  const pool = { query };

  const running = new Set([USER_A, USER_B]);
  const stopCalls = [];
  const ensureCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    if (u.includes("/status/") && method === "GET") {
      const userId = u.slice(u.lastIndexOf("/") + 1);
      const isRunning = running.has(userId);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            name: `dsh-runtime-${userId}`,
            status: isRunning ? "running" : "exited",
            running: isRunning,
          });
        },
      };
    }
    if (u.endsWith("/stop") && method === "POST") {
      const body = JSON.parse(init.body || "{}");
      stopCalls.push(body.userId);
      running.delete(body.userId);
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
    if (u.endsWith("/ensure") && method === "POST") {
      const body = JSON.parse(init.body || "{}");
      ensureCalls.push(body.userId);
      running.add(body.userId);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            name: `dsh-runtime-${body.userId}`,
            status: "running",
            running: true,
          });
        },
      };
    }
    throw new Error(`unexpected fetch ${u}`);
  };

  try {
    await check("/plugins is reserved; / and /api are not", () => {
      assert.equal(isPluginsPath("/plugins"), true);
      assert.equal(isPluginsPath("/plugins/presets"), true);
      assert.equal(isPluginsPath("/plugins/apply"), true);
      assert.equal(isPluginsPath("/plugins/me"), true);
      assert.equal(isReservedControlPath("/plugins"), true);
      assert.equal(isReservedControlPath("/plugins/presets"), true);
      assert.equal(isReservedControlPath("/plugins/me"), true);
      assert.equal(isReservedControlPath("/"), false);
      assert.equal(isReservedControlPath("/api"), false);
      assert.equal(isReservedControlPath("/api/events.mux"), false);
    });

    await check("unauthenticated /plugins/* → 401", async () => {
      for (const url of ["/plugins", "/plugins/presets", "/plugins/me"]) {
        const res = await pluginsGate({ session: null, method: "GET", url, pool, usersRoot });
        assert.equal(res.statusCode, 401, url);
        assert.equal(jsonOf(res).error, "unauthenticated");
      }
      const apply = await pluginsGate({
        session: null,
        method: "POST",
        url: "/plugins/apply",
        body: JSON.stringify({ presetId: SEED_DISABLE_HMR_ID }),
        pool,
        usersRoot,
      });
      assert.equal(apply.statusCode, 401);
    });

    await check("platform token cannot call /plugins", () => {
      assert.equal(isPlatformTokenAllowed("GET", "/plugins"), false);
      assert.equal(isPlatformTokenAllowed("GET", "/plugins/presets"), false);
      assert.equal(isPlatformTokenAllowed("POST", "/plugins/apply"), false);
      assert.equal(isPlatformTokenAllowed("GET", "/plugins/me"), false);
    });

    await check("official id whitelist matches web-app cordis.patch.yml", () => {
      const yamlPath = repoWebAppPatchPath();
      assert.equal(fs.existsSync(yamlPath), true);
      const ids = extractOfficialPluginIds(fs.readFileSync(yamlPath, "utf8"));
      assert.ok(ids.includes("hmr"));
      assert.deepEqual([...ids].sort(), [...FALLBACK_OFFICIAL_PLUGIN_IDS].sort());
      assert.ok(loadOfficialPluginIds().has("hmr"));
      assert.ok(!loadOfficialPluginIds().has("platform-publish-site"));
    });

    await check("path / JS / URL plugin packages are rejected", () => {
      assert.equal(looksLikeUserFileRef("./plugins/alice.js"), true);
      assert.equal(looksLikeUserFileRef("/data/users/a/home/x.js"), true);
      assert.equal(looksLikeUserFileRef("https://evil.example/x.js"), true);
      assert.equal(looksLikeUserFileRef("hmr"), false);
      assert.throws(() => assertOfficialPluginIds(["./evil.js"]), (err) => err.code === "unofficial_plugin");
      assert.throws(() => assertOfficialPluginIds(["../home/x.js"]), (err) => err.code === "unofficial_plugin");
      assert.throws(() => assertOfficialPluginIds(["https://x.example/a.js"]), (err) => err.code === "unofficial_plugin");
      assert.throws(() => assertOfficialPluginIds(["not-a-real-plugin"]), (err) => err.code === "unofficial_plugin");
      assert.throws(
        () => assertPresetPayload({ name: "evil", pluginIds: ["hmr"], path: "./x.js" }),
        (err) => err.code === "unofficial_plugin",
      );
      assert.throws(
        () => assertPresetPayload({ name: "ok", pluginIds: ["hmr"], patch: "- insert:\n  - id: x\n    name: ./x.js" }),
        (err) => err.code === "unofficial_plugin",
      );
      const ok = assertPresetPayload({ name: "关闭 hmr", pluginIds: ["hmr"] });
      assert.deepEqual(ok.pluginIds, ["hmr"]);
    });

    await check("HOME_PATCH_CONTENTS parses and apply keeps platform-publish-site", () => {
      const ops = parsePatchYaml(HOME_PATCH_CONTENTS);
      assert.equal(ops.length, 1);
      assert.equal(ops[0].type, "insert");
      assert.equal(ops[0].plugins[0].id, PLATFORM_PUBLISH_SITE_ID);
      assert.equal(ops[0].plugins[0].fields.name, PLATFORM_PUBLISH_SITE_NAME);
      const official = loadOfficialPluginIds();
      const applied = applyOfficialPreset(HOME_PATCH_CONTENTS, ["hmr"], official);
      assert.match(applied, /id: hmr/);
      assert.match(applied, /disabled: true/);
      assert.match(applied, /id: platform-publish-site/);
      assert.match(applied, /\/opt\/dsh-platform\/agent-bridge\/index\.js/);
      const web = applyOfficialPreset(applied, [], official);
      assert.doesNotMatch(web, /id: hmr/);
      assert.match(web, /id: platform-publish-site/);
    });

    await check("GET /plugins/presets lists seed packages (ids only)", async () => {
      const res = await pluginsGate({ session: alice, method: "GET", url: "/plugins/presets", pool, usersRoot });
      assert.equal(res.statusCode, 200);
      const data = jsonOf(res);
      assert.equal(data.presets.length, 2);
      const names = data.presets.map((p) => p.name);
      assert.ok(names.includes("默认 Web"));
      assert.ok(names.includes("关闭 hmr"));
      const hmr = data.presets.find((p) => p.name === "关闭 hmr");
      assert.deepEqual(hmr.pluginIds, ["hmr"]);
      assert.ok(!JSON.stringify(data).includes(".js"));
      assert.ok(!JSON.stringify(data).includes(B_SECRET));
    });

    await check("GET /plugins is control-plane HTML, not dsh", async () => {
      const res = await pluginsGate({ session: alice, method: "GET", url: "/plugins", pool, usersRoot });
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /官方插件组合/);
      assert.match(res.body, /\/plugins\/apply/);
      assert.doesNotMatch(res.body, /dsh-runtime-skeleton/);
    });

    await check("Alice apply only changes Alice home; Bob file unchanged; runtime restart is Alice only", async () => {
      stopCalls.length = 0;
      ensureCalls.length = 0;
      const res = await pluginsGate({
        session: alice,
        method: "POST",
        url: "/plugins/apply",
        body: JSON.stringify({ presetId: SEED_DISABLE_HMR_ID }),
        pool,
        usersRoot,
      });
      assert.equal(res.statusCode, 200);
      const data = jsonOf(res);
      assert.equal(data.ok, true);
      assert.deepEqual(data.pluginIds, ["hmr"]);
      assert.equal(data.runtime.restarted, true);
      assert.deepEqual(stopCalls, [USER_A]);
      assert.deepEqual(ensureCalls, [USER_A]);

      const aText = fs.readFileSync(patchOf(usersRoot, USER_A), "utf8");
      assert.match(aText, /id: hmr/);
      assert.match(aText, /disabled: true/);
      assert.match(aText, /id: platform-publish-site/);
      assert.match(aText, new RegExp(`id: ${A_PRIVATE}`));
      assert.match(aText, /\.\/plugins\/alice\.js/);
      assert.doesNotMatch(aText, /bob-private/);
      assert.doesNotMatch(aText, new RegExp(B_SECRET));

      const bText = fs.readFileSync(patchOf(usersRoot, USER_B), "utf8");
      assert.equal(bText, bobBefore);
      assert.match(bText, new RegExp(B_SECRET));
      assert.ok(store.audit.some((a) => a.action === "plugin_preset_apply" && a.actor_id === USER_A));
    });

    await check("GET /plugins/me returns disabled official ids, never yaml secrets", async () => {
      const aMe = await pluginsGate({ session: alice, method: "GET", url: "/plugins/me", pool, usersRoot });
      assert.equal(aMe.statusCode, 200);
      const aData = jsonOf(aMe);
      assert.equal(aData.exists, true);
      assert.equal(aData.parsed, true);
      assert.deepEqual(aData.disabledOfficialIds, ["hmr"]);
      assert.ok(!JSON.stringify(aData).includes(B_SECRET));
      assert.ok(!JSON.stringify(aData).includes("alice.js"));

      const bMe = await pluginsGate({ session: bob, method: "GET", url: "/plugins/me", pool, usersRoot });
      const bData = jsonOf(bMe);
      assert.equal(bData.exists, true);
      assert.equal(bData.parsed, true);
      assert.deepEqual(bData.disabledOfficialIds, []);
      assert.ok(!JSON.stringify(bData).includes(B_SECRET));
      assert.ok(!JSON.stringify(bData).includes("bob.js"));
    });

    await check("unreadable patch: exists true, parsed false, no yaml dump", async () => {
      const secret = "sk-unreadable-MUST-NOT-APPEAR";
      fs.writeFileSync(patchOf(usersRoot, USER_B), `not-yaml: ${secret}\n`);
      const res = await pluginsGate({ session: bob, method: "GET", url: "/plugins/me", pool, usersRoot });
      assert.equal(res.statusCode, 200);
      const data = jsonOf(res);
      assert.equal(data.exists, true);
      assert.equal(data.parsed, false);
      assert.equal(data.disabledOfficialIds, undefined);
      assert.ok(!res.body.includes(secret));
      assert.ok(!res.body.includes("not-yaml"));
    });

    await check("apply of path-like unofficial package via admin is 400", async () => {
      const res = await adminGate({
        session: admin,
        method: "POST",
        url: "/admin/plugin-presets",
        body: JSON.stringify({
          name: "evil user js",
          pluginIds: ["./plugins/x.js"],
        }),
        pool,
        usersRoot,
      });
      assert.equal(res.statusCode, 400);
      assert.equal(jsonOf(res).error, "unofficial_plugin");
      const extra = await adminGate({
        session: admin,
        method: "POST",
        url: "/admin/plugin-presets",
        body: JSON.stringify({
          name: "evil extra",
          pluginIds: ["hmr"],
          url: "https://evil.example/p.js",
        }),
        pool,
        usersRoot,
      });
      assert.equal(extra.statusCode, 400);
      assert.equal(jsonOf(extra).error, "unofficial_plugin");
    });

    await check("admin can add an official-id-only preset; user cannot", async () => {
      const denied = await adminGate({
        session: alice,
        method: "POST",
        url: "/admin/plugin-presets",
        body: JSON.stringify({ name: "关闭 tool-web", pluginIds: ["tool-web"] }),
        pool,
        usersRoot,
      });
      assert.equal(denied.statusCode, 403);

      const created = await adminGate({
        session: admin,
        method: "POST",
        url: "/admin/plugin-presets",
        body: JSON.stringify({ name: "关闭 tool-web", pluginIds: ["tool-web"] }),
        pool,
        usersRoot,
      });
      assert.equal(created.statusCode, 201);
      const data = jsonOf(created);
      assert.equal(data.name, "关闭 tool-web");
      assert.deepEqual(data.pluginIds, ["tool-web"]);
      const listed = await pluginsGate({ session: alice, method: "GET", url: "/plugins/presets", pool, usersRoot });
      const names = jsonOf(listed).presets.map((p) => p.name);
      assert.ok(names.includes("关闭 tool-web"));
    });

    await check("unauthenticated POST /admin/plugin-presets → 401", async () => {
      const res = await adminGate({
        session: null,
        method: "POST",
        url: "/admin/plugin-presets",
        body: JSON.stringify({ name: "x", pluginIds: ["hmr"] }),
        pool,
        usersRoot,
      });
      assert.equal(res.statusCode, 401);
    });

    await check("disabledOfficialIds ignores private insert rows", () => {
      const ops = parsePatchYaml(fs.readFileSync(patchOf(usersRoot, USER_A), "utf8"));
      const ids = disabledOfficialIds(ops, loadOfficialPluginIds());
      assert.deepEqual(ids, ["hmr"]);
    });
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(usersRoot, { recursive: true, force: true });
  }

  if (failed) {
    process.stderr.write(`\n${failed} check(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nall j-plugins-selftest checks passed\n");
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
