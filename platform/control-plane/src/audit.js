"use strict";

const { redact, logError } = require("./log");

/**
 * Plate K audit_log. Never store passwords or API keys in meta.
 * Plate L lists the same rows for admin; token-like meta is masked.
 */

function scrubMeta(meta) {
  if (meta == null) {
    return null;
  }
  if (typeof meta === "string") {
    try {
      return redact(JSON.parse(meta));
    } catch {
      return redact(meta);
    }
  }
  return redact(meta);
}

function publicAuditRow(row) {
  return {
    id: row.id,
    actorId: row.actor_id,
    action: row.action,
    target: row.target,
    meta: scrubMeta(row.meta),
    createdAt: row.created_at,
  };
}

function parseLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return 50;
  }
  return Math.min(n, 100);
}

/**
 * Best-effort audit write. Failures are logged; callers still complete the action.
 */
async function writeAudit(pool, { actorId = null, action, target = null, meta = null } = {}) {
  if (!pool || !action) {
    return;
  }
  try {
    const safeMeta = meta == null ? null : scrubMeta(meta);
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, target, meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [actorId || null, String(action), target == null ? null : String(target), safeMeta == null ? null : JSON.stringify(safeMeta)],
    );
  } catch (err) {
    logError(err, { svc: "control-plane", path: "audit_log" });
  }
}

async function listAudit(pool, { limit = 50 } = {}) {
  const n = parseLimit(limit);
  const { rows } = await pool.query(
    `SELECT id, actor_id, action, target, meta, created_at
     FROM audit_log
     ORDER BY created_at DESC
     LIMIT $1`,
    [n],
  );
  return rows.map(publicAuditRow);
}

module.exports = { writeAudit, listAudit, scrubMeta, parseLimit };
