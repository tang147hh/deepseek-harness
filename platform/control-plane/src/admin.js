"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { normalizePath, parseQuery, readJson, sendHtml, sendJson, publicUser } = require("./http");
const { hashPassword } = require("./passwords");
const { writeAudit, listAudit } = require("./audit");
const { logError } = require("./log");
const { isAdminPath } = require("./paths");
const { publicSiteUrl, loadSiteById, takedownSite } = require("./sites");
const { stopRuntime, listRuntimes } = require("./runtime");
const { insertPluginPreset } = require("./plugins");

const INVITE_RE = /^[A-Za-z0-9._~-]{8,128}$/;

const PAGE_HTML = fsSync.readFileSync(path.join(__dirname, "admin-page.html"), "utf8");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDENTIALS_NAME = ".credentials.yaml";

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

function isUuid(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

function parseUserId(raw) {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!isUuid(id)) {
    throw httpError(400, "invalid_user");
  }
  return id;
}

function generateInviteCode() {
  return randomBytes(18).toString("base64url");
}

function parseInviteCode(raw) {
  if (raw == null || raw === "") {
    return generateInviteCode();
  }
  if (typeof raw !== "string" || !INVITE_RE.test(raw.trim())) {
    throw httpError(400, "invalid_invite");
  }
  return raw.trim();
}

function parseNewPassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw httpError(400, "invalid_password");
  }
  return password;
}

/**
 * Presence only: non-empty home/.credentials.yaml via lstat size.
 * Never reads the file, so Key bytes never enter the process response path.
 */
async function credentialsFlag(usersRoot, userId) {
  const file = path.join(usersRoot, userId, "home", CREDENTIALS_NAME);
  try {
    const st = await fs.lstat(file);
    if (st.isFile() && st.size > 0) {
      return "configured";
    }
  } catch {
    // missing
  }
  return "missing";
}

function requireAdmin(user) {
  if (!user) {
    throw httpError(401, "unauthenticated");
  }
  if (user.role !== "admin") {
    throw httpError(403, "forbidden");
  }
}

async function handleListUsers(res, pool, usersRoot) {
  const { rows } = await pool.query(
    `SELECT id, username, role, status, created_at
     FROM users
     ORDER BY created_at ASC`,
  );
  const users = [];
  for (const row of rows) {
    users.push({
      id: row.id,
      username: row.username,
      role: row.role,
      status: row.status,
      created_at: row.created_at,
      credentials: await credentialsFlag(usersRoot, row.id),
    });
  }
  sendJson(res, 200, { users });
}

async function handleInvite(req, res, pool, actor) {
  const body = await readJson(req);
  const code = parseInviteCode(body.code);
  let row;
  try {
    const inserted = await pool.query(
      `INSERT INTO invites (code, created_by)
       VALUES ($1, $2)
       RETURNING id, code, created_at`,
      [code, actor.id],
    );
    row = inserted.rows[0];
  } catch (err) {
    if (err && err.code === "23505") {
      throw httpError(409, "invite_taken");
    }
    throw err;
  }
  await writeAudit(pool, {
    actorId: actor.id,
    action: "invite_create",
    target: row.code,
    meta: { inviteId: row.id },
  });
  sendJson(res, 201, { ok: true, id: row.id, code: row.code, created_at: row.created_at });
}

async function handleDisable(req, res, pool, actor) {
  const body = await readJson(req);
  const userId = parseUserId(body.userId);
  const { rows } = await pool.query(
    `UPDATE users SET status = 'disabled'
     WHERE id = $1
     RETURNING id, username, role, status, created_at`,
    [userId],
  );
  if (!rows[0]) {
    throw httpError(404, "not_found");
  }
  let runtime = null;
  try {
    runtime = await stopRuntime(userId);
  } catch (err) {
    runtime = { error: err.code || "runtime_stop_failed" };
    logError(err, { svc: "control-plane", path: "/admin/users/disable", userId });
  }
  await writeAudit(pool, {
    actorId: actor.id,
    action: "user_disable",
    target: userId,
    meta: { username: rows[0].username, runtimeStatus: runtime && runtime.status },
  });
  sendJson(res, 200, { ok: true, user: publicUser(rows[0]), runtime });
}

async function handleResetPassword(req, res, pool, actor) {
  const body = await readJson(req);
  const userId = parseUserId(body.userId);
  const pass = parseNewPassword(body.password);
  const passwordHash = await hashPassword(pass);
  const { rows } = await pool.query(
    `UPDATE users SET password_hash = $2
     WHERE id = $1
     RETURNING id, username`,
    [userId, passwordHash],
  );
  if (!rows[0]) {
    throw httpError(404, "not_found");
  }
  await writeAudit(pool, {
    actorId: actor.id,
    action: "user_reset_password",
    target: userId,
    meta: { username: rows[0].username },
  });
  sendJson(res, 200, { ok: true, userId: rows[0].id, username: rows[0].username });
}

async function handleListSites(res, pool) {
  const { rows } = await pool.query(
    `SELECT s.id, s.slug, s.status, s.created_at, u.username AS owner
     FROM sites s
     JOIN users u ON u.id = s.user_id
     ORDER BY s.created_at ASC`,
  );
  sendJson(res, 200, {
    sites: rows.map((s) => ({
      id: s.id,
      slug: s.slug,
      owner: s.owner,
      status: s.status,
      created_at: s.created_at,
      url: publicSiteUrl(s.slug),
    })),
  });
}

async function handleAdminTakedown(req, res, pool, actor) {
  const body = await readJson(req);
  const site = await loadSiteById(pool, body.siteId);
  const result = await takedownSite(pool, site);
  await writeAudit(pool, {
    actorId: actor.id,
    action: "site_takedown",
    target: site.id,
    meta: { slug: site.slug, ownerId: site.user_id },
  });
  sendJson(res, 200, result);
}

async function handleListRuntimes(res) {
  const listed = await listRuntimes();
  sendJson(res, 200, {
    runtimes: Array.isArray(listed.runtimes) ? listed.runtimes : Array.isArray(listed) ? listed : [],
  });
}

async function handleStopRuntime(req, res, pool, actor) {
  const body = await readJson(req);
  const userId = parseUserId(body.userId);
  const result = await stopRuntime(userId);
  await writeAudit(pool, {
    actorId: actor.id,
    action: "runtime_stop",
    target: userId,
    meta: { name: result && result.name, status: result && result.status },
  });
  sendJson(res, 200, { ok: true, userId, ...result });
}

async function handleAdminRequest(req, res, pool, user, usersRoot) {
  requireAdmin(user);
  const method = req.method ?? "GET";
  const pathname = normalizePath(req.url);

  if (method === "GET" && pathname === "/admin") {
    sendHtml(res, 200, PAGE_HTML);
    return;
  }
  if (method === "GET" && pathname === "/admin/users") {
    await handleListUsers(res, pool, usersRoot);
    return;
  }
  if (method === "POST" && pathname === "/admin/invites") {
    await handleInvite(req, res, pool, user);
    return;
  }
  if (method === "POST" && pathname === "/admin/users/disable") {
    await handleDisable(req, res, pool, user);
    return;
  }
  if (method === "POST" && pathname === "/admin/users/reset-password") {
    await handleResetPassword(req, res, pool, user);
    return;
  }
  if (method === "GET" && pathname === "/admin/sites") {
    await handleListSites(res, pool);
    return;
  }
  if (method === "POST" && pathname === "/admin/sites/takedown") {
    await handleAdminTakedown(req, res, pool, user);
    return;
  }
  if (method === "GET" && pathname === "/admin/audit") {
    const limit = parseQuery(req.url).get("limit");
    const entries = await listAudit(pool, { limit });
    sendJson(res, 200, { entries });
    return;
  }
  if (method === "GET" && pathname === "/admin/runtimes") {
    await handleListRuntimes(res);
    return;
  }
  if (method === "POST" && pathname === "/admin/runtimes/stop") {
    await handleStopRuntime(req, res, pool, user);
    return;
  }
  if (method === "POST" && pathname === "/admin/plugin-presets") {
    const body = await readJson(req);
    const created = await insertPluginPreset(pool, user, body);
    sendJson(res, 201, created);
    return;
  }

  const known = new Set([
    "/admin",
    "/admin/users",
    "/admin/invites",
    "/admin/users/disable",
    "/admin/users/reset-password",
    "/admin/sites",
    "/admin/sites/takedown",
    "/admin/audit",
    "/admin/runtimes",
    "/admin/runtimes/stop",
    "/admin/plugin-presets",
  ]);
  if (known.has(pathname)) {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

module.exports = {
  isAdminPath,
  credentialsFlag,
  handleAdminRequest,
};
