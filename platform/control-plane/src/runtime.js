"use strict";

const http = require("node:http");
const { sendJson } = require("./http");

const LISTEN_PORT = 3080;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
]);

function managerBase() {
  return String(process.env.RUNTIME_MANAGER_URL ?? "http://runtime-manager:8080").replace(/\/+$/, "");
}

function managerToken() {
  return String(process.env.RUNTIME_MANAGER_TOKEN ?? "").trim();
}

function appHost() {
  return String(process.env.APP_HOST ?? "").trim();
}

function runtimeHost(userId) {
  return `dsh-runtime-${userId}`;
}

function rewriteRuntimeUrl(reqUrl) {
  const raw = String(reqUrl ?? "/");
  const q = raw.indexOf("?");
  const pathPart = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? "" : raw.slice(q);
  let rest;
  if (pathPart === "/runtime") {
    rest = "/";
  } else if (pathPart.startsWith("/runtime/")) {
    rest = pathPart.slice("/runtime".length) || "/";
  } else {
    rest = pathPart;
  }
  return rest + query;
}

async function managerFetch(pathname, { method = "GET", body } = {}) {
  const url = `${managerBase()}${pathname}`;
  const headers = {
    authorization: `Bearer ${managerToken()}`,
    accept: "application/json",
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  // dsh cold start can exceed 30s; manager READY default is 120s.
  init.signal = AbortSignal.timeout(180_000);

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const wrapped = new Error("runtime_manager_unreachable");
    wrapped.status = 503;
    wrapped.code = "runtime_manager_unreachable";
    wrapped.cause = err;
    throw wrapped;
  }

  const text = await res.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: "runtime_manager_bad_response", raw: text.slice(0, 200) };
    }
  }

  if (res.status === 401) {
    const err = new Error("runtime_manager_unauthorized");
    err.status = 503;
    err.code = "runtime_manager_unauthorized";
    throw err;
  }
  if (!res.ok) {
    const err = new Error(json.error || "runtime_manager_error");
    err.status = res.status;
    err.code = json.error || "runtime_manager_error";
    err.body = json;
    throw err;
  }
  return json;
}

async function ensureRuntime(userId) {
  return managerFetch("/ensure", { method: "POST", body: { userId } });
}

async function runtimeStatus(userId) {
  return managerFetch(`/status/${encodeURIComponent(userId)}`);
}

async function stopRuntime(userId) {
  return managerFetch("/stop", { method: "POST", body: { userId } });
}

/**
 * If this user's container is running, stop then ensure so a home overlay
 * (cordis.patch.yml) is picked up. Missing/exited: leave it; next GET / ensures.
 * Control-plane never talks to docker.sock.
 */
async function restartRuntimeIfRunning(userId) {
  let st;
  try {
    st = await runtimeStatus(userId);
  } catch (err) {
    return {
      attempted: true,
      restarted: false,
      error: err.code || "runtime_status_failed",
    };
  }
  if (!st.running) {
    return { attempted: false, restarted: false, name: st.name, status: st.status, running: false };
  }
  try {
    await stopRuntime(userId);
  } catch (err) {
    return {
      attempted: true,
      restarted: false,
      error: err.code || "runtime_stop_failed",
      name: st.name,
      status: st.status,
    };
  }
  try {
    const ensured = await ensureRuntime(userId);
    return { attempted: true, restarted: true, ...ensured };
  } catch (err) {
    return {
      attempted: true,
      restarted: false,
      stopped: true,
      error: err.code || "runtime_ensure_failed",
    };
  }
}

async function listRuntimes() {
  return managerFetch("/list");
}

function outboundHeaders(req, userId, { upgrade = false } = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) && !(upgrade && (lower === "connection" || lower === "upgrade"))) {
      continue;
    }
    if (lower === "cookie" || lower === "authorization" || lower === "host") {
      continue;
    }
    headers[key] = value;
  }
  // SPA /api trust fence matches --trusted-host $APP_HOST. Do not rewrite Host
  // to the internal container name (that would 403 credentials/settings).
  headers.host = appHost() || req.headers.host || `${runtimeHost(userId)}:${LISTEN_PORT}`;
  headers.connection = upgrade ? "Upgrade" : "close";
  if (upgrade && req.headers.upgrade) {
    headers.upgrade = req.headers.upgrade;
  }
  if (req.headers["sec-websocket-key"]) {
    headers["sec-websocket-key"] = req.headers["sec-websocket-key"];
  }
  if (req.headers["sec-websocket-version"]) {
    headers["sec-websocket-version"] = req.headers["sec-websocket-version"];
  }
  if (req.headers["sec-websocket-protocol"]) {
    headers["sec-websocket-protocol"] = req.headers["sec-websocket-protocol"];
  }
  if (req.headers["sec-websocket-extensions"]) {
    headers["sec-websocket-extensions"] = req.headers["sec-websocket-extensions"];
  }
  const proto = req.headers["x-forwarded-proto"] || "https";
  headers["x-forwarded-proto"] = proto;
  if (req.socket?.remoteAddress) {
    headers["x-forwarded-for"] = req.socket.remoteAddress;
  }
  return headers;
}

function proxyHttp(req, res, userId) {
  const pReq = http.request(
    {
      hostname: runtimeHost(userId),
      port: LISTEN_PORT,
      path: rewriteRuntimeUrl(req.url),
      method: req.method,
      headers: outboundHeaders(req, userId),
      agent: false,
    },
    (pRes) => {
      const headers = {};
      for (const [key, value] of Object.entries(pRes.headers)) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) {
          headers[key] = value;
        }
      }
      res.writeHead(pRes.statusCode ?? 502, headers);
      pRes.pipe(res);
    },
  );

  pReq.on("error", (err) => {
    process.stderr.write(`runtime proxy error for ${runtimeHost(userId)}: ${err.message}\n`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: "runtime_unreachable" });
    } else {
      res.destroy();
    }
  });

  req.on("aborted", () => {
    pReq.destroy();
  });

  req.pipe(pReq);
}

function writeSocketHead(socket, status, reason, headers, extra = "") {
  const lines = [`HTTP/1.1 ${status} ${reason}`];
  for (const [key, value] of Object.entries(headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        lines.push(`${key}: ${item}`);
      }
    } else if (value !== undefined) {
      lines.push(`${key}: ${value}`);
    }
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n${extra}`);
}

function proxyUpgrade(req, socket, head, userId) {
  const pReq = http.request({
    hostname: runtimeHost(userId),
    port: LISTEN_PORT,
    path: rewriteRuntimeUrl(req.url),
    method: req.method,
    headers: outboundHeaders(req, userId, { upgrade: true }),
    agent: false,
  });

  pReq.on("upgrade", (pRes, pSocket, pHead) => {
    const lines = [`HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage || "Switching Protocols"}`];
    for (const [key, value] of Object.entries(pRes.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          lines.push(`${key}: ${item}`);
        }
      } else if (value !== undefined) {
        lines.push(`${key}: ${value}`);
      }
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head && head.length) {
      pSocket.write(head);
    }
    if (pHead && pHead.length) {
      socket.write(pHead);
    }
    pSocket.pipe(socket);
    socket.pipe(pSocket);
    const fail = () => {
      pSocket.destroy();
      socket.destroy();
    };
    pSocket.on("error", fail);
    socket.on("error", fail);
  });

  pReq.on("response", (pRes) => {
    writeSocketHead(socket, pRes.statusCode ?? 502, pRes.statusMessage || "Error", pRes.headers);
    pRes.pipe(socket);
  });

  pReq.on("error", (err) => {
    process.stderr.write(`runtime ws proxy error for ${runtimeHost(userId)}: ${err.message}\n`);
    try {
      writeSocketHead(
        socket,
        502,
        "Bad Gateway",
        { "content-type": "application/json", connection: "close" },
        `${JSON.stringify({ error: "runtime_unreachable" })}\n`,
      );
    } catch {
      // ignore
    }
    socket.destroy();
  });

  pReq.end();
}

async function handleRuntimeRequest(req, res, userId) {
  try {
    await ensureRuntime(userId);
  } catch (err) {
    if (err && err.status) {
      sendJson(res, err.status, err.body && err.body.error ? err.body : { error: err.code || "error" });
      return;
    }
    throw err;
  }
  proxyHttp(req, res, userId);
}

module.exports = {
  LISTEN_PORT,
  runtimeHost,
  rewriteRuntimeUrl,
  ensureRuntime,
  runtimeStatus,
  stopRuntime,
  restartRuntimeIfRunning,
  listRuntimes,
  handleRuntimeRequest,
  proxyUpgrade,
  writeSocketHead,
};
