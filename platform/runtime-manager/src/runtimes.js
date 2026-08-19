"use strict";

const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const docker = require("./docker");
const { signPlatformUserToken, platformTokenSecret } = require("./platform-token");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_RUNTIME = "dsh.runtime";
const LABEL_USER = "dsh.userId";
const LISTEN_PORT = 3080;
const PORT_HEX = LISTEN_PORT.toString(16).toUpperCase().padStart(4, "0"); // 0C08

const IMAGE = process.env.RUNTIME_IMAGE || "dsh-runtime:web";
const NETWORK = process.env.RUNTIME_NETWORK || "dsh-runtimes";
const USERS_ROOT = process.env.USERS_ROOT || "/data/users";
const HOST_DATA_ROOT = String(process.env.HOST_DATA_ROOT || "").trim();
const APP_HOST = String(process.env.APP_HOST || "").trim();
const PLATFORM_URL = String(process.env.PLATFORM_URL || "http://control-plane:8080").replace(/\/+$/, "")
  || "http://control-plane:8080";
const HOME_PATCH_NAME = "cordis.patch.yml";
const PLATFORM_TOKEN_FILE = ".platform-token";
const HOME_PATCH_CONTENTS = `# Written once by the platform when this home had no cordis.patch.yml.
# Loads publish_site. Existing user patches are never overwritten.
- insert:
    - id: platform-publish-site
      name: /opt/dsh-platform/agent-bridge/index.js
`;

function httpError(status, code, extra = {}) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  err.extra = extra;
  return err;
}

function parseMemory(raw) {
  const text = String(raw ?? "1g").trim();
  const match = text.match(/^(\d+(?:\.\d+)?)([kKmMgG])?b?$/);
  if (!match) {
    return 1024 * 1024 * 1024;
  }
  const n = Number(match[1]);
  const unit = (match[2] || "g").toLowerCase();
  const mul = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
  return Math.round(n * mul[unit]);
}

function parseNanoCpus(raw) {
  const n = Number.parseFloat(String(raw ?? "1.0"));
  if (!Number.isFinite(n) || n <= 0) {
    return 1_000_000_000;
  }
  return Math.round(n * 1_000_000_000);
}

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MEMORY_BYTES = parseMemory(process.env.RUNTIME_MEMORY || "1g");
const NANO_CPUS = parseNanoCpus(process.env.RUNTIME_CPUS || "1.0");
const MAX_RUNTIMES = envInt("MAX_RUNTIMES", 2);
const IDLE_SECONDS = envInt("IDLE_SECONDS", 900);
const READY_TIMEOUT_MS = envInt("RUNTIME_READY_TIMEOUT_MS", 120_000);

class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  run(fn) {
    const run = this._tail.then(fn, fn);
    this._tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

const mutex = new Mutex();
const lastActive = new Map();

function isAbsoluteHostPath(p) {
  if (!p) {
    return false;
  }
  if (p.startsWith("/")) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(p)) {
    return true;
  }
  if (p.startsWith("\\\\")) {
    return true;
  }
  return false;
}

function hostJoin(...parts) {
  const root = HOST_DATA_ROOT.replace(/\\/g, "/").replace(/\/+$/, "");
  return [root, ...parts].join("/");
}

function containerName(userId) {
  return `dsh-runtime-${userId}`;
}

function assertUserId(userId) {
  const id = typeof userId === "string" ? userId.trim() : "";
  if (!UUID_RE.test(id)) {
    throw httpError(400, "invalid_user_id");
  }
  return id;
}

function runtimeStatus(inspect) {
  const status = inspect?.State?.Status || "unknown";
  const running = Boolean(inspect?.State?.Running);
  return { status, running };
}

function networksOf(inspect) {
  return Object.keys(inspect?.NetworkSettings?.Networks || {});
}

function runtimeIp(inspect) {
  const netInfo = inspect?.NetworkSettings?.Networks?.[NETWORK];
  return netInfo?.IPAddress || "";
}

function containerEnvMap(inspect) {
  const out = Object.create(null);
  for (const line of inspect?.Config?.Env || []) {
    const i = String(line).indexOf("=");
    if (i === -1) {
      continue;
    }
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function needsRecreate(inspect) {
  const env = containerEnvMap(inspect);
  if (env.DSH_TRUST_GATEWAY !== "1") {
    return true;
  }
  if (!env.APP_HOST || (APP_HOST && env.APP_HOST !== APP_HOST)) {
    return true;
  }
  if (!env.PLATFORM_URL || env.PLATFORM_URL !== PLATFORM_URL) {
    return true;
  }
  if (!env.PLATFORM_TOKEN) {
    return true;
  }
  const createdImage = String(inspect?.Config?.Image || "");
  if (createdImage === "dsh-runtime:skeleton") {
    return true;
  }
  return false;
}

function parseEstablishedOn3080(procText) {
  for (const line of String(procText).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || !cols[1] || !cols[1].includes(":")) {
      continue;
    }
    const port = cols[1].slice(cols[1].lastIndexOf(":") + 1).toUpperCase();
    const state = cols[3].toUpperCase();
    if (port === PORT_HEX && state === "01") {
      return true;
    }
  }
  return false;
}

async function hasEstablishedOn3080(containerId) {
  try {
    const out = await docker.execOnce(containerId, [
      "sh",
      "-c",
      "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || true",
    ]);
    return parseEstablishedOn3080(out);
  } catch (err) {
    process.stderr.write(`idle probe failed for ${containerId}: ${err.message}\n`);
    return false;
  }
}

function waitForTcp(host, port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) {
        return;
      }
      done = true;
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    const attempt = () => {
      if (done) {
        return;
      }
      if (Date.now() - started > timeoutMs) {
        finish(httpError(503, "runtime_not_ready"));
        return;
      }
      const socket = net.connect({ host, port }, () => {
        socket.end();
        finish();
      });
      socket.setTimeout(1500, () => {
        socket.destroy();
        setTimeout(attempt, 200);
      });
      socket.on("error", () => {
        socket.destroy();
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function ensureDirs(userId) {
  await fs.mkdir(path.join(USERS_ROOT, userId, "home"), { recursive: true });
  await fs.mkdir(path.join(USERS_ROOT, userId, "workspace"), { recursive: true });
}

async function writeUserPlatformFiles(userId, token, usersRoot = USERS_ROOT) {
  const home = path.join(usersRoot, userId, "home");
  await fs.mkdir(home, { recursive: true });
  const tokenPath = path.join(home, PLATFORM_TOKEN_FILE);
  const tmp = path.join(home, `.platform-token.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.chmod(tmp, 0o600);
  } catch {
    // win32 may ignore mode
  }
  await fs.rename(tmp, tokenPath);
  try {
    await fs.chmod(tokenPath, 0o600);
  } catch {
    // win32 may ignore mode
  }

  const patchPath = path.join(home, HOME_PATCH_NAME);
  let patchWritten = false;
  try {
    await fs.writeFile(patchPath, HOME_PATCH_CONTENTS, { encoding: "utf8", flag: "wx" });
    patchWritten = true;
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      process.stderr.write(`runtime: could not write ${patchPath}: ${err && err.message}\n`);
    }
  }
  return { tokenPath, patchWritten };
}

function runtimeEnvList(userId, token) {
  const env = [
    "DSH_HOME=/data/home",
    "HOME=/data/home",
    "DSH_TRUST_GATEWAY=1",
    "SSH_CONNECTION=gateway",
    `PLATFORM_URL=${PLATFORM_URL}`,
    `PLATFORM_TOKEN=${token}`,
  ];
  if (APP_HOST) {
    env.push(`APP_HOST=${APP_HOST}`);
  }
  return env;
}

function createSpec(userId, token) {
  const name = containerName(userId);
  const homeSrc = hostJoin("users", userId, "home");
  const workspaceSrc = hostJoin("users", userId, "workspace");
  return {
    Image: IMAGE,
    Hostname: name,
    User: "node",
    WorkingDir: "/data/workspace",
    Env: runtimeEnvList(userId, token),
    Labels: {
      [LABEL_RUNTIME]: "1",
      [LABEL_USER]: userId,
    },
    ExposedPorts: { [`${LISTEN_PORT}/tcp`]: {} },
    HostConfig: {
      Binds: [`${homeSrc}:/data/home`, `${workspaceSrc}:/data/workspace`],
      NetworkMode: NETWORK,
      Privileged: false,
      PublishAllPorts: false,
      PortBindings: {},
      Memory: MEMORY_BYTES,
      NanoCpus: NANO_CPUS,
      SecurityOpt: ["no-new-privileges:true"],
      RestartPolicy: { Name: "no" },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [NETWORK]: {
          Aliases: [name],
        },
      },
    },
  };
}

async function listManaged() {
  return docker.listContainers({
    all: true,
    filters: { label: [`${LABEL_RUNTIME}=1`] },
  });
}

async function runningCount(exceptName = "") {
  const list = await listManaged();
  return list.filter((row) => {
    const running = row.State === "running";
    if (!running) {
      return false;
    }
    if (!exceptName) {
      return true;
    }
    const names = (row.Names || []).map((n) => String(n).replace(/^\//, ""));
    return !names.includes(exceptName);
  }).length;
}

async function inspectOrNull(name) {
  const res = await docker.inspectContainer(name);
  if (res.status === 404) {
    return null;
  }
  if (res.status !== 200) {
    throw httpError(502, "docker_inspect_failed", { detail: docker.messageOf(res) });
  }
  return res.body;
}

async function connectRuntimesIfNeeded(inspect) {
  const name = (inspect.Name || "").replace(/^\//, "");
  const id = inspect.Id || name;
  const nets = networksOf(inspect);
  if (!nets.includes(NETWORK)) {
    const res = await docker.connectNetwork(NETWORK, id);
    if (res.status !== 200 && res.status !== 204) {
      const msg = docker.messageOf(res);
      if (!/already exists in network/i.test(msg)) {
        throw httpError(502, "runtime_network_failed", { detail: msg });
      }
    }
  }
  for (const netName of nets) {
    if (netName === NETWORK) {
      continue;
    }
    const res = await docker.disconnectNetwork(netName, id);
    if (res.status !== 200 && res.status !== 204) {
      process.stderr.write(`disconnect ${name} from ${netName}: ${docker.messageOf(res)}\n`);
    }
  }
}

async function startIfNeeded(inspect) {
  if (inspect.State?.Running) {
    return inspect;
  }
  const name = (inspect.Name || "").replace(/^\//, "");
  const res = await docker.startContainer(inspect.Id || name);
  // 204 = started, 304 = already running
  if (res.status !== 204 && res.status !== 304) {
    throw httpError(502, "runtime_start_failed", { detail: docker.messageOf(res) });
  }
  const fresh = await inspectOrNull(name);
  if (!fresh) {
    throw httpError(502, "runtime_start_failed");
  }
  return fresh;
}

async function waitReady(name, inspect) {
  const started = Date.now();
  let last = inspect;
  while (Date.now() - started <= READY_TIMEOUT_MS) {
    last = (await inspectOrNull(name)) || last;
    const host = runtimeIp(last) || name;
    try {
      await waitForTcp(host, LISTEN_PORT, Math.min(1500, READY_TIMEOUT_MS));
      return last;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw httpError(503, "runtime_not_ready");
}

async function createFresh(userId, token) {
  const name = containerName(userId);
  const res = await docker.createContainer(name, createSpec(userId, token));
  if (res.status === 409) {
    const existing = await inspectOrNull(name);
    if (existing) {
      return existing;
    }
  }
  if (res.status === 404) {
    throw httpError(503, "runtime_image_missing", { image: IMAGE });
  }
  if (res.status !== 201) {
    throw httpError(502, "runtime_create_failed", { detail: docker.messageOf(res) });
  }
  return inspectOrNull(name);
}

async function removeStale(inspect) {
  const name = (inspect.Name || "").replace(/^\//, "");
  const res = await docker.removeContainer(inspect.Id || name);
  if (res.status !== 204 && res.status !== 404) {
    throw httpError(502, "runtime_recreate_failed", { detail: docker.messageOf(res) });
  }
  process.stdout.write(`runtime: removed stale ${name} so ensure can recreate with APP_HOST / PLATFORM_URL\n`);
}

async function ensureUnlocked(userIdRaw) {
  const userId = assertUserId(userIdRaw);
  const name = containerName(userId);
  await ensureDirs(userId);
  const token = signPlatformUserToken(userId);
  await writeUserPlatformFiles(userId, token);

  let inspect = await inspectOrNull(name);
  if (inspect && needsRecreate(inspect)) {
    await removeStale(inspect);
    inspect = null;
  }

  if (inspect) {
    if (!inspect.State?.Running) {
      const n = await runningCount(name);
      if (n >= MAX_RUNTIMES) {
        throw httpError(429, "too_many_runtimes", { max: MAX_RUNTIMES });
      }
    }
    inspect = await startIfNeeded(inspect);
  } else {
    const n = await runningCount();
    if (n >= MAX_RUNTIMES) {
      throw httpError(429, "too_many_runtimes", { max: MAX_RUNTIMES });
    }
    inspect = await createFresh(userId, token);
    inspect = await startIfNeeded(inspect);
  }

  await connectRuntimesIfNeeded(inspect);
  inspect = (await inspectOrNull(name)) || inspect;

  lastActive.set(userId, Date.now());
  inspect = await waitReady(name, inspect);
  const { status, running } = runtimeStatus(inspect);
  return { name, status, running };
}

async function statusUnlocked(userIdRaw) {
  const userId = assertUserId(userIdRaw);
  const name = containerName(userId);
  const inspect = await inspectOrNull(name);
  if (!inspect) {
    return { name, status: "missing", running: false };
  }
  const { status, running } = runtimeStatus(inspect);
  return { name, status, running };
}

async function stopUnlocked(userIdRaw) {
  const userId = assertUserId(userIdRaw);
  const name = containerName(userId);
  const inspect = await inspectOrNull(name);
  if (!inspect) {
    return { name, status: "missing", running: false };
  }
  if (!inspect.State?.Running) {
    const { status, running } = runtimeStatus(inspect);
    return { name, status, running };
  }
  const res = await docker.stopContainer(inspect.Id || name, 10);
  if (res.status !== 204 && res.status !== 304) {
    throw httpError(502, "runtime_stop_failed", { detail: docker.messageOf(res) });
  }
  const fresh = (await inspectOrNull(name)) || inspect;
  const { status, running } = runtimeStatus(fresh);
  return { name, status, running };
}

function ensure(userId) {
  return mutex.run(() => ensureUnlocked(userId));
}

function status(userId) {
  return mutex.run(() => statusUnlocked(userId));
}

function stop(userId) {
  return mutex.run(() => stopUnlocked(userId));
}

function summarizeListed(row) {
  const names = (row.Names || []).map((n) => String(n).replace(/^\//, ""));
  const name = names.find((n) => n.startsWith("dsh-runtime-")) || names[0] || "";
  const userId = row.Labels?.[LABEL_USER] || "";
  const status = row.State || "unknown";
  return {
    name,
    userId,
    status,
    running: status === "running",
  };
}

async function listUnlocked() {
  const list = await listManaged();
  return list
    .map(summarizeListed)
    .filter((row) => row.name.startsWith("dsh-runtime-"));
}

function list() {
  return mutex.run(() => listUnlocked());
}

async function sweepIdleUnlocked() {
  const list = await listManaged();
  const now = Date.now();
  const idleMs = IDLE_SECONDS * 1000;

  for (const row of list) {
    if (row.State !== "running") {
      continue;
    }
    const userId = row.Labels?.[LABEL_USER];
    if (!userId || !UUID_RE.test(userId)) {
      continue;
    }
    const busy = await hasEstablishedOn3080(row.Id);
    if (busy) {
      lastActive.set(userId, now);
      continue;
    }
    if (!lastActive.has(userId)) {
      lastActive.set(userId, now);
      continue;
    }
    if (now - lastActive.get(userId) < idleMs) {
      continue;
    }
    process.stdout.write(`idle: stopping ${containerName(userId)} after ${IDLE_SECONDS}s with no TCP on ${LISTEN_PORT}\n`);
    try {
      await stopUnlocked(userId);
    } catch (err) {
      process.stderr.write(`idle stop failed for ${userId}: ${err.message}\n`);
    }
  }
}

function sweepIdle() {
  return mutex.run(() => sweepIdleUnlocked());
}

async function assertReady() {
  if (!isAbsoluteHostPath(HOST_DATA_ROOT)) {
    throw new Error(
      "HOST_DATA_ROOT must be an absolute path on the Docker host (not ./data inside this container)",
    );
  }
  if (!APP_HOST) {
    process.stderr.write("warning: APP_HOST is empty; user containers need it for dsh --trusted-host\n");
  }
  if (!platformTokenSecret()) {
    throw new Error("PLATFORM_TOKEN_SECRET must be set (HMAC for PLATFORM_USER_TOKEN; do not reuse SESSION_SECRET)");
  }
  await docker.ping();
  const netRes = await docker.inspectNetwork(NETWORK);
  if (netRes.status !== 200) {
    throw new Error(`docker network ${NETWORK} is missing: ${docker.messageOf(netRes)}`);
  }
  const img = await docker.inspectImage(IMAGE);
  if (img.status !== 200) {
    process.stderr.write(
      `warning: image ${IMAGE} not found yet; ensure will 503 until compose builds it\n`,
    );
  }
}

function limits() {
  return {
    image: IMAGE,
    network: NETWORK,
    hostDataRoot: HOST_DATA_ROOT,
    appHost: APP_HOST,
    platformUrl: PLATFORM_URL,
    memoryBytes: MEMORY_BYTES,
    nanoCpus: NANO_CPUS,
    maxRuntimes: MAX_RUNTIMES,
    idleSeconds: IDLE_SECONDS,
    readyTimeoutMs: READY_TIMEOUT_MS,
  };
}

module.exports = {
  UUID_RE,
  IMAGE,
  NETWORK,
  HOST_DATA_ROOT,
  PLATFORM_URL,
  HOME_PATCH_CONTENTS,
  HOME_PATCH_NAME,
  PLATFORM_TOKEN_FILE,
  LISTEN_PORT,
  MAX_RUNTIMES,
  IDLE_SECONDS,
  containerName,
  parseEstablishedOn3080,
  isAbsoluteHostPath,
  assertUserId,
  needsRecreate,
  runtimeEnvList,
  writeUserPlatformFiles,
  ensure,
  status,
  stop,
  list,
  summarizeListed,
  sweepIdle,
  assertReady,
  limits,
};
