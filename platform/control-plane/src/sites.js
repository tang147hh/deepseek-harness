"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { normalizePath, readJson, sendHtml, sendJson } = require("./http");
const { parseWorkspaceRel, userWorkspaceRoot, resolveExisting, isInside } = require("./files");

const PAGE_HTML = fsSync.readFileSync(path.join(__dirname, "sites-page.html"), "utf8");
const DEFAULT_SITE_MAX = 20 * 1024 * 1024;
const KEEP_VERSIONS = 5;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED_SLUGS = new Set(["www", "api", "admin", "login", "app", "static", "pages"]);
const FORBIDDEN_NAMES = new Set([".env", ".credentials.yaml"]);
const FORBIDDEN_EXT = new Set([".pem", ".key"]);
const ALLOWED_EXT = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".map",
  ".json", ".txt", ".xml", ".svg", ".md", ".csv",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".avif", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".wasm",
  ".mp3", ".mp4", ".webm", ".ogg",
]);
const SKIP_DIRS = new Set([".git", "node_modules"]);

function snapshotsRoot() {
  return process.env.SNAPSHOTS_ROOT ?? "/data/snapshots";
}

function pagesParent() {
  return String(process.env.PAGES_PARENT ?? "pages.localhost").trim().toLowerCase();
}

function siteMaxBytes() {
  const n = Number.parseInt(process.env.SITE_MAX_BYTES ?? String(DEFAULT_SITE_MAX), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SITE_MAX;
}

function publicSiteUrl(slug) {
  return `https://${slug}.${pagesParent()}/`;
}

/** sha256 hex of the site write token. No SESSION_SECRET — pages must verify
 *  without the app session pepper, and a write token must not hash like a session. */
function hashWriteToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

function generateWriteToken() {
  return randomBytes(32).toString("base64url");
}

function isSitesPath(pathname) {
  return pathname === "/sites" || pathname.startsWith("/sites/");
}

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

function isUuid(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

function slugifyPart(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function defaultSlug(username, dirName) {
  const user = slugifyPart(username);
  const name = slugifyPart(dirName);
  let slug = [user, name].filter(Boolean).join("-");
  if (slug.length > 48) {
    slug = slug.slice(0, 48).replace(/-$/g, "");
  }
  return slug;
}

function parseSlug(raw, { username, dirName }) {
  const s = raw == null ? "" : String(raw).trim().toLowerCase();
  const slug = s || defaultSlug(username, dirName);
  if (!SLUG_RE.test(slug)) {
    throw httpError(400, "invalid_slug");
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw httpError(400, "reserved_slug");
  }
  return slug;
}

/** dir must be workspace-relative `sites/<name>` (one segment). */
function parseSiteDir(raw) {
  const rel = parseWorkspaceRel(raw);
  if (rel === "." || !rel.startsWith("sites/")) {
    throw httpError(400, "invalid_path");
  }
  const rest = rel.slice("sites/".length);
  if (!rest || rest.includes("/")) {
    throw httpError(400, "invalid_path");
  }
  return { rel, name: rest };
}

function isForbiddenName(name) {
  const lower = String(name).toLowerCase();
  if (FORBIDDEN_NAMES.has(lower)) {
    return true;
  }
  const ext = path.posix.extname(lower);
  return FORBIDDEN_EXT.has(ext);
}

function isAllowedStaticName(name) {
  const ext = path.posix.extname(String(name).toLowerCase());
  return ALLOWED_EXT.has(ext);
}

async function collectStaticFiles(srcReal) {
  const files = [];
  let bytes = 0;
  const limit = siteMaxBytes();

  async function walk(relDir) {
    const abs = relDir ? path.join(srcReal, ...relDir.split("/")) : srcReal;
    if (!isInside(srcReal, abs)) {
      throw httpError(400, "invalid_path");
    }
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === "ENOENT") {
        throw httpError(404, "not_found");
      }
      throw err;
    }
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const child = path.join(abs, ent.name);
      if (!isInside(srcReal, child)) {
        throw httpError(400, "invalid_path");
      }
      if (ent.isSymbolicLink()) {
        continue;
      }
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name === ".index") {
          continue;
        }
        await walk(rel);
        continue;
      }
      if (!ent.isFile()) {
        continue;
      }
      if (isForbiddenName(ent.name)) {
        throw httpError(400, "forbidden_file");
      }
      if (!isAllowedStaticName(ent.name)) {
        continue;
      }
      let st;
      try {
        st = await fs.lstat(child);
      } catch {
        continue;
      }
      if (!st.isFile() || st.isSymbolicLink()) {
        continue;
      }
      bytes += st.size;
      if (bytes > limit) {
        throw httpError(413, "site_too_large");
      }
      files.push({ rel, abs: child, size: st.size });
    }
  }

  await walk("");
  if (!files.some((f) => f.rel === "index.html")) {
    throw httpError(400, "missing_index");
  }
  return { files, bytes };
}

async function copySnapshot(files, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  for (const f of files) {
    const dest = path.join(destDir, ...f.rel.split("/"));
    if (!isInside(destDir, dest)) {
      throw httpError(400, "invalid_path");
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(f.abs, dest);
  }
}

function indexDir(root) {
  return path.join(root, ".index");
}

function indexPathForSlug(root, slug) {
  if (!SLUG_RE.test(slug)) {
    throw httpError(400, "invalid_slug");
  }
  return path.join(indexDir(root), `${slug}.json`);
}

async function writeSlugIndex(root, slug, payload) {
  const dir = indexDir(root);
  await fs.mkdir(dir, { recursive: true });
  const dest = indexPathForSlug(root, slug);
  const tmp = path.join(dir, `.tmp-${slug}-${randomBytes(8).toString("hex")}.json`);
  if (!isInside(dir, dest) || !isInside(dir, tmp)) {
    throw httpError(500, "internal");
  }
  await fs.writeFile(tmp, `${JSON.stringify(payload)}\n`, { flag: "wx" });
  try {
    try {
      await fs.unlink(dest);
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        throw err;
      }
    }
    await fs.rename(tmp, dest);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

function versionDir(root, siteId, version) {
  if (!isUuid(siteId) || !Number.isInteger(version) || version < 1) {
    throw httpError(400, "invalid_site");
  }
  return path.join(root, siteId, String(version));
}

async function rmVersionDir(root, siteId, version) {
  if (!isUuid(siteId) || !Number.isInteger(version) || version < 1) {
    return;
  }
  const dir = path.resolve(root, siteId, String(version));
  const parent = path.resolve(root, siteId);
  if (!isInside(parent, dir) || dir === parent) {
    return;
  }
  await fs.rm(dir, { recursive: true, force: true });
}

async function pruneVersions(pool, root, siteId, currentVersion) {
  const { rows } = await pool.query(
    `SELECT version FROM site_versions WHERE site_id = $1 ORDER BY version DESC`,
    [siteId],
  );
  const keep = new Set();
  for (const row of rows.slice(0, KEEP_VERSIONS)) {
    keep.add(row.version);
  }
  if (Number.isInteger(currentVersion) && currentVersion >= 1) {
    keep.add(currentVersion);
  }
  for (const row of rows) {
    if (keep.has(row.version)) {
      continue;
    }
    await pool.query("DELETE FROM site_versions WHERE site_id = $1 AND version = $2", [siteId, row.version]);
    try {
      await rmVersionDir(root, siteId, row.version);
    } catch (err) {
      process.stderr.write(`prune snapshot ${siteId}/${row.version} failed: ${err.message}\n`);
    }
  }
}

function canManage(user, site) {
  return site.user_id === user.id || user.role === "admin";
}

async function loadOwnedSite(pool, user, siteId) {
  if (!isUuid(siteId)) {
    throw httpError(400, "invalid_site");
  }
  const { rows } = await pool.query(
    `SELECT id, user_id, slug, status, current_version, created_at
     FROM sites WHERE id = $1`,
    [siteId],
  );
  const site = rows[0];
  if (!site) {
    throw httpError(404, "not_found");
  }
  if (!canManage(user, site)) {
    throw httpError(404, "not_found");
  }
  return site;
}

async function listUserSites(pool, userId) {
  const { rows: sites } = await pool.query(
    `SELECT id, slug, status, current_version, created_at,
            (write_token_hash IS NOT NULL) AS has_write_token
     FROM sites WHERE user_id = $1
     ORDER BY created_at ASC`,
    [userId],
  );
  if (sites.length === 0) {
    return [];
  }
  const ids = sites.map((s) => s.id);
  const { rows: versions } = await pool.query(
    `SELECT site_id, version, bytes, created_at
     FROM site_versions
     WHERE site_id = ANY($1::uuid[])
     ORDER BY version DESC`,
    [ids],
  );
  const bySite = new Map();
  for (const v of versions) {
    if (!bySite.has(v.site_id)) {
      bySite.set(v.site_id, []);
    }
    bySite.get(v.site_id).push({
      version: v.version,
      bytes: Number(v.bytes),
      created_at: v.created_at,
    });
  }
  return sites.map((s) => ({
    id: s.id,
    slug: s.slug,
    status: s.status,
    current_version: s.current_version,
    created_at: s.created_at,
    url: publicSiteUrl(s.slug),
    hasWriteToken: Boolean(s.has_write_token),
    versions: bySite.get(s.id) || [],
  }));
}

async function handleList(res, pool, user) {
  const sites = await listUserSites(pool, user.id);
  sendJson(res, 200, { sites });
}

async function handlePublish(req, res, pool, user, usersRoot) {
  const body = await readJson(req);
  const { rel, name } = parseSiteDir(body.dir);
  const slug = parseSlug(body.slug, { username: user.username, dirName: name });
  const workspaceReal = await userWorkspaceRoot(usersRoot, user.id);
  const { real } = await resolveExisting(workspaceReal, rel);
  const st = await fs.stat(real);
  if (!st.isDirectory()) {
    throw httpError(400, "not_a_directory");
  }
  const sitesRoot = path.join(workspaceReal, "sites");
  if (!isInside(workspaceReal, real) || !isInside(sitesRoot, real) || real === sitesRoot) {
    throw httpError(400, "invalid_path");
  }

  const { files, bytes } = await collectStaticFiles(real);
  const root = snapshotsRoot();
  await fs.mkdir(root, { recursive: true });

  const existing = await pool.query("SELECT id, user_id, slug FROM sites WHERE slug = $1", [slug]);
  if (existing.rows[0] && existing.rows[0].user_id !== user.id) {
    throw httpError(409, "slug_taken");
  }

  let siteId = existing.rows[0]?.id;
  if (!siteId) {
    try {
      const inserted = await pool.query(
        `INSERT INTO sites (user_id, slug, status, current_version)
         VALUES ($1, $2, 'draft', NULL)
         RETURNING id`,
        [user.id, slug],
      );
      siteId = inserted.rows[0].id;
    } catch (err) {
      if (err && err.code === "23505") {
        const again = await pool.query("SELECT id, user_id FROM sites WHERE slug = $1", [slug]);
        if (again.rows[0] && again.rows[0].user_id === user.id) {
          siteId = again.rows[0].id;
        } else {
          throw httpError(409, "slug_taken");
        }
      } else {
        throw err;
      }
    }
  }

  const client = await pool.connect();
  let version;
  let dest;
  let issuedToken = null;
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id, user_id, write_token_hash FROM sites WHERE id = $1 FOR UPDATE`,
      [siteId],
    );
    if (!locked.rows[0] || locked.rows[0].user_id !== user.id) {
      throw httpError(404, "not_found");
    }
    const next = await client.query(
      `SELECT COALESCE(MAX(version), 0)::int + 1 AS n FROM site_versions WHERE site_id = $1`,
      [siteId],
    );
    version = next.rows[0].n;
    dest = versionDir(root, siteId, version);
    const parent = path.join(root, siteId);
    await fs.mkdir(parent, { recursive: true });
    const staging = path.join(parent, `.staging-${version}-${randomBytes(8).toString("hex")}`);
    if (!isInside(parent, staging) || !isInside(parent, dest)) {
      throw httpError(500, "internal");
    }
    try {
      await copySnapshot(files, staging);
      await fs.rm(dest, { recursive: true, force: true });
      await fs.rename(staging, dest);
    } catch (err) {
      try {
        await fs.rm(staging, { recursive: true, force: true });
      } catch {
        // ignore
      }
      throw err;
    }

    const storagePath = `${siteId}/${version}`;
    await client.query(
      `INSERT INTO site_versions (site_id, version, storage_path, bytes)
       VALUES ($1, $2, $3, $4)`,
      [siteId, version, storagePath, bytes],
    );
    if (!locked.rows[0].write_token_hash) {
      issuedToken = generateWriteToken();
      await client.query(
        `UPDATE sites SET current_version = $2, status = 'live', write_token_hash = $3 WHERE id = $1`,
        [siteId, version, hashWriteToken(issuedToken)],
      );
    } else {
      await client.query(
        `UPDATE sites SET current_version = $2, status = 'live' WHERE id = $1`,
        [siteId, version],
      );
    }
    await writeSlugIndex(root, slug, { siteId, version, status: "live" });
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // keep original
    }
    if (dest) {
      try {
        await fs.rm(dest, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    client.release();
  }

  try {
    await pruneVersions(pool, root, siteId, version);
  } catch (err) {
    process.stderr.write(`prune after publish ${siteId} failed: ${err.message}\n`);
  }

  const payload = {
    ok: true,
    siteId,
    slug,
    version,
    status: "live",
    bytes,
    url: publicSiteUrl(slug),
    hasWriteToken: true,
  };
  if (issuedToken) {
    payload.writeToken = issuedToken;
  }
  sendJson(res, 200, payload);
}

async function handleRollback(req, res, pool, user) {
  const body = await readJson(req);
  const site = await loadOwnedSite(pool, user, body.siteId);
  const version = Number.parseInt(body.version, 10);
  if (!Number.isInteger(version) || version < 1) {
    throw httpError(400, "invalid_version");
  }
  const found = await pool.query(
    `SELECT version, storage_path FROM site_versions WHERE site_id = $1 AND version = $2`,
    [site.id, version],
  );
  if (!found.rows[0]) {
    throw httpError(404, "version_not_found");
  }
  const dest = versionDir(snapshotsRoot(), site.id, version);
  try {
    await fs.access(dest);
  } catch {
    throw httpError(404, "version_not_found");
  }

  await pool.query(
    `UPDATE sites SET current_version = $2, status = 'live' WHERE id = $1`,
    [site.id, version],
  );
  await writeSlugIndex(snapshotsRoot(), site.slug, {
    siteId: site.id,
    version,
    status: "live",
  });
  sendJson(res, 200, {
    ok: true,
    siteId: site.id,
    slug: site.slug,
    version,
    status: "live",
    url: publicSiteUrl(site.slug),
  });
}

async function handleRotateToken(req, res, pool, user) {
  const body = await readJson(req);
  const site = await loadOwnedSite(pool, user, body.siteId);
  const writeToken = generateWriteToken();
  await pool.query(`UPDATE sites SET write_token_hash = $2 WHERE id = $1`, [
    site.id,
    hashWriteToken(writeToken),
  ]);
  sendJson(res, 200, {
    ok: true,
    siteId: site.id,
    slug: site.slug,
    writeToken,
  });
}

async function handleTakedown(req, res, pool, user) {
  const body = await readJson(req);
  const site = await loadOwnedSite(pool, user, body.siteId);
  await pool.query(`UPDATE sites SET status = 'taken_down' WHERE id = $1`, [site.id]);
  await writeSlugIndex(snapshotsRoot(), site.slug, {
    siteId: site.id,
    version: site.current_version,
    status: "taken_down",
  });
  sendJson(res, 200, {
    ok: true,
    siteId: site.id,
    slug: site.slug,
    status: "taken_down",
  });
}

async function handleSitesRequest(req, res, pool, user, usersRoot) {
  const method = req.method ?? "GET";
  const pathname = normalizePath(req.url);

  if (method === "GET" && pathname === "/sites") {
    sendHtml(res, 200, PAGE_HTML);
    return;
  }
  if (method === "GET" && pathname === "/sites/list") {
    await handleList(res, pool, user);
    return;
  }
  if (method === "POST" && pathname === "/sites/publish") {
    await handlePublish(req, res, pool, user, usersRoot);
    return;
  }
  if (method === "POST" && pathname === "/sites/rollback") {
    await handleRollback(req, res, pool, user);
    return;
  }
  if (method === "POST" && pathname === "/sites/takedown") {
    await handleTakedown(req, res, pool, user);
    return;
  }
  if (method === "POST" && pathname === "/sites/token") {
    await handleRotateToken(req, res, pool, user);
    return;
  }

  const known = new Set([
    "/sites",
    "/sites/list",
    "/sites/publish",
    "/sites/rollback",
    "/sites/takedown",
    "/sites/token",
  ]);
  if (known.has(pathname)) {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

module.exports = {
  isSitesPath,
  parseSiteDir,
  parseSlug,
  defaultSlug,
  SLUG_RE,
  RESERVED_SLUGS,
  handleSitesRequest,
  publicSiteUrl,
  collectStaticFiles,
  hashWriteToken,
  generateWriteToken,
};
