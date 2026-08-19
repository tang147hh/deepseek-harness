"use strict";

const http = require("node:http");

const SOCKET = process.env.DOCKER_SOCK || "/var/run/docker.sock";
const API = process.env.DOCKER_API_VERSION || "v1.41";

function dockerRequest({ method, path, body, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { accept: "application/json" };
    if (payload !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        socketPath: SOCKET,
        path: `/${API}${path}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
          }
          resolve({ status: res.statusCode ?? 500, headers: res.headers, body: parsed, raw });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("docker_timeout"));
    });
    req.on("error", reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

function dockerStream({ method, path, body, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { accept: "*/*" };
    if (payload !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        socketPath: SOCKET,
        path: `/${API}${path}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("docker_timeout"));
    });
    req.on("error", reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

async function ping() {
  const res = await dockerRequest({ method: "GET", path: "/_ping", timeoutMs: 5_000 });
  if (res.status !== 200) {
    const err = new Error("docker_unreachable");
    err.status = 503;
    err.code = "docker_unreachable";
    throw err;
  }
  return true;
}

async function inspectNetwork(name) {
  return dockerRequest({
    method: "GET",
    path: `/networks/${encodeURIComponent(name)}`,
  });
}

async function inspectContainer(nameOrId) {
  return dockerRequest({
    method: "GET",
    path: `/containers/${encodeURIComponent(nameOrId)}/json`,
  });
}

async function listContainers({ all = true, filters } = {}) {
  const params = new URLSearchParams();
  params.set("all", all ? "1" : "0");
  if (filters) {
    params.set("filters", JSON.stringify(filters));
  }
  const res = await dockerRequest({
    method: "GET",
    path: `/containers/json?${params.toString()}`,
  });
  if (res.status !== 200 || !Array.isArray(res.body)) {
    const err = new Error(res.body?.message || "docker_list_failed");
    err.status = 502;
    err.code = "docker_list_failed";
    throw err;
  }
  return res.body;
}

async function createContainer(name, spec) {
  return dockerRequest({
    method: "POST",
    path: `/containers/create?name=${encodeURIComponent(name)}`,
    body: spec,
    timeoutMs: 60_000,
  });
}

async function startContainer(nameOrId) {
  return dockerRequest({
    method: "POST",
    path: `/containers/${encodeURIComponent(nameOrId)}/start`,
    body: {},
    timeoutMs: 60_000,
  });
}

async function stopContainer(nameOrId, seconds = 10) {
  return dockerRequest({
    method: "POST",
    path: `/containers/${encodeURIComponent(nameOrId)}/stop?t=${encodeURIComponent(String(seconds))}`,
    body: {},
    timeoutMs: (seconds + 5) * 1000,
  });
}

async function removeContainer(nameOrId) {
  return dockerRequest({
    method: "DELETE",
    path: `/containers/${encodeURIComponent(nameOrId)}?force=true`,
    timeoutMs: 60_000,
  });
}

async function connectNetwork(network, container) {
  return dockerRequest({
    method: "POST",
    path: `/networks/${encodeURIComponent(network)}/connect`,
    body: { Container: container },
  });
}

async function disconnectNetwork(network, container) {
  return dockerRequest({
    method: "POST",
    path: `/networks/${encodeURIComponent(network)}/disconnect`,
    body: { Container: container, Force: true },
  });
}

async function inspectImage(ref) {
  return dockerRequest({
    method: "GET",
    path: `/images/${encodeURIComponent(ref)}/json`,
  });
}

async function execOnce(containerId, cmd) {
  const created = await dockerRequest({
    method: "POST",
    path: `/containers/${encodeURIComponent(containerId)}/exec`,
    body: {
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: cmd,
    },
  });
  if (created.status !== 201 || !created.body?.Id) {
    const err = new Error(created.body?.message || "docker_exec_create_failed");
    err.status = 502;
    err.code = "docker_exec_create_failed";
    throw err;
  }
  const started = await dockerStream({
    method: "POST",
    path: `/exec/${encodeURIComponent(created.body.Id)}/start`,
    body: { Detach: false, Tty: true },
  });
  if (started.status !== 200) {
    const err = new Error("docker_exec_start_failed");
    err.status = 502;
    err.code = "docker_exec_start_failed";
    throw err;
  }
  return started.body;
}

function messageOf(res) {
  if (res.body && typeof res.body === "object" && res.body.message) {
    return String(res.body.message);
  }
  return res.raw || `docker HTTP ${res.status}`;
}

module.exports = {
  SOCKET,
  ping,
  inspectNetwork,
  inspectContainer,
  listContainers,
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
  connectNetwork,
  disconnectNetwork,
  inspectImage,
  execOnce,
  messageOf,
};
