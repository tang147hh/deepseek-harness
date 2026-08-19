"use strict";

const fs = require("node:fs");
const http = require("node:http");
const docker = require("./docker");
const { normalizePath, sendText, sendJson, readJson, bearerToken, tokenOk } = require("./http");
const runtimes = require("./runtimes");

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const host = process.env.HOST ?? "0.0.0.0";
const token = String(process.env.RUNTIME_MANAGER_TOKEN ?? "").trim();

function requireAuth(req, res) {
  if (!tokenOk(bearerToken(req), token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function userIdFromPath(pathname, prefix) {
  if (!pathname.startsWith(prefix)) {
    return "";
  }
  return pathname.slice(prefix.length);
}

function sendErr(res, err) {
  if (err && err.status) {
    sendJson(res, err.status, { error: err.code || "error", ...(err.extra || {}) });
    return;
  }
  process.stderr.write(`runtime-manager error: ${err.stack || err.message}\n`);
  sendJson(res, 500, { error: "internal" });
}

async function handle(req, res) {
  const method = req.method ?? "GET";
  const pathname = normalizePath(req.url);

  if (method === "GET" && pathname === "/healthz") {
    sendText(res, 200, "ok\n");
    return;
  }

  if (!requireAuth(req, res)) {
    return;
  }

  if (method === "POST" && pathname === "/ensure") {
    const body = await readJson(req);
    const result = await runtimes.ensure(body.userId);
    sendJson(res, 200, result);
    return;
  }

  if (method === "GET" && pathname.startsWith("/status/")) {
    const userId = userIdFromPath(pathname, "/status/");
    const result = await runtimes.status(userId);
    sendJson(res, 200, result);
    return;
  }

  if (method === "POST" && pathname.startsWith("/stop/")) {
    const userId = userIdFromPath(pathname, "/stop/");
    const result = await runtimes.stop(userId);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) {
      sendErr(res, err);
    }
  });
});
server.requestTimeout = 0;
server.headersTimeout = 180_000;

let idleTimer = null;

async function main() {
  if (!token) {
    process.stderr.write("runtime-manager: RUNTIME_MANAGER_TOKEN is empty; refusing to start\n");
    process.exit(1);
  }
  if (!fs.existsSync(docker.SOCKET)) {
    process.stderr.write(`runtime-manager: ${docker.SOCKET} is missing; mount the host docker.sock (read-only is ok)\n`);
    process.exit(1);
  }

  await runtimes.assertReady();
  const limits = runtimes.limits();
  process.stdout.write(
    `runtime-manager: image=${limits.image} network=${limits.network} HOST_DATA_ROOT=${limits.hostDataRoot} ` +
      `APP_HOST=${limits.appHost} PLATFORM_URL=${limits.platformUrl} memory=${limits.memoryBytes} nanoCpus=${limits.nanoCpus} ` +
      `maxRuntimes=${limits.maxRuntimes} idleSeconds=${limits.idleSeconds} readyTimeoutMs=${limits.readyTimeoutMs}\n`,
  );

  const checkMs = Math.min(30_000, Math.max(5_000, Math.floor((runtimes.IDLE_SECONDS * 1000) / 30)));
  idleTimer = setInterval(() => {
    runtimes.sweepIdle().catch((err) => {
      process.stderr.write(`idle sweep failed: ${err.message}\n`);
    });
  }, checkMs);
  idleTimer.unref();

  server.listen(port, host, () => {
    process.stdout.write(`runtime-manager listening on ${host}:${port} (internal only; do not publish)\n`);
  });
}

function shutdown(signal) {
  process.stdout.write(`runtime-manager received ${signal}, shutting down\n`);
  if (idleTimer) {
    clearInterval(idleTimer);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  process.stderr.write(`runtime-manager failed to start: ${err.stack || err.message}\n`);
  process.exit(1);
});
