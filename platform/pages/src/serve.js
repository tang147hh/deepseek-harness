"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { isKvPath, handleKvRequest } = require("./kv");

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
};

const nositeHtml = fsSync.readFileSync(path.join(__dirname, "nosite.html"), "utf8");
const takedownHtml = fsSync.readFileSync(path.join(__dirname, "takedown.html"), "utf8");

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-origin": "user-generated",
};

function snapshotsRootFromEnv() {
  return process.env.SNAPSHOTS_ROOT ?? "/data/snapshots";
}

function pagesParentFromEnv() {
  return String(process.env.PAGES_PARENT ?? "pages.localhost").trim().toLowerCase();
}

function pagesHostFromEnv() {
  return String(process.env.PAGES_HOST ?? process.env.PAGES_PARENT ?? "pages.localhost")
    .trim()
    .toLowerCase();
}

function hostFromReq(req) {
  const raw = String(req.headers.host ?? req.headers[":authority"] ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const host = raw.split(":")[0];
  return host;
}

/** foo.pages.localhost → foo; PAGES_HOST / PAGES_PARENT apex → null. */
function slugFromHost(hostHeader, pagesParent, pagesHost) {
  const host = String(hostHeader ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .split(":")[0];
  const parent = String(pagesParent ?? "").trim().toLowerCase();
  const apex = String(pagesHost ?? parent).trim().toLowerCase();
  if (!host || !parent) {
    return null;
  }
  if (host === apex || host === parent) {
    return null;
  }
  const suffix = `.${parent}`;
  if (!host.endsWith(suffix)) {
    return null;
  }
  const slug = host.slice(0, -suffix.length);
  if (!slug || slug.includes(".") || !SLUG_RE.test(slug)) {
    return null;
  }
  return slug;
}

function isInside(root, candidate) {
  const rootN = path.resolve(root);
  const candN = path.resolve(candidate);
  if (process.platform === "win32") {
    const r = rootN.toLowerCase();
    const c = candN.toLowerCase();
    return c === r || c.startsWith(`${r}${path.sep}`);
  }
  return candN === rootN || candN.startsWith(`${rootN}${path.sep}`);
}

function pathnameOf(url) {
  const raw = String(url ?? "/").split("?")[0];
  if (raw.length > 1 && raw.endsWith("/")) {
    return raw.slice(0, -1) || "/";
  }
  return raw || "/";
}

function requestPath(url) {
  let raw = String(url ?? "/").split("?")[0];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (raw.includes("\0") || raw.includes("\\")) {
    return null;
  }
  const out = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      return null;
    }
    out.push(part);
  }
  return out;
}

function send(res, status, headers, body) {
  res.writeHead(status, {
    "cache-control": "no-store",
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(body);
}

function sendNoSite(res) {
  send(res, 404, { "content-type": "text/html; charset=utf-8" }, nositeHtml);
}

function sendTakenDown(res) {
  send(res, 410, { "content-type": "text/html; charset=utf-8" }, takedownHtml);
}

function sendNotFound(res) {
  send(res, 404, { "content-type": "text/html; charset=utf-8" }, "<!DOCTYPE html><title>Not found</title><h1>Not found</h1>");
}

async function readSlugIndex(snapshotsRoot, slug) {
  if (!SLUG_RE.test(slug)) {
    return null;
  }
  const indexPath = path.join(snapshotsRoot, ".index", `${slug}.json`);
  const indexDir = path.join(snapshotsRoot, ".index");
  if (!isInside(indexDir, indexPath)) {
    return null;
  }
  let raw;
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const siteId = String(parsed.siteId ?? "");
  const version = Number.parseInt(parsed.version, 10);
  const status = String(parsed.status ?? "");
  if (!UUID_RE.test(siteId)) {
    return null;
  }
  if (status === "taken_down") {
    return { siteId, version: Number.isInteger(version) ? version : 0, status };
  }
  if (status !== "live" || !Number.isInteger(version) || version < 1) {
    return null;
  }
  return { siteId, version, status };
}

async function resolveFile(versionRoot, parts) {
  let relParts = parts;
  if (relParts.length === 0) {
    relParts = ["index.html"];
  }
  const abs = path.resolve(versionRoot, ...relParts);
  if (!isInside(versionRoot, abs)) {
    return null;
  }
  let lst;
  try {
    lst = await fs.lstat(abs);
  } catch {
    return null;
  }
  if (lst.isSymbolicLink()) {
    return null;
  }
  if (lst.isDirectory()) {
    const indexAbs = path.join(abs, "index.html");
    if (!isInside(versionRoot, indexAbs)) {
      return null;
    }
    try {
      const idx = await fs.lstat(indexAbs);
      if (!idx.isFile() || idx.isSymbolicLink()) {
        return null;
      }
      return { abs: indexAbs, ext: ".html" };
    } catch {
      return null;
    }
  }
  if (!lst.isFile()) {
    return null;
  }
  const ext = path.posix.extname(relParts[relParts.length - 1].toLowerCase());
  return { abs, ext };
}

async function handlePagesRequest(req, res, opts = {}) {
  const snapshotsRoot = opts.snapshotsRoot ?? snapshotsRootFromEnv();
  const pagesParent = opts.pagesParent ?? pagesParentFromEnv();
  const pagesHost = opts.pagesHost ?? pagesHostFromEnv();
  const method = req.method ?? "GET";
  const pathname = pathnameOf(req.url);

  if (isKvPath(pathname)) {
    const slug = slugFromHost(hostFromReq(req), pagesParent, pagesHost);
    await handleKvRequest(req, res, {
      pool: opts.pool,
      slug,
      pagesParent,
      pathname,
      rateLimiter: opts.rateLimiter,
    });
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    send(res, 405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" }, "method_not_allowed\n");
    return;
  }

  const slug = slugFromHost(hostFromReq(req), pagesParent, pagesHost);
  if (!slug) {
    sendNoSite(res);
    return;
  }

  const meta = await readSlugIndex(snapshotsRoot, slug);
  if (!meta) {
    sendNoSite(res);
    return;
  }
  if (meta.status === "taken_down") {
    sendTakenDown(res);
    return;
  }

  const versionRoot = path.resolve(snapshotsRoot, meta.siteId, String(meta.version));
  const snapRoot = path.resolve(snapshotsRoot);
  if (!isInside(snapRoot, versionRoot) || versionRoot === snapRoot) {
    sendNoSite(res);
    return;
  }
  try {
    const st = await fs.lstat(versionRoot);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      sendNoSite(res);
      return;
    }
  } catch {
    sendNoSite(res);
    return;
  }

  const parts = requestPath(req.url);
  if (!parts) {
    sendNotFound(res);
    return;
  }

  const file = await resolveFile(versionRoot, parts);
  if (!file) {
    sendNotFound(res);
    return;
  }
  const ctype = TYPES[file.ext];
  if (!ctype) {
    sendNotFound(res);
    return;
  }

  let size;
  try {
    size = (await fs.stat(file.abs)).size;
  } catch {
    sendNotFound(res);
    return;
  }

  res.writeHead(200, {
    "content-type": ctype,
    "content-length": size,
    "cache-control": "public, max-age=300",
    ...SECURITY_HEADERS,
  });
  if ((req.method ?? "GET") === "HEAD") {
    res.end();
    return;
  }
  try {
    await pipeline(fsSync.createReadStream(file.abs), res);
  } catch {
    if (!res.headersSent) {
      sendNotFound(res);
    } else {
      res.destroy();
    }
  }
}

module.exports = {
  SLUG_RE,
  TYPES,
  SECURITY_HEADERS,
  slugFromHost,
  handlePagesRequest,
  sendNoSite,
  pathnameOf,
};
