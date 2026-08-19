"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { createPool, migrate, bootstrapInviteIfEmpty } = require("./db");
const {
  createSession,
  loadSessionUser,
  revokeSession,
  registerUser,
  authenticateUser,
  warnIfNoSessionSecret,
} = require("./auth");
const {
  normalizePath,
  sessionCookie,
  clearSessionCookie,
  sendText,
  sendHtml,
  sendJson,
  readJson,
  publicUser,
} = require("./http");
const {
  handleRuntimeRequest,
  runtimeStatus,
  ensureRuntime,
  proxyUpgrade,
  writeSocketHead,
} = require("./runtime");
const { isFilesPath, handleFilesRequest } = require("./files");
const { isSitesPath, handleSitesRequest } = require("./sites");
const { tryPlatformUser } = require("./platform-auth");
const { warnIfNoPlatformTokenSecret } = require("./platform-token");

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const host = process.env.HOST ?? "0.0.0.0";
const usersRoot = process.env.USERS_ROOT ?? "/data/users";

const pool = createPool();

// Plate F: after login, / /api /assets and WebSockets proxy to this user's
// dsh-runtime-{id}:3080 (no prefix strip). /runtime is an alias that strips
// /runtime. Reserved: /healthz /auth/* /me /runtime/status /files /files/*
// /sites /sites/* (list, publish, rollback, takedown, token). Agent
// PLATFORM_USER_TOKEN may call POST /sites/publish and GET /sites/list only
// (Bearer; not a login cookie; not /auth or /files). /files and /sites must
// stay reserved or F's proxy swallows them into dsh. Public KV is on the
// pages host (/v1/kv), not APP_HOST. Never expose dsh to anonymous callers.
// Do not occupy /api. Do not set DEEPSEEK_API_KEY.

const LOGIN_HINT = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in</title>
</head>
<body>
  <h1>DeepSeek Harness</h1>
  <p>登录后打开本站根路径即可使用 Agent UI。未登录不会代理到任何人的 dsh。</p>
  <p>用 JSON 调用 <code>POST /auth/login</code> 或 <code>POST /auth/register</code>（需要邀请码），再刷新 <code>/</code>。</p>
</body>
</html>
`;

function isPublic(method, pathname) {
  if (method === "GET" && pathname === "/healthz") {
    return true;
  }
  if (method === "POST" && (pathname === "/auth/login" || pathname === "/auth/register")) {
    return true;
  }
  return false;
}

function isAuthPath(pathname) {
  return pathname === "/auth/login"
    || pathname === "/auth/register"
    || pathname === "/auth/logout"
    || pathname.startsWith("/auth/");
}

function isReservedControlPath(pathname) {
  return pathname === "/healthz"
    || pathname === "/me"
    || pathname === "/runtime/status"
    || isAuthPath(pathname)
    || isFilesPath(pathname)
    || isSitesPath(pathname);
}

function isRuntimeAlias(pathname) {
  return pathname === "/runtime" || pathname.startsWith("/runtime/");
}

async function ensureUserDirs(userId) {
  const home = path.join(usersRoot, userId, "home");
  const workspace = path.join(usersRoot, userId, "workspace");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
}

async function withSessionCookie(res, status, body, userId) {
  const { token, maxAge } = await createSession(pool, userId);
  sendJson(res, status, body, { "set-cookie": sessionCookie(token, maxAge) });
}

function sendUnauthenticated(req, res, pathname) {
  if ((req.method ?? "GET") === "GET" && pathname === "/") {
    sendHtml(res, 401, LOGIN_HINT);
    return;
  }
  sendJson(res, 401, { error: "unauthenticated" });
}

async function handle(req, res) {
  const method = req.method ?? "GET";
  const pathname = normalizePath(req.url);

  if (method === "GET" && pathname === "/healthz") {
    sendText(res, 200, "ok\n");
    return;
  }

  let session = null;
  let platformOnly = false;
  try {
    session = await loadSessionUser(pool, req);
  } catch (err) {
    process.stderr.write(`session lookup failed: ${err.message}\n`);
    sendJson(res, 500, { error: "internal" });
    return;
  }

  if (!isPublic(method, pathname) && !session) {
    try {
      const platformUser = await tryPlatformUser(pool, req, method, pathname);
      if (platformUser) {
        session = { user: platformUser, token: null };
        platformOnly = true;
      }
    } catch (err) {
      process.stderr.write(`platform token lookup failed: ${err.message}\n`);
      sendJson(res, 500, { error: "internal" });
      return;
    }
  }

  if (!isPublic(method, pathname) && !session) {
    sendUnauthenticated(req, res, pathname);
    return;
  }

  if (session && session.user.status === "disabled" && pathname !== "/auth/logout") {
    sendJson(res, 403, { error: "disabled" });
    return;
  }

  try {
    if (method === "POST" && pathname === "/auth/register") {
      const body = await readJson(req);
      const user = await registerUser(pool, {
        username: body.username,
        password: body.password,
        inviteCode: body.inviteCode,
      });
      try {
        await ensureUserDirs(user.id);
      } catch (err) {
        process.stderr.write(`mkdir users/${user.id} failed: ${err.message}\n`);
      }
      await withSessionCookie(res, 201, publicUser(user), user.id);
      return;
    }

    if (method === "POST" && pathname === "/auth/login") {
      const body = await readJson(req);
      const user = await authenticateUser(pool, {
        username: body.username,
        password: body.password,
      });
      await withSessionCookie(res, 200, publicUser(user), user.id);
      return;
    }

    if (method === "POST" && pathname === "/auth/logout") {
      await revokeSession(pool, session.token);
      sendJson(res, 200, { ok: true }, { "set-cookie": clearSessionCookie() });
      return;
    }

    if (platformOnly) {
      if (isSitesPath(pathname)) {
        await handleSitesRequest(req, res, pool, session.user, usersRoot);
        return;
      }
      sendJson(res, 401, { error: "unauthenticated" });
      return;
    }

    if (method === "GET" && pathname === "/me") {
      sendJson(res, 200, publicUser(session.user));
      return;
    }

    if (method === "GET" && pathname === "/runtime/status") {
      try {
        const st = await runtimeStatus(session.user.id);
        sendJson(res, 200, st);
      } catch (err) {
        if (err && err.status) {
          sendJson(res, err.status, err.body && err.body.error ? err.body : { error: err.code || "error" });
          return;
        }
        throw err;
      }
      return;
    }

    if (isFilesPath(pathname)) {
      await handleFilesRequest(req, res, session.user.id, usersRoot);
      return;
    }

    if (isSitesPath(pathname)) {
      await handleSitesRequest(req, res, pool, session.user, usersRoot);
      return;
    }

    if (
      pathname === "/auth/register"
      || pathname === "/auth/login"
      || pathname === "/auth/logout"
      || pathname === "/me"
    ) {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (isAuthPath(pathname)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    await handleRuntimeRequest(req, res, session.user.id);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err && err.status) {
      sendJson(res, err.status, { error: err.code || "error" });
      return;
    }
    process.stderr.write(`request failed ${method} ${pathname}: ${err.stack || err.message}\n`);
    sendJson(res, 500, { error: "internal" });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    process.stderr.write(`unhandled request error: ${err.stack || err.message}\n`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal" });
    }
  });
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.on("upgrade", (req, socket, head) => {
  handleUpgrade(req, socket, head).catch((err) => {
    process.stderr.write(`upgrade failed: ${err.stack || err.message}\n`);
    try {
      writeSocketHead(
        socket,
        500,
        "Internal Server Error",
        { "content-type": "application/json", connection: "close" },
        `${JSON.stringify({ error: "internal" })}\n`,
      );
    } catch {
      // ignore
    }
    socket.destroy();
  });
});

async function handleUpgrade(req, socket, head) {
  const pathname = normalizePath(req.url);
  if (pathname === "/runtime/status" || (isReservedControlPath(pathname) && !isRuntimeAlias(pathname))) {
    writeSocketHead(socket, 404, "Not Found", { connection: "close" });
    socket.destroy();
    return;
  }

  let session = null;
  try {
    session = await loadSessionUser(pool, req);
  } catch (err) {
    process.stderr.write(`session lookup failed: ${err.message}\n`);
    writeSocketHead(
      socket,
      500,
      "Internal Server Error",
      { "content-type": "application/json", connection: "close" },
      `${JSON.stringify({ error: "internal" })}\n`,
    );
    socket.destroy();
    return;
  }

  if (!session) {
    writeSocketHead(
      socket,
      401,
      "Unauthorized",
      { "content-type": "application/json", connection: "close" },
      `${JSON.stringify({ error: "unauthenticated" })}\n`,
    );
    socket.destroy();
    return;
  }

  if (session.user.status === "disabled") {
    writeSocketHead(
      socket,
      403,
      "Forbidden",
      { "content-type": "application/json", connection: "close" },
      `${JSON.stringify({ error: "disabled" })}\n`,
    );
    socket.destroy();
    return;
  }

  try {
    await ensureRuntime(session.user.id);
  } catch (err) {
    const status = err.status || 502;
    const body = err.body && err.body.error ? err.body : { error: err.code || "error" };
    writeSocketHead(
      socket,
      status,
      "Error",
      { "content-type": "application/json", connection: "close" },
      `${JSON.stringify(body)}\n`,
    );
    socket.destroy();
    return;
  }

  proxyUpgrade(req, socket, head, session.user.id);
}

async function main() {
  warnIfNoSessionSecret();
  warnIfNoPlatformTokenSecret();
  await migrate(pool);
  await bootstrapInviteIfEmpty(pool);
  server.listen(port, host, () => {
    process.stdout.write(`control-plane listening on ${host}:${port}\n`);
  });
}

function shutdown(signal) {
  process.stdout.write(`control-plane received ${signal}, shutting down\n`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  process.stderr.write(`control-plane failed to start: ${err.stack || err.message}\n`);
  process.exit(1);
});
