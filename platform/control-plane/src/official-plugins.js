"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Official plugin ids from deepseek-harness web-app cordis.patch.yml.
 * Presets may only reference these ids (no user paths / JS / URLs).
 * Fallback is used in the control-plane image when the monorepo yaml is absent.
 */
const FALLBACK_OFFICIAL_PLUGIN_IDS = Object.freeze([
  "system-prompt",
  "hmr",
  "session-query-sqlite",
  "tools",
  "code-runtime",
  "storage",
  "storage-json",
  "storage-domain",
  "message-feedback",
  "session-log-download",
  "workspace",
  "session-projection-cache",
  "session-stats",
  "directory-picker",
  "plugin-inventory",
  "api-gateway",
  "cordis-host-runner",
  "web-startup",
  "webserver",
  "web-runtime",
  "client-hmr",
  "modules",
  "connection",
  "api-remotes",
  "client-runtime",
  "cordis-client-runner",
  "ui-theme",
  "locale",
  "ui-layout",
  "ui-sidebar",
  "ui-settings",
  "ui-settings-general",
  "ui-settings-models",
  "ui-settings-plugin-inventory",
  "ui-conversation",
  "ui-tool",
  "ui-cordis",
  "ui-workflow-run",
  "ui-deliverables",
  "ui-workspace",
  "ui-input-trigger",
  "ui-commands",
  "ui-skill",
  "ui-subagent",
  "ui-jobs",
  "ui-goal",
  "ui-message-feedback",
  "ui-model-selection",
  "ui-permission",
  "ui-agent-preset",
  "ui-settings-plugins",
  "ui-plan",
  "ui-user-questions",
  "ui-trajectory",
  "tool-bash",
  "tool-pwsh",
  "tool-jobs",
  "tool-fs",
  "tool-fs-search",
  "tool-str-replace-editor",
  "skill-filesystem",
  "tool-skill",
  "tool-goal",
  "plan-mode",
  "compaction-basic",
  "command-compact",
  "tool-result-pruner",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-subagent",
  "tool-subagent-fork",
  "workflow-worker-thread",
  "tool-workflow",
  "tool-ralph",
  "agent-instructions",
  "tool-todo",
  "tool-web",
  "agent-presets",
]);

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PRESET_NAME_RE = /^[^\r\n]{1,80}$/;
const ALLOWED_PRESET_KEYS = new Set(["name", "pluginIds", "plugin_ids", "description"]);
const MAX_PLUGIN_IDS = 64;

const SEED_WEB_DEFAULT_ID = "a1000000-0000-4000-8000-000000000001";
const SEED_DISABLE_HMR_ID = "a1000000-0000-4000-8000-000000000002";

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

function repoWebAppPatchPath() {
  return path.join(
    __dirname,
    "..",
    "..",
    "..",
    "deepseek-harness",
    "packages",
    "bundle",
    "web-app",
    "cordis.patch.yml",
  );
}

function extractOfficialPluginIds(yamlText) {
  const ids = [];
  const seen = new Set();
  for (const line of String(yamlText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = line.match(/^\s*-?\s*id:\s*([A-Za-z][A-Za-z0-9-]*)\s*$/);
    if (!match) {
      continue;
    }
    const id = match[1];
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function readOfficialIdsFromDisk() {
  const candidates = [
    process.env.OFFICIAL_WEB_APP_PATCH,
    repoWebAppPatchPath(),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const ids = extractOfficialPluginIds(text);
      if (ids.length > 0) {
        return ids;
      }
    } catch {
      // next candidate
    }
  }
  return null;
}

let cachedOfficial = null;

function loadOfficialPluginIds() {
  if (cachedOfficial) {
    return cachedOfficial;
  }
  const fromDisk = readOfficialIdsFromDisk();
  cachedOfficial = new Set(fromDisk && fromDisk.length ? fromDisk : FALLBACK_OFFICIAL_PLUGIN_IDS);
  return cachedOfficial;
}

function resetOfficialPluginIdCache() {
  cachedOfficial = null;
}

function looksLikeUserFileRef(value) {
  if (typeof value !== "string") {
    return false;
  }
  const s = value.trim();
  if (!s) {
    return false;
  }
  if (s.includes("\0") || s.includes("\\") || s.includes("/") || s.includes("..")) {
    return true;
  }
  if (/^[a-zA-Z]:/.test(s)) {
    return true;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    return true;
  }
  if (s.startsWith("~") || s.startsWith(".")) {
    return true;
  }
  if (/\.(js|mjs|cjs|ts|jsx|tsx|json)$/i.test(s)) {
    return true;
  }
  return false;
}

function assertOfficialPluginIds(rawIds) {
  if (rawIds == null) {
    return [];
  }
  if (!Array.isArray(rawIds)) {
    throw httpError(400, "unofficial_plugin");
  }
  if (rawIds.length > MAX_PLUGIN_IDS) {
    throw httpError(400, "too_many_plugin_ids");
  }
  const official = loadOfficialPluginIds();
  const seen = new Set();
  const out = [];
  for (const raw of rawIds) {
    if (typeof raw !== "string") {
      throw httpError(400, "unofficial_plugin");
    }
    const id = raw.trim();
    if (!id || looksLikeUserFileRef(id) || !PLUGIN_ID_RE.test(id) || !official.has(id)) {
      throw httpError(400, "unofficial_plugin");
    }
    if (seen.has(id)) {
      throw httpError(400, "duplicate_plugin_id");
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

function parseOptionalDescription(raw) {
  if (raw == null || raw === "") {
    return null;
  }
  if (typeof raw !== "string") {
    throw httpError(400, "invalid_description");
  }
  const text = raw.trim();
  if (text.length > 200) {
    throw httpError(400, "invalid_description");
  }
  if (looksLikeUserFileRef(text) || /[\r\n]/.test(raw)) {
    throw httpError(400, "unofficial_plugin");
  }
  return text;
}

function assertPresetPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "invalid_json");
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_PRESET_KEYS.has(key) || looksLikeUserFileRef(key)) {
      throw httpError(400, "unofficial_plugin");
    }
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || !PRESET_NAME_RE.test(name) || looksLikeUserFileRef(name)) {
    throw httpError(400, "invalid_name");
  }
  const pluginIds = assertOfficialPluginIds(body.pluginIds ?? body.plugin_ids ?? []);
  const description = parseOptionalDescription(body.description);
  return { name, pluginIds, description };
}

module.exports = {
  FALLBACK_OFFICIAL_PLUGIN_IDS,
  PLUGIN_ID_RE,
  SEED_WEB_DEFAULT_ID,
  SEED_DISABLE_HMR_ID,
  repoWebAppPatchPath,
  extractOfficialPluginIds,
  loadOfficialPluginIds,
  resetOfficialPluginIdCache,
  looksLikeUserFileRef,
  assertOfficialPluginIds,
  assertPresetPayload,
};
