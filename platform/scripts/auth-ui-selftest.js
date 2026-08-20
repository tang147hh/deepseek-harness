"use strict";

/**
 * In-process checks for login/register HTML pages.
 * No Docker / Postgres required. Run: node platform/scripts/auth-ui-selftest.js
 */

process.env.APP_HOST = process.env.APP_HOST || "app.localhost";

const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const {
  isPublic,
  sendUnauthenticated,
  sendLogoutRedirect,
  handleAuthGetPages,
  LOGIN_HTML,
  REGISTER_HTML,
} = require("../control-plane/src/auth-pages");

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

function jsonOf(res) {
  return res.body ? JSON.parse(res.body) : {};
}

async function main() {
  await check("GET /auth/login and /auth/register are public; POST JSON paths stay public", () => {
    assert.equal(isPublic("GET", "/auth/login"), true);
    assert.equal(isPublic("GET", "/auth/register"), true);
    assert.equal(isPublic("GET", "/auth/logout"), true);
    assert.equal(isPublic("POST", "/auth/login"), true);
    assert.equal(isPublic("POST", "/auth/register"), true);
    assert.equal(isPublic("POST", "/auth/logout"), false);
    assert.equal(isPublic("GET", "/"), false);
    assert.equal(isPublic("GET", "/me"), false);
  });

  await check("unauthenticated GET /auth/login is 200 HTML", () => {
    const req = reqOf({ method: "GET", url: "/auth/login" });
    const res = mockRes();
    const handled = handleAuthGetPages(req, res, null);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"] || ""), /text\/html/);
    assert.equal(res.body, LOGIN_HTML);
    assert.match(res.body, /name="username"/);
    assert.match(res.body, /name="password"/);
    assert.match(res.body, /fetch\("\/auth\/login"/);
    assert.match(res.body, /credentials:\s*"same-origin"/);
    assert.match(res.body, /content-type":\s*"application\/json"/);
    assert.match(res.body, /location = "\/"/);
    assert.doesNotMatch(res.body, /dsh-runtime-skeleton/);
  });

  await check("unauthenticated GET /auth/register is 200 HTML", () => {
    const req = reqOf({ method: "GET", url: "/auth/register" });
    const res = mockRes();
    const handled = handleAuthGetPages(req, res, null);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"] || ""), /text\/html/);
    assert.equal(res.body, REGISTER_HTML);
    assert.match(res.body, /name="username"/);
    assert.match(res.body, /name="password"/);
    assert.match(res.body, /name="inviteCode"/);
    assert.match(res.body, /fetch\("\/auth\/register"/);
    assert.match(res.body, /credentials:\s*"same-origin"/);
    assert.match(res.body, /location = "\/"/);
  });

  await check("POST /auth/login is not consumed by the HTML page handler", () => {
    const req = reqOf({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret-pass" }),
    });
    const res = mockRes();
    const handled = handleAuthGetPages(req, res, null);
    assert.equal(handled, false);
    assert.equal(res.headersSent, false);
  });

  await check("POST /auth/register is not consumed by the HTML page handler", () => {
    const req = reqOf({
      method: "POST",
      url: "/auth/register",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret-pass", inviteCode: "code" }),
    });
    const res = mockRes();
    const handled = handleAuthGetPages(req, res, null);
    assert.equal(handled, false);
    assert.equal(res.headersSent, false);
  });

  await check("logged-in GET /auth/login or /auth/register → 302 /", () => {
    const session = { user: { id: "u1", username: "alice" }, token: "t" };
    for (const url of ["/auth/login", "/auth/register"]) {
      const req = reqOf({ method: "GET", url });
      const res = mockRes();
      assert.equal(handleAuthGetPages(req, res, session), true);
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, "/");
    }
  });

  await check("unauthenticated GET / redirects to /auth/login", () => {
    const req = reqOf({ method: "GET", url: "/", headers: { accept: "text/html" } });
    const res = mockRes();
    sendUnauthenticated(req, res, "/");
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "/auth/login");
    assert.doesNotMatch(String(res.headers["content-type"] || ""), /json/);
  });

  await check("unauthenticated GET / with Accept json stays 401 JSON", () => {
    const req = reqOf({ method: "GET", url: "/", headers: { accept: "application/json" } });
    const res = mockRes();
    sendUnauthenticated(req, res, "/");
    assert.equal(res.statusCode, 401);
    assert.match(String(res.headers["content-type"] || ""), /json/);
    assert.equal(jsonOf(res).error, "unauthenticated");
  });

  await check("unauthenticated GET /files stays 401 JSON", () => {
    const req = reqOf({ method: "GET", url: "/files" });
    const res = mockRes();
    sendUnauthenticated(req, res, "/files");
    assert.equal(res.statusCode, 401);
    assert.equal(jsonOf(res).error, "unauthenticated");
  });

  await check("GET /auth/logout redirects to login and clears cookie", () => {
    const res = mockRes();
    sendLogoutRedirect(res);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "/auth/login");
    const cookie = String(res.headers["set-cookie"] || "");
    assert.match(cookie, /dsh_session=/);
    assert.match(cookie, /Max-Age=0/);
    assert.doesNotMatch(cookie, /Domain=/);
  });

  if (failed) {
    process.exitCode = 1;
    process.stderr.write(`${failed} check(s) failed\n`);
    return;
  }
  process.stdout.write("auth-ui-selftest: all ok\n");
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
