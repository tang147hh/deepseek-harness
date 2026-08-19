"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const busboy = require("busboy");
const { normalizePath, parseQuery, sendHtml, sendJson } = require("./http");

const DEFAULT_MAX_FILE = 20 * 1024 * 1024;
const DEFAULT_QUOTA = 500 * 1024 * 1024;
const PAGE_HTML = fsSync.readFileSync(path.join(__dirname, "files-page.html"), "utf8");

function maxFileBytes() {
  const n = Number.parseInt(process.env.FILE_MAX_BYTES ?? String(DEFAULT_MAX_FILE), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE;
}

function quotaBytes() {
  const n = Number.parseInt(process.env.FILE_QUOTA_BYTES ?? String(DEFAULT_QUOTA), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUOTA;
}

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

function isFilesPath(pathname) {
  return pathname === "/files" || pathname.startsWith("/files/");
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

/** Client path: posix relative to workspace. Reject .., absolute, drive, backslash. */
function parseWorkspaceRel(raw) {
  if (raw == null) {
    return ".";
  }
  const s = String(raw).trim();
  if (s === "" || s === ".") {
    return ".";
  }
  if (s.includes("\0") || s.includes("\\") || s.includes("://")) {
    throw httpError(400, "invalid_path");
  }
  if (/^[a-zA-Z]:/.test(s) || s.startsWith("/") || s.startsWith("\\")) {
    throw httpError(400, "invalid_path");
  }
  const out = [];
  for (const part of s.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === ".." || part.includes("\0")) {
      throw httpError(400, "invalid_path");
    }
    out.push(part);
  }
  return out.length === 0 ? "." : out.join("/");
}

function safeUploadName(filename) {
  const base = path.posix.basename(String(filename || "").replace(/\\/g, "/"));
  if (!base || base === "." || base === ".." || base.includes("\0")) {
    throw httpError(400, "invalid_filename");
  }
  return base;
}

function joinUnder(workspaceReal, rel) {
  const parsed = parseWorkspaceRel(rel);
  if (parsed === ".") {
    return workspaceReal;
  }
  const abs = path.resolve(workspaceReal, ...parsed.split("/"));
  if (!isInside(workspaceReal, abs)) {
    throw httpError(400, "invalid_path");
  }
  return abs;
}

async function userWorkspaceRoot(usersRoot, userId) {
  const id = String(userId);
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\") || path.isAbsolute(id)) {
    throw httpError(400, "invalid_path");
  }
  const userDir = path.resolve(usersRoot, id);
  const ws = path.join(userDir, "workspace");
  await fs.mkdir(ws, { recursive: true });
  const userReal = await fs.realpath(userDir);
  const wsReal = await fs.realpath(ws);
  const home = path.join(userReal, "home");
  if (!isInside(userReal, wsReal) || wsReal === home || isInside(home, wsReal)) {
    throw httpError(500, "internal");
  }
  return wsReal;
}

async function resolveExisting(workspaceReal, rel) {
  const abs = joinUnder(workspaceReal, rel);
  let real;
  try {
    real = await fs.realpath(abs);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw httpError(404, "not_found");
    }
    throw err;
  }
  if (!isInside(workspaceReal, real)) {
    throw httpError(400, "invalid_path");
  }
  return { abs, real };
}

async function mkdirInside(workspaceReal, destAbs) {
  if (!isInside(workspaceReal, destAbs)) {
    throw httpError(400, "invalid_path");
  }
  const rel = path.relative(workspaceReal, destAbs);
  if (rel === "") {
    return workspaceReal;
  }
  const parts = rel.split(path.sep).filter(Boolean);
  let cur = workspaceReal;
  for (const part of parts) {
    const next = path.join(cur, part);
    let st;
    try {
      st = await fs.lstat(next);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        await fs.mkdir(next);
        cur = next;
        continue;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      const real = await fs.realpath(next);
      if (!isInside(workspaceReal, real)) {
        throw httpError(400, "invalid_path");
      }
      cur = real;
      continue;
    }
    if (!st.isDirectory()) {
      throw httpError(400, "not_a_directory");
    }
    cur = next;
  }
  const destReal = await fs.realpath(destAbs);
  if (!isInside(workspaceReal, destReal)) {
    throw httpError(400, "invalid_path");
  }
  return destReal;
}

async function workspaceUsedBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isSymbolicLink()) {
        continue;
      }
      if (ent.isDirectory()) {
        stack.push(p);
      } else if (ent.isFile()) {
        try {
          const st = await fs.stat(p);
          total += st.size;
        } catch {
          // skip
        }
      }
    }
  }
  return total;
}

async function rmRecursiveLexical(workspaceReal, absLex) {
  if (!isInside(workspaceReal, absLex)) {
    throw httpError(400, "invalid_path");
  }
  let st;
  try {
    st = await fs.lstat(absLex);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw httpError(404, "not_found");
    }
    throw err;
  }
  if (st.isSymbolicLink() || st.isFile()) {
    await fs.unlink(absLex);
    return;
  }
  if (!st.isDirectory()) {
    throw httpError(400, "invalid_path");
  }
  const entries = await fs.readdir(absLex);
  for (const name of entries) {
    await rmRecursiveLexical(workspaceReal, path.join(absLex, name));
  }
  await fs.rmdir(absLex);
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii || "download"}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function handleList(req, res, workspaceReal) {
  const rel = parseWorkspaceRel(parseQuery(req.url).get("path"));
  const { real } = await resolveExisting(workspaceReal, rel);
  const st = await fs.stat(real);
  if (!st.isDirectory()) {
    throw httpError(400, "not_a_directory");
  }
  const entries = await fs.readdir(real, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    const child = path.join(real, ent.name);
    if (ent.isDirectory()) {
      out.push({ name: ent.name, type: "dir", size: 0 });
      continue;
    }
    if (ent.isFile()) {
      let size = 0;
      try {
        size = (await fs.stat(child)).size;
      } catch {
        size = 0;
      }
      out.push({ name: ent.name, type: "file", size });
      continue;
    }
    if (ent.isSymbolicLink()) {
      out.push({ name: ent.name, type: "file", size: 0 });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  sendJson(res, 200, { path: rel, entries: out });
}

async function handleDownload(req, res, workspaceReal) {
  const rel = parseWorkspaceRel(parseQuery(req.url).get("path"));
  if (rel === ".") {
    throw httpError(400, "not_a_file");
  }
  const { abs, real } = await resolveExisting(workspaceReal, rel);
  const lst = await fs.lstat(abs);
  if (!lst.isFile()) {
    throw httpError(400, "not_a_file");
  }
  if (!isInside(workspaceReal, real)) {
    throw httpError(400, "invalid_path");
  }
  const st = await fs.stat(real);
  if (!st.isFile()) {
    throw httpError(400, "not_a_file");
  }
  const name = path.posix.basename(rel);
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": st.size,
    "content-disposition": contentDisposition(name),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(real);
    stream.on("error", reject);
    res.on("finish", resolve);
    res.on("close", resolve);
    stream.pipe(res);
  });
}

async function handleDelete(req, res, workspaceReal) {
  const q = parseQuery(req.url);
  const rel = parseWorkspaceRel(q.get("path"));
  if (rel === ".") {
    throw httpError(400, "invalid_path");
  }
  const recursive = q.get("recursive") === "1" || q.get("recursive") === "true";
  const { abs } = await resolveExisting(workspaceReal, rel);
  const lst = await fs.lstat(abs);
  if (lst.isSymbolicLink() || lst.isFile()) {
    await fs.unlink(abs);
    sendJson(res, 200, { ok: true, path: rel });
    return;
  }
  if (!lst.isDirectory()) {
    throw httpError(400, "invalid_path");
  }
  const names = await fs.readdir(abs);
  if (names.length > 0 && !recursive) {
    throw httpError(409, "directory_not_empty");
  }
  if (recursive) {
    await rmRecursiveLexical(workspaceReal, abs);
  } else {
    await fs.rmdir(abs);
  }
  sendJson(res, 200, { ok: true, path: rel });
}

function parseMultipart(req) {
  const limit = maxFileBytes();
  return new Promise((resolve, reject) => {
    const ctype = String(req.headers["content-type"] ?? "");
    if (!ctype.toLowerCase().includes("multipart/form-data")) {
      reject(httpError(400, "invalid_multipart"));
      return;
    }
    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        limits: {
          fileSize: limit,
          files: 1,
          fields: 16,
          fieldSize: 8 * 1024,
        },
      });
    } catch {
      reject(httpError(400, "invalid_multipart"));
      return;
    }

    const fields = Object.create(null);
    let fileInfo = null;
    const chunks = [];
    let size = 0;
    let truncated = false;
    let settled = false;

    const fail = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      req.unpipe(bb);
      try {
        bb.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };

    bb.on("field", (name, val) => {
      if (name) {
        fields[name] = val;
      }
    });
    bb.on("file", (name, file, info) => {
      if (name !== "file") {
        file.resume();
        return;
      }
      fileInfo = info;
      file.on("data", (chunk) => {
        size += chunk.length;
        chunks.push(chunk);
      });
      file.on("limit", () => {
        truncated = true;
      });
      file.on("error", fail);
    });
    bb.on("error", fail);
    bb.on("partsLimit", () => fail(httpError(400, "invalid_multipart")));
    bb.on("filesLimit", () => fail(httpError(400, "invalid_multipart")));
    bb.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      if (truncated || size > limit) {
        reject(httpError(413, "payload_too_large"));
        return;
      }
      if (!fileInfo) {
        reject(httpError(400, "missing_file"));
        return;
      }
      resolve({
        destDir: fields.destDir,
        filename: fileInfo.filename,
        buffer: Buffer.concat(chunks, size),
      });
    });
    req.on("error", fail);
    req.pipe(bb);
  });
}

async function handleUpload(req, res, workspaceReal) {
  const parsed = await parseMultipart(req);
  const destRel = parseWorkspaceRel(parsed.destDir);
  const name = safeUploadName(parsed.filename);
  const destDirAbs = joinUnder(workspaceReal, destRel);
  const destDirReal = await mkdirInside(workspaceReal, destDirAbs);
  const destAbs = path.join(destDirReal, name);
  if (!isInside(workspaceReal, destAbs) || path.basename(destAbs) !== name) {
    throw httpError(400, "invalid_path");
  }

  const used = await workspaceUsedBytes(workspaceReal);
  let existing = 0;
  try {
    const st = await fs.lstat(destAbs);
    if (st.isDirectory()) {
      throw httpError(400, "not_a_file");
    }
    if (st.isFile() && !st.isSymbolicLink()) {
      existing = st.size;
    }
  } catch (err) {
    if (err && err.status) {
      throw err;
    }
    existing = 0;
  }
  if (used - existing + parsed.buffer.length > quotaBytes()) {
    throw httpError(413, "quota_exceeded");
  }

  const tmp = path.join(destDirReal, `.dsh-upload-${randomBytes(8).toString("hex")}`);
  if (!isInside(workspaceReal, tmp)) {
    throw httpError(400, "invalid_path");
  }
  try {
    await fs.writeFile(tmp, parsed.buffer, { flag: "wx" });
    const tmpReal = await fs.realpath(tmp);
    if (!isInside(workspaceReal, tmpReal)) {
      throw httpError(400, "invalid_path");
    }
    try {
      await fs.unlink(destAbs);
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        throw err;
      }
    }
    await fs.rename(tmp, destAbs);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore
    }
    throw err;
  }

  const savedRel = destRel === "." ? name : `${destRel}/${name}`;
  sendJson(res, 201, { ok: true, path: savedRel, size: parsed.buffer.length });
}

async function handleFilesRequest(req, res, userId, usersRoot) {
  const method = req.method ?? "GET";
  const pathname = normalizePath(req.url);
  const workspaceReal = await userWorkspaceRoot(usersRoot, userId);

  if (method === "GET" && pathname === "/files") {
    sendHtml(res, 200, PAGE_HTML);
    return;
  }
  if (method === "GET" && pathname === "/files/list") {
    await handleList(req, res, workspaceReal);
    return;
  }
  if (method === "GET" && pathname === "/files/download") {
    await handleDownload(req, res, workspaceReal);
    return;
  }
  if (method === "POST" && pathname === "/files/upload") {
    await handleUpload(req, res, workspaceReal);
    return;
  }
  if (method === "DELETE" && pathname === "/files") {
    await handleDelete(req, res, workspaceReal);
    return;
  }

  const known = new Set(["/files", "/files/list", "/files/download", "/files/upload"]);
  if (known.has(pathname)) {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

module.exports = {
  isFilesPath,
  parseWorkspaceRel,
  userWorkspaceRoot,
  resolveExisting,
  isInside,
  joinUnder,
  handleFilesRequest,
};
