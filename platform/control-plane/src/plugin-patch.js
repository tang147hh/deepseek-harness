"use strict";

const PLATFORM_PUBLISH_SITE_ID = "platform-publish-site";
const PLATFORM_PUBLISH_SITE_NAME = "/opt/dsh-platform/agent-bridge/index.js";

const PLATFORM_PUBLISH_SITE = Object.freeze({
  id: PLATFORM_PUBLISH_SITE_ID,
  fields: Object.freeze({ name: PLATFORM_PUBLISH_SITE_NAME }),
});

function unreadable() {
  const err = new Error("patch_unreadable");
  err.code = "patch_unreadable";
  return err;
}

function yamlScalar(value) {
  const s = String(value);
  if (s === "" || /[:#{}[\],&*?!|>'"%@`]|^\s|\s$/.test(s) || /[\r\n]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function isBlankOrComment(line) {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/**
 * Conservative parser for the platform overlay subset:
 * top-level `- id:` (optional `disabled`) and `- insert:` lists of `{id, name, ...}`.
 * Throws patch_unreadable on anything else rather than guessing.
 */
function parsePatchYaml(text) {
  if (typeof text !== "string" || text.includes("\0")) {
    throw unreadable();
  }
  const lines = text.split(/\r?\n/);
  const ops = [];
  let i = 0;

  function skipNoise() {
    while (i < lines.length && isBlankOrComment(lines[i])) {
      i += 1;
    }
  }

  while (true) {
    skipNoise();
    if (i >= lines.length) {
      break;
    }
    const line = lines[i];
    if (!line.startsWith("- ")) {
      throw unreadable();
    }
    const rest = line.slice(2).trimEnd();
    if (rest.startsWith("id:")) {
      const id = rest.slice(3).trim();
      if (!id || /\s/.test(id) || id.includes("/") || id.includes("\\")) {
        throw unreadable();
      }
      i += 1;
      let disabled = null;
      let extra = false;
      while (i < lines.length) {
        const cur = lines[i];
        if (isBlankOrComment(cur)) {
          i += 1;
          continue;
        }
        if (cur.startsWith("- ")) {
          break;
        }
        if (!cur.startsWith("  ")) {
          throw unreadable();
        }
        const dm = cur.match(/^  disabled:\s*(true|false)\s*$/);
        if (dm) {
          disabled = dm[1] === "true";
          i += 1;
          continue;
        }
        extra = true;
        i += 1;
      }
      ops.push({ type: "overlay", id, disabled, extra });
    } else if (rest === "insert:" || rest.startsWith("insert:")) {
      if (rest !== "insert:" && rest.slice("insert:".length).trim() !== "") {
        throw unreadable();
      }
      i += 1;
      const plugins = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (isBlankOrComment(cur)) {
          i += 1;
          continue;
        }
        if (cur.startsWith("- ")) {
          break;
        }
        const item = cur.match(/^(\s+)-\s+id:\s*(\S+)\s*$/);
        if (!item) {
          throw unreadable();
        }
        const plugin = { id: item[2], fields: {} };
        const baseIndent = item[1].length;
        i += 1;
        while (i < lines.length) {
          const nested = lines[i];
          if (isBlankOrComment(nested)) {
            i += 1;
            continue;
          }
          if (nested.startsWith("- ")) {
            break;
          }
          if (/^\s+-\s+id:\s*/.test(nested)) {
            break;
          }
          const kv = nested.match(/^(\s+)([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
          if (!kv || kv[1].length <= baseIndent) {
            throw unreadable();
          }
          plugin.fields[kv[2]] = kv[3].trim();
          i += 1;
        }
        plugins.push(plugin);
      }
      ops.push({ type: "insert", plugins });
    } else {
      throw unreadable();
    }
  }
  return ops;
}

function serializePatch(ops) {
  const lines = [
    "# Official plugin preset overlay for this user only.",
    "# Do not put API keys here. Custom (non-official) insert rows are kept.",
    "# platform-publish-site is always retained.",
  ];
  for (const op of ops || []) {
    if (op.type === "overlay") {
      lines.push(`- id: ${op.id}`);
      if (op.disabled === true) {
        lines.push("  disabled: true");
      } else if (op.disabled === false) {
        lines.push("  disabled: false");
      }
    } else if (op.type === "insert") {
      const plugins = op.plugins || [];
      if (plugins.length === 0) {
        continue;
      }
      lines.push("- insert:");
      for (const plugin of plugins) {
        lines.push(`    - id: ${plugin.id}`);
        const fields = plugin.fields || {};
        for (const [key, value] of Object.entries(fields)) {
          if (key === "id") {
            continue;
          }
          lines.push(`      ${key}: ${yamlScalar(value)}`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function disabledOfficialIds(ops, official) {
  const out = [];
  const seen = new Set();
  for (const op of ops || []) {
    if (op.type !== "overlay") {
      continue;
    }
    if (op.disabled !== true) {
      continue;
    }
    if (!official.has(op.id) || seen.has(op.id)) {
      continue;
    }
    seen.add(op.id);
    out.push(op.id);
  }
  return out;
}

/**
 * Replace official overlay disable rows with this preset.
 * Keep platform-publish-site (rewritten to the platform path).
 * Keep this user's private (non-official) insert/overlay rows.
 * Never copies another user's files.
 */
function applyOfficialPreset(existingText, pluginIds, official) {
  let ops = [];
  if (existingText != null && String(existingText).trim() !== "") {
    ops = parsePatchYaml(existingText);
  }
  const keptOverlays = [];
  const privateInserts = [];
  for (const op of ops) {
    if (op.type === "overlay") {
      if (op.id === PLATFORM_PUBLISH_SITE_ID) {
        continue;
      }
      if (official.has(op.id)) {
        continue;
      }
      if (op.extra) {
        throw unreadable();
      }
      keptOverlays.push({ type: "overlay", id: op.id, disabled: op.disabled });
    } else if (op.type === "insert") {
      for (const plugin of op.plugins || []) {
        if (plugin.id === PLATFORM_PUBLISH_SITE_ID) {
          continue;
        }
        if (official.has(plugin.id)) {
          continue;
        }
        privateInserts.push(plugin);
      }
    }
  }
  const overlay = (pluginIds || []).map((id) => ({
    type: "overlay",
    id,
    disabled: true,
  }));
  return serializePatch([
    ...overlay,
    ...keptOverlays,
    {
      type: "insert",
      plugins: [
        { id: PLATFORM_PUBLISH_SITE_ID, fields: { name: PLATFORM_PUBLISH_SITE_NAME } },
        ...privateInserts,
      ],
    },
  ]);
}

module.exports = {
  PLATFORM_PUBLISH_SITE_ID,
  PLATFORM_PUBLISH_SITE_NAME,
  PLATFORM_PUBLISH_SITE,
  parsePatchYaml,
  serializePatch,
  disabledOfficialIds,
  applyOfficialPreset,
};
