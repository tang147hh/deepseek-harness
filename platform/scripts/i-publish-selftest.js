"use strict";

/**
 * In-process checks for plate I (Agent publish_site + PLATFORM_USER_TOKEN).
 * No Docker / Postgres required. Run: node platform/scripts/i-publish-selftest.js
 */

process.env.APP_HOST = process.env.APP_HOST || "app.localhost";
process.env.PLATFORM_URL = process.env.PLATFORM_URL || "http://control-plane:8080";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Readable } = require("node:stream");
const { generateWriteToken } = require("../control-plane/src/sites");
const { sendJson, normalizePath } = require("../control-plane/src/http");
const {
  signPlatformUserToken,
  verifyPlatformUserToken,
  PREFIX,
} = require("../control-plane/src/platform-token");
const {
  isPlatformTokenAllowed,
  tryPlatformUser,
  bearerToken,
} = require("../control-plane/src/platform-auth");
const {
  writeUserPlatformFiles,
  prepareUserRuntimeFiles,
  HOME_PATCH_CONTENTS,
  needsRecreate,
  runtimeEnvList,
  PLATFORM_URL,
} = require("../runtime-manager/src/runtimes");

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

function usersPool(users) {
  return {
    async query(sql, params = []) {
      const s = String(sql).replace(/\s+/g, " ");
      if (s.includes("FROM users") && s.includes("WHERE id")) {
        const u = users.find((x) => x.id === params[0]);
        return { rows: u ? [{ ...u }] : [] };
      }
      return { rows: [] };
    },
  };
}

async function gate({ sessionUser, req, pool }) {
  const method = req.method ?? "GET";
  const pathname = normalizePath(req.url);
  let user = sessionUser || null;
  let platformOnly = false;
  if (!user) {
    user = await tryPlatformUser(pool, req, method, pathname);
    platformOnly = Boolean(user);
  }
  const res = mockRes();
  if (!user) {
    sendJson(res, 401, { error: "unauthenticated" });
    return { res, user: null, platformOnly: false };
  }
  if (user.status === "disabled") {
    sendJson(res, 403, { error: "disabled" });
    return { res, user, platformOnly };
  }
  if (platformOnly && !isPlatformTokenAllowed(method, pathname)) {
    sendJson(res, 401, { error: "unauthenticated" });
    return { res, user: null, platformOnly: true };
  }
  sendJson(res, 200, { ok: true, userId: user.id, via: platformOnly ? "platform" : "cookie" });
  return { res, user, platformOnly };
}

async function main() {
  process.env.PLATFORM_TOKEN_SECRET = "i-selftest-platform-secret";
  process.env.SESSION_SECRET = "i-selftest-session-secret";
  process.env.APP_HOST = "app.localhost";

  const alice = { id: USER_A, username: "alice", email: null, role: "user", status: "active", created_at: new Date() };
  const bob = { id: USER_B, username: "bob", email: null, role: "user", status: "active", created_at: new Date() };
  const pool = usersPool([alice, bob]);
  const tokenA = signPlatformUserToken(USER_A);
  const tokenB = signPlatformUserToken(USER_B);

  await check("HMAC token verifies as the bound userId", () => {
    const claims = verifyPlatformUserToken(tokenA);
    assert.equal(claims.sub, USER_A);
    assert.notEqual(claims.sub, USER_B);
  });

  await check("token signed for A does not verify as B", () => {
    const claims = verifyPlatformUserToken(tokenA);
    assert.equal(claims.sub, USER_A);
    const b = verifyPlatformUserToken(tokenB);
    assert.equal(b.sub, USER_B);
  });

  await check("expired token is rejected", () => {
    const expired = signPlatformUserToken(USER_A, { now: 1_000_000, ttlSeconds: 10 });
    assert.equal(verifyPlatformUserToken(expired, { now: 1_000_020 }), null);
  });

  await check("KV writeToken is not a PLATFORM_USER_TOKEN", () => {
    const kv = generateWriteToken();
    assert.equal(verifyPlatformUserToken(kv), null);
    assert.ok(!String(kv).startsWith(PREFIX));
  });

  await check("SESSION_SECRET cannot mint a platform token", () => {
    const real = process.env.PLATFORM_TOKEN_SECRET;
    process.env.PLATFORM_TOKEN_SECRET = process.env.SESSION_SECRET;
    const forged = signPlatformUserToken(USER_A);
    process.env.PLATFORM_TOKEN_SECRET = real;
    assert.equal(verifyPlatformUserToken(forged), null);
  });

  await check("Bearer A on POST /sites/publish resolves user A", async () => {
    const { res, user, platformOnly } = await gate({
      pool,
      req: reqOf({
        method: "POST",
        url: "/sites/publish",
        headers: { authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({ dir: "sites/demo" }),
      }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(user.id, USER_A);
    assert.equal(platformOnly, true);
    assert.ok(!JSON.parse(res.body).userId || JSON.parse(res.body).userId === USER_A);
  });

  await check("Bearer A cannot be treated as user B", async () => {
    const { user } = await gate({
      pool,
      req: reqOf({
        method: "POST",
        url: "/sites/publish",
        headers: { authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({ dir: "sites/demo" }),
      }),
    });
    assert.equal(user.id, USER_A);
    assert.notEqual(user.id, USER_B);
    const { user: other } = await gate({
      pool,
      req: reqOf({
        method: "POST",
        url: "/sites/publish",
        headers: { authorization: `Bearer ${tokenB}` },
        body: JSON.stringify({ dir: "sites/demo" }),
      }),
    });
    assert.equal(other.id, USER_B);
  });

  await check("KV writeToken on POST /sites/publish → 401", async () => {
    const { res, user } = await gate({
      pool,
      req: reqOf({
        method: "POST",
        url: "/sites/publish",
        headers: { authorization: `Bearer ${generateWriteToken()}` },
        body: JSON.stringify({ dir: "sites/demo" }),
      }),
    });
    assert.equal(res.statusCode, 401);
    assert.equal(user, null);
    assert.equal(JSON.parse(res.body).error, "unauthenticated");
  });

  await check("no token on POST /sites/publish → 401 (container has no dsh_session)", async () => {
    const { res } = await gate({
      pool,
      req: reqOf({
        method: "POST",
        url: "/sites/publish",
        headers: {},
        body: JSON.stringify({ dir: "sites/demo" }),
      }),
    });
    assert.equal(res.statusCode, 401);
  });

  await check("platform token cannot call /files or /auth or /me", async () => {
    for (const [method, url] of [
      ["GET", "/files"],
      ["POST", "/files/upload"],
      ["POST", "/auth/logout"],
      ["GET", "/me"],
      ["GET", "/sites"],
      ["POST", "/sites/takedown"],
      ["POST", "/sites/token"],
      ["GET", "/api"],
    ]) {
      const { res } = await gate({
        pool,
        req: reqOf({
          method,
          url,
          headers: { authorization: `Bearer ${tokenA}` },
        }),
      });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
  });

  await check("GET /sites/list is allowed for platform token", async () => {
    const { res, user } = await gate({
      pool,
      req: reqOf({
        method: "GET",
        url: "/sites/list",
        headers: { authorization: `Bearer ${tokenA}` },
      }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(user.id, USER_A);
  });

  await check("Cookie identity still wins over a Bearer token", async () => {
    const { res, user, platformOnly } = await gate({
      pool,
      sessionUser: alice,
      req: reqOf({
        method: "POST",
        url: "/sites/publish",
        headers: { authorization: `Bearer ${tokenB}` },
        body: JSON.stringify({ dir: "sites/demo" }),
      }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(user.id, USER_A);
    assert.equal(platformOnly, false);
  });

  await check("platform token is not a login cookie (verify ignores random cookies)", () => {
    assert.equal(verifyPlatformUserToken("not-a-platform-token"), null);
    assert.ok(tokenA.startsWith(PREFIX));
    assert.equal(bearerToken({ headers: { cookie: `dsh_session=${tokenA}` } }), "");
  });

  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-i-home-"));
  try {
    await check("ensure writes .platform-token mode 0600 and patch once", async () => {
      const first = await writeUserPlatformFiles(USER_A, tokenA, homeRoot);
      assert.equal(first.patchWritten, true);
      const tokenPath = path.join(homeRoot, USER_A, "home", ".platform-token");
      const patchPath = path.join(homeRoot, USER_A, "home", "cordis.patch.yml");
      assert.equal(fs.readFileSync(tokenPath, "utf8").trim(), tokenA);
      assert.equal(fs.readFileSync(patchPath, "utf8"), HOME_PATCH_CONTENTS);
      if (process.platform !== "win32") {
        const mode = fs.statSync(tokenPath).mode & 0o777;
        assert.equal(mode, 0o600);
      }
      fs.writeFileSync(patchPath, "- id: custom\n  name: ./keep-me\n");
      const rotated = signPlatformUserToken(USER_A);
      const second = await writeUserPlatformFiles(USER_A, rotated, homeRoot);
      assert.equal(second.patchWritten, false);
      assert.equal(fs.readFileSync(tokenPath, "utf8").trim(), rotated);
      assert.equal(fs.readFileSync(patchPath, "utf8"), "- id: custom\n  name: ./keep-me\n");
    });
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }

  const ownershipRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-i-ownership-"));
  const previousUid = process.env.RUNTIME_UID;
  const previousGid = process.env.RUNTIME_GID;
  try {
    await check("ensure creates profiles and recursively owns new user files", async () => {
      if (process.platform !== "win32" && typeof process.getuid === "function") {
        if (process.getuid() === 0) {
          delete process.env.RUNTIME_UID;
          delete process.env.RUNTIME_GID;
        } else {
          process.env.RUNTIME_UID = String(process.getuid());
          process.env.RUNTIME_GID = String(process.getgid());
        }
      }
      await prepareUserRuntimeFiles(USER_A, tokenA, ownershipRoot);
      const home = path.join(ownershipRoot, USER_A, "home");
      const profiles = path.join(home, "profiles");
      const workspace = path.join(ownershipRoot, USER_A, "workspace");
      const tokenPath = path.join(home, ".platform-token");
      assert.equal(fs.statSync(profiles).isDirectory(), true);
      assert.equal(fs.statSync(workspace).isDirectory(), true);
      if (process.platform !== "win32" && typeof process.getuid === "function") {
        const expectedUid = process.getuid() === 0 ? 1000 : process.getuid();
        const expectedGid = process.getuid() === 0 ? 1000 : process.getgid();
        for (const target of [home, profiles, workspace, tokenPath]) {
          const stat = fs.statSync(target);
          assert.equal(stat.uid, expectedUid, target);
          assert.equal(stat.gid, expectedGid, target);
        }
      }
    });
  } finally {
    if (previousUid === undefined) {
      delete process.env.RUNTIME_UID;
    } else {
      process.env.RUNTIME_UID = previousUid;
    }
    if (previousGid === undefined) {
      delete process.env.RUNTIME_GID;
    } else {
      process.env.RUNTIME_GID = previousGid;
    }
    fs.rmSync(ownershipRoot, { recursive: true, force: true });
  }

  await check("create Env has PLATFORM_TOKEN and PLATFORM_URL, no DEEPSEEK_API_KEY", () => {
    const env = runtimeEnvList(USER_A, tokenA);
    assert.ok(env.includes(`PLATFORM_TOKEN=${tokenA}`));
    assert.ok(env.includes(`PLATFORM_URL=${PLATFORM_URL}`));
    assert.equal(PLATFORM_URL, "http://control-plane:8080");
    assert.ok(!env.some((line) => line.startsWith("DEEPSEEK_API_KEY=")));
    assert.ok(!env.some((line) => line.startsWith("SESSION_SECRET=")));
  });

  await check("needsRecreate when PLATFORM_URL / PLATFORM_TOKEN missing", () => {
    const base = {
      Config: {
        Env: [
          "DSH_TRUST_GATEWAY=1",
          "APP_HOST=app.localhost",
          "PLATFORM_URL=http://control-plane:8080",
          "PLATFORM_TOKEN=x",
        ],
        Image: "dsh-runtime:web",
      },
    };
    assert.equal(needsRecreate(base), false);
    assert.equal(needsRecreate({ Config: { Env: ["DSH_TRUST_GATEWAY=1", "APP_HOST=app.localhost"], Image: "dsh-runtime:web" } }), true);
  });

  const bridge = await import(pathToFileURL(path.join(__dirname, "../agent-bridge/index.js")).href);

  await check("plugin parsePublishDir matches G (sites/<name> only)", () => {
    assert.deepEqual(bridge.parsePublishDir("sites/demo"), { rel: "sites/demo", name: "demo" });
    assert.throws(() => bridge.parsePublishDir("../home"), /invalid_path/);
    assert.throws(() => bridge.parsePublishDir("/etc/passwd"), /invalid_path/);
    assert.throws(() => bridge.parsePublishDir("sites/a/b"), /invalid_path/);
    assert.throws(() => bridge.parsePublishDir("workspace/sites/demo"), /invalid_path/);
    assert.throws(() => bridge.parsePublishDir("sites"), /invalid_path/);
  });

  await check("plugin POSTs Bearer to PLATFORM_URL/sites/publish and surfaces writeToken", async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return {
        status: 200,
        ok: true,
        async text() {
          return JSON.stringify({
            ok: true,
            url: "https://alice-demo.pages.localhost/",
            slug: "alice-demo",
            writeToken: "once-only-token",
            version: 1,
          });
        },
      };
    };
    const json = await bridge.callPublishSite({
      dir: "sites/demo",
      token: tokenA,
      platformUrl: "http://control-plane:8080",
      fetchImpl,
    });
    assert.equal(captured.url, "http://control-plane:8080/sites/publish");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers.authorization, `Bearer ${tokenA}`);
    assert.equal(JSON.parse(captured.init.body).dir, "sites/demo");
    assert.equal(json.writeToken, "once-only-token");
    const rendered = bridge.formatPublishResult(json);
    assert.match(rendered, /https:\/\/alice-demo\.pages\.localhost\//);
    assert.match(rendered, /once-only-token/);
  });

  await check("plugin 401 without token (container logic)", async () => {
    await assert.rejects(
      () => bridge.callPublishSite({ dir: "sites/demo", token: "", platformUrl: "http://control-plane:8080" }),
      /PLATFORM_USER_TOKEN/,
    );
  });

  await check("plugin reads $DSH_HOME/.platform-token in preference to env", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-i-tok-"));
    fs.writeFileSync(path.join(dir, ".platform-token"), `${tokenA}\n`, { mode: 0o600 });
    try {
      const got = await bridge.readPlatformToken(dir, { PLATFORM_TOKEN: "env-stale", DSH_HOME: dir }, fsPromises.readFile);
      assert.equal(got, tokenA);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check("tool registers publish_site with one approval prompt and no silent publish", () => {
    const registered = [];
    const ctx = {
      tools: {
        register(def) {
          registered.push(def);
          return () => {};
        },
      },
      get() {
        return undefined;
      },
    };
    bridge.apply(ctx);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "publish_site");
    assert.match(registered[0].description, /Writing or creating a website is not permission to publish/i);
    assert.match(registered[0].description, /approval card is the only question/i);
    assert.match(registered[0].description, /Do not ask.*prose.*ask_user_question/i);
    assert.match(registered[0].description, /explicitly asked to publish or go live/i);
    assert.equal(registered[0].presentCall({ dir: "sites/demo" }).title, "发布站点到公网");
    assert.match(bridge.buildApprovalReason("sites/demo"), /发布到公网/);
    assert.match(
      bridge.buildApprovalReason("sites/demo"),
      /https:\/\/\{username\}-demo\.\{PAGES_PARENT\}\//,
    );
    assert.match(
      bridge.buildApprovalReason("sites/demo", "chosen-slug"),
      /https:\/\/chosen-slug\.\{PAGES_PARENT\}\//,
    );
    assert.ok(!String(registered[0].name).includes("/api"));
    const src = fs.readFileSync(path.join(__dirname, "../agent-bridge/index.js"), "utf8");
    assert.ok(!src.includes("listen("));
    assert.ok(!src.includes('"/api"'));
    assert.ok(src.includes("/sites/publish"));
  });

  await check("approval missing: fail closed without publishing", async () => {
    const registered = [];
    let published = false;
    const ctx = {
      tools: {
        register(def) {
          registered.push(def);
        },
      },
      get() {
        return undefined;
      },
    };
    bridge.apply(ctx);
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      published = true;
      return { status: 200, ok: true, text: async () => "{}" };
    };
    try {
      await assert.rejects(
        () => registered[0].execute({ dir: "sites/demo" }, { agent: { id: "a" }, callId: "c0" }),
        /approval service is required/,
      );
      assert.equal(published, false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  await check("approval composed: rejected does not publish", async () => {
    const registered = [];
    let published = false;
    let reason = "";
    const ctx = {
      tools: {
        register(def) {
          registered.push(def);
        },
      },
      get(name) {
        if (name === "approval") {
          return {
            async request(input) {
              reason = input.reason;
              return "rejected";
            },
          };
        }
        return undefined;
      },
    };
    bridge.apply(ctx);
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      published = true;
      return { status: 200, ok: true, text: async () => "{}" };
    };
    try {
      await assert.rejects(
        () => registered[0].execute({ dir: "sites/demo" }, { agent: { id: "a" }, callId: "c1" }),
        /not approved/,
      );
      assert.equal(published, false);
      assert.match(reason, /发布到公网/);
      assert.match(reason, /https:\/\/\{username\}-demo\.\{PAGES_PARENT\}\//);
    } finally {
      globalThis.fetch = orig;
    }
  });

  await check("approval allowed-once publishes and returns the public URL", async () => {
    const registered = [];
    let approvalCalls = 0;
    let published = false;
    const ctx = {
      tools: {
        register(def) {
          registered.push(def);
        },
      },
      get(name) {
        if (name === "approval") {
          return {
            async request() {
              approvalCalls += 1;
              return "allowed-once";
            },
          };
        }
        return undefined;
      },
    };
    bridge.apply(ctx);
    const origFetch = globalThis.fetch;
    const previousToken = process.env.PLATFORM_TOKEN;
    process.env.PLATFORM_TOKEN = tokenA;
    globalThis.fetch = async () => {
      published = true;
      return {
        status: 200,
        ok: true,
        async text() {
          return JSON.stringify({
            ok: true,
            url: "https://alice-demo.pages.localhost/",
            slug: "alice-demo",
            version: 1,
          });
        },
      };
    };
    try {
      const result = await registered[0].execute(
        { dir: "sites/demo" },
        { agent: { id: "a" }, callId: "c2" },
      );
      assert.equal(approvalCalls, 1);
      assert.equal(published, true);
      assert.equal(result.url, "https://alice-demo.pages.localhost/");
    } finally {
      globalThis.fetch = origFetch;
      if (previousToken === undefined) {
        delete process.env.PLATFORM_TOKEN;
      } else {
        process.env.PLATFORM_TOKEN = previousToken;
      }
    }
  });

  if (failed) {
    process.stderr.write(`\n${failed} check(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nall i-publish-selftest checks passed\n");
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
