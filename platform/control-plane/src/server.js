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
  sendJson,
  readJson,
  publicUser,
} = require("./http");
const {
  isPublic,
  sendUnauthenticated,
  sendLogoutRedirect,
  handleAuthGetPages,
} = require("./auth-pages");
const {
  handleRuntimeRequest,
  runtimeStatus,
  ensureRuntime,
  proxyUpgrade,
  writeSocketHead,
} = require("./runtime");
const { isFilesPath, handleFilesRequest } = require("./files");
const { isSitesPath, handleSitesRequest } = require("./sites");
const { isPluginsPath, handlePluginsRequest } = require("./plugins");
const { isAdminPath, isAuthPath, isReservedControlPath, isRuntimeAlias } = require("./paths");
const { handleAdminRequest } = require("./admin");
const { writeAudit } = require("./audit");
const { attachRequestLog, logError } = require("./log");
const { tryPlatformUser } = require("./platform-auth");
const { warnIfNoPlatformTokenSecret } = require("./platform-token");

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const host = process.env.HOST ?? "0.0.0.0";
const usersRoot = process.env.USERS_ROOT ?? "/data/users";

const pool = createPool();

// Plate F: after login, / /api /assets and WebSockets proxy to this user's
// dsh-runtime-{id}:3080 (no prefix strip). /runtime is an alias that strips
// /runtime. Reserved: /healthz /auth/* /me /runtime/status /files /files/*
// /sites /sites/* /plugins /plugins/* /admin /admin/*. Agent
// PLATFORM_USER_TOKEN may call POST /sites/publish and GET /sites/list only
// (Bearer; not a login cookie; not /auth, /files, /plugins, or /admin).
// GET /auth/login and GET /auth/register are public HTML; POST JSON APIs
// unchanged. Unauthenticated GET / → 302 /auth/login (Accept json → 401 JSON).
// /files /sites /plugins /admin must stay reserved or F's proxy swallows
// them into dsh. Public KV is on the pages host (/v1/kv), not APP_HOST.
// Never expose dsh to anonymous callers. Do not occupy /api. Do not set
// DEEPSEEK_API_KEY. Official presets only write this user's home yaml.

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

async function handle(req, res) {
  const method = req.method ?? "GET";
  const pathname = normalizePath(req.url);
  const logCtx = attachRequestLog(req, res, { svc: "control-plane" });

  if (method === "GET" && pathname === "/healthz") {
    sendText(res, 200, "ok\n");
    return;
  }

  let session = null;
  let platformOnly = false;
  try {
    session = await loadSessionUser(pool, req);
  } catch (err) {
    logError(err, { svc: "control-plane", method, path: pathname });
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
      logError(err, { svc: "control-plane", method, path: pathname });
      sendJson(res, 500, { error: "internal" });
      return;
    }
  }

  if (session && session.user) {
    logCtx.userId = session.user.id;
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
        logError(err, { svc: "control-plane", method, path: pathname, userId: user.id });
      }
      logCtx.userId = user.id;
      await withSessionCookie(res, 201, publicUser(user), user.id);
      return;
    }

    if (method === "POST" && pathname === "/auth/login") {
      const body = await readJson(req);
      try {
        const user = await authenticateUser(pool, {
          username: body.username,
          password: body.password,
        });
        logCtx.userId = user.id;
        await withSessionCookie(res, 200, publicUser(user), user.id);
      } catch (err) {
        if (err && (err.code === "invalid_credentials" || err.status === 401)) {
          const who = typeof body.username === "string" ? body.username : "";
          await writeAudit(pool, {
            actorId: null,
            action: "login_failed",
            target: who,
            meta: { reason: "invalid_credentials" },
          });
        }
        throw err;
      }
      return;
    }

    if (method === "GET" && pathname === "/auth/logout") {
      if (session && session.token) {
        await revokeSession(pool, session.token);
      }
      sendLogoutRedirect(res);
      return;
    }

    if (method === "POST" && pathname === "/auth/logout") {
      await revokeSession(pool, session.token);
      sendJson(res, 200, { ok: true }, { "set-cookie": clearSessionCookie() });
      return;
    }

    if (handleAuthGetPages(req, res, session)) {
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

    if (isPluginsPath(pathname)) {
      await handlePluginsRequest(req, res, pool, session.user, usersRoot);
      return;
    }

    if (isAdminPath(pathname)) {
      if (session.user.role !== "admin") {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      await handleAdminRequest(req, res, pool, session.user, usersRoot);
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
    logError(err, { svc: "control-plane", method, path: pathname, userId: logCtx.userId });
    sendJson(res, 500, { error: "internal" });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    logError(err, { svc: "control-plane", method: req.method, path: normalizePath(req.url) });
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal" });
    }
  });
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.on("upgrade", (req, socket, head) => {
  handleUpgrade(req, socket, head).catch((err) => {
    logError(err, { svc: "control-plane", method: "UPGRADE", path: normalizePath(req.url) });
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
    logError(err, { svc: "control-plane", method: "UPGRADE", path: pathname });
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
  logError(err, { svc: "control-plane", path: "startup" });
  process.exit(1);
});
