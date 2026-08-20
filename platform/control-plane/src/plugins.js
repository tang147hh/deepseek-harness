"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { normalizePath, readJson, sendHtml, sendJson } = require("./http");
const { isInside } = require("./files");
const { writeAudit } = require("./audit");
const { restartRuntimeIfRunning } = require("./runtime");
const {
  assertOfficialPluginIds,
  assertPresetPayload,
  loadOfficialPluginIds,
} = require("./official-plugins");
const {
  applyOfficialPreset,
  disabledOfficialIds,
  parsePatchYaml,
} = require("./plugin-patch");

const PAGE_HTML = fsSync.readFileSync(path.join(__dirname, "plugins-page.html"), "utf8");
const PATCH_NAME = "cordis.patch.yml";
const PATCH_MAX_BYTES = 256 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

const CONTROL_PLUGIN_PATHS = new Set([
  "/plugins",
  "/plugins/presets",
  "/plugins/me",
  "/plugins/apply",
]);

// Only the marketplace page and its JSON APIs. dsh serves client bundles at
// /plugins/<id>/client.js and HMR at /plugins/events — those must proxy through.
function isPluginsPath(pathname) {
  return CONTROL_PLUGIN_PATHS.has(pathname);
}

function isUuid(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

function publicPreset(row) {
  const pluginIds = Array.isArray(row.plugin_ids)
    ? row.plugin_ids
    : Array.isArray(row.pluginIds)
      ? row.pluginIds
      : [];
  return {
    id: row.id,
    name: row.name,
    pluginIds,
  };
}

function userHomeDir(usersRoot, userId) {
  return path.resolve(usersRoot, userId, "home");
}

async function userPatchPath(usersRoot, userId) {
  const home = userHomeDir(usersRoot, userId);
  await fs.mkdir(home, { recursive: true });
  let resolvedHome = home;
  try {
    resolvedHome = await fs.realpath(home);
  } catch {
    resolvedHome = home;
  }
  const file = path.join(resolvedHome, PATCH_NAME);
  if (!isInside(resolvedHome, file)) {
    throw httpError(400, "invalid_path");
  }
  return file;
}

async function readPatchFile(file) {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile()) {
      return { exists: true, text: null, tooLarge: false };
    }
    if (st.size > PATCH_MAX_BYTES) {
      return { exists: true, text: null, tooLarge: true };
    }
    const text = await fs.readFile(file, { encoding: "utf8" });
    return { exists: true, text, tooLarge: false };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { exists: false, text: null, tooLarge: false };
    }
    throw err;
  }
}

async function writePatchFile(file, contents) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.cordis.patch.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, contents, { encoding: "utf8" });
  await fs.rename(tmp, file);
}

async function listPresets(pool) {
  const { rows } = await pool.query(
    `SELECT id, name, plugin_ids
     FROM plugin_presets
     ORDER BY created_at ASC, name ASC`,
  );
  return rows.map(publicPreset);
}

async function loadPreset(pool, presetId) {
  const { rows } = await pool.query(
    `SELECT id, name, plugin_ids
     FROM plugin_presets
     WHERE id = $1`,
    [presetId],
  );
  return rows[0] || null;
}

async function handleListPresets(res, pool) {
  const presets = await listPresets(pool);
  sendJson(res, 200, { presets });
}

async function handleMe(res, usersRoot, userId) {
  const file = await userPatchPath(usersRoot, userId);
  const { exists, text, tooLarge } = await readPatchFile(file);
  if (!exists) {
    sendJson(res, 200, { exists: false, parsed: false });
    return;
  }
  if (tooLarge || text == null) {
    sendJson(res, 200, { exists: true, parsed: false });
    return;
  }
  try {
    const ops = parsePatchYaml(text);
    sendJson(res, 200, {
      exists: true,
      parsed: true,
      disabledOfficialIds: disabledOfficialIds(ops, loadOfficialPluginIds()),
    });
  } catch {
    sendJson(res, 200, { exists: true, parsed: false });
  }
}

async function handleApply(req, res, pool, user, usersRoot) {
  const body = await readJson(req);
  const presetId = typeof body.presetId === "string" ? body.presetId.trim() : "";
  if (!isUuid(presetId)) {
    throw httpError(400, "invalid_preset");
  }
  const row = await loadPreset(pool, presetId);
  if (!row) {
    throw httpError(404, "not_found");
  }
  const pluginIds = assertOfficialPluginIds(row.plugin_ids);
  const file = await userPatchPath(usersRoot, user.id);
  const current = await readPatchFile(file);
  if (current.tooLarge) {
    throw httpError(400, "patch_unreadable");
  }
  let next;
  try {
    next = applyOfficialPreset(current.text, pluginIds, loadOfficialPluginIds());
  } catch (err) {
    if (err && err.code === "patch_unreadable") {
      throw httpError(400, "patch_unreadable");
    }
    throw err;
  }
  await writePatchFile(file, next);

  let runtime = { attempted: false, restarted: false };
  try {
    runtime = await restartRuntimeIfRunning(user.id);
  } catch (err) {
    runtime = {
      attempted: true,
      restarted: false,
      error: (err && (err.code || err.message)) || "runtime_restart_failed",
    };
  }

  await writeAudit(pool, {
    actorId: user.id,
    action: "plugin_preset_apply",
    target: presetId,
    meta: { name: row.name, pluginIds },
  });

  sendJson(res, 200, {
    ok: true,
    presetId: row.id,
    name: row.name,
    pluginIds,
    runtime,
  });
}

async function insertPluginPreset(pool, actor, body) {
  const payload = assertPresetPayload(body);
  let row;
  try {
    const inserted = await pool.query(
      `INSERT INTO plugin_presets (name, plugin_ids, description)
       VALUES ($1, $2, $3)
       RETURNING id, name, plugin_ids, description, created_at`,
      [payload.name, payload.pluginIds, payload.description],
    );
    row = inserted.rows[0];
  } catch (err) {
    if (err && err.code === "23505") {
      throw httpError(409, "preset_taken");
    }
    throw err;
  }
  await writeAudit(pool, {
    actorId: actor.id,
    action: "plugin_preset_create",
    target: row.id,
    meta: { name: row.name, pluginIds: payload.pluginIds },
  });
  return {
    ok: true,
    id: row.id,
    name: row.name,
    pluginIds: payload.pluginIds,
    description: row.description || payload.description,
    created_at: row.created_at,
  };
}

async function handlePluginsRequest(req, res, pool, user, usersRoot) {
  if (!user) {
    sendJson(res, 401, { error: "unauthenticated" });
    return;
  }
  const method = req.method ?? "GET";
  const pathname = normalizePath(req.url);

  if (method === "GET" && pathname === "/plugins") {
    sendHtml(res, 200, PAGE_HTML);
    return;
  }
  if (method === "GET" && pathname === "/plugins/presets") {
    await handleListPresets(res, pool);
    return;
  }
  if (method === "GET" && pathname === "/plugins/me") {
    await handleMe(res, usersRoot, user.id);
    return;
  }
  if (method === "POST" && pathname === "/plugins/apply") {
    await handleApply(req, res, pool, user, usersRoot);
    return;
  }

  sendJson(res, 405, { error: "method_not_allowed" });
}

module.exports = {
  PATCH_NAME,
  isPluginsPath,
  publicPreset,
  listPresets,
  insertPluginPreset,
  handlePluginsRequest,
  userPatchPath,
};
