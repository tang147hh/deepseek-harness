"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { Pool } = require("pg");

const BOOTSTRAP_LOCK = 0x64736831; // "dsh1"
const INVITE_RE = /^[A-Za-z0-9._~-]{8,128}$/;

function createPool() {
  return new Pool({
    host: process.env.POSTGRES_HOST ?? "postgres",
    port: Number.parseInt(process.env.POSTGRES_PORT ?? "5432", 10),
    user: process.env.POSTGRES_USER ?? "dsh",
    password: process.env.POSTGRES_PASSWORD ?? "dsh",
    database: process.env.POSTGRES_DB ?? "dsh",
    max: 10,
  });
}

async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, "migrate.sql"), "utf8");
  await pool.query(sql);
}

function generateInviteCode() {
  return randomBytes(18).toString("base64url");
}

function envBootstrapCode() {
  const raw = String(process.env.BOOTSTRAP_INVITE_CODE ?? "").trim();
  if (!raw) {
    return "";
  }
  if (!INVITE_RE.test(raw)) {
    process.stderr.write(
      "bootstrap: BOOTSTRAP_INVITE_CODE is invalid (8-128 chars, A-Za-z0-9._~-); generating a random code instead\n",
    );
    return "";
  }
  return raw;
}

async function bootstrapInviteIfEmpty(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_LOCK]);
    const { rows } = await client.query("SELECT count(*)::int AS n FROM users");
    if (rows[0].n > 0) {
      await client.query("COMMIT");
      return null;
    }

    const preferred = envBootstrapCode();
    if (preferred) {
      await client.query(
        `INSERT INTO invites (code, created_by, used_by, expires_at)
         VALUES ($1, NULL, NULL, NULL)
         ON CONFLICT (code) DO NOTHING`,
        [preferred],
      );
    }

    const unused = await client.query(
      `SELECT code FROM invites
       WHERE used_by IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at ASC
       LIMIT 1`,
    );

    let code = unused.rows[0]?.code;
    if (!code) {
      code = preferred || generateInviteCode();
      await client.query(
        `INSERT INTO invites (code, created_by, used_by, expires_at)
         VALUES ($1, NULL, NULL, NULL)
         ON CONFLICT (code) DO NOTHING`,
        [code],
      );
    }

    await client.query("COMMIT");
    process.stdout.write(
      `bootstrap: users table is empty; one-time invite code: ${code}\n` +
        "bootstrap: first successful POST /auth/register becomes role=admin\n" +
        "bootstrap: to pin the code, set BOOTSTRAP_INVITE_CODE in platform/deploy/.env (not under DATA_ROOT)\n",
    );
    return code;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // keep original error
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  BOOTSTRAP_LOCK,
  INVITE_RE,
  createPool,
  migrate,
  generateInviteCode,
  bootstrapInviteIfEmpty,
  withTransaction,
};
