"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { COOKIE_NAME, parseCookies } = require("./http");
const { hashPassword, verifyPassword, DUMMY_HASH } = require("./passwords");
const { BOOTSTRAP_LOCK, withTransaction } = require("./db");

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,31}$/;
const DEFAULT_TTL = 7 * 24 * 60 * 60;
const REGISTER_LOCK = BOOTSTRAP_LOCK;

function sessionTtlSeconds() {
  const raw = Number.parseInt(process.env.SESSION_TTL_SECONDS ?? String(DEFAULT_TTL), 10);
  if (!Number.isFinite(raw) || raw < 60) {
    return DEFAULT_TTL;
  }
  return raw;
}

function hashToken(token) {
  const pepper = process.env.SESSION_SECRET ?? "";
  return createHash("sha256").update(pepper).update(":").update(token).digest("hex");
}

function warnIfNoSessionSecret() {
  if (!String(process.env.SESSION_SECRET ?? "").trim()) {
    process.stderr.write(
      "warning: SESSION_SECRET is empty; set it in platform/deploy/.env so session hashes are peppered\n",
    );
  }
}

async function createSession(pool, userId) {
  const token = randomBytes(32).toString("base64url");
  const ttl = sessionTtlSeconds();
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
    [userId, hashToken(token), ttl],
  );
  return { token, maxAge: ttl };
}

async function loadSessionUser(pool, req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) {
    return null;
  }
  const { rows } = await pool.query(
    `SELECT
       u.id, u.username, u.email, u.role, u.status, u.created_at,
       s.id AS session_id
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { user: row, token };
}

async function revokeSession(pool, token) {
  if (!token) {
    return;
  }
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

function validateUsername(username) {
  const name = typeof username === "string" ? username.trim() : "";
  if (!USERNAME_RE.test(name)) {
    const err = new Error("invalid_username");
    err.status = 400;
    err.code = "invalid_username";
    throw err;
  }
  return name;
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    const err = new Error("invalid_password");
    err.status = 400;
    err.code = "invalid_password";
    throw err;
  }
  return password;
}

function validateInviteCode(inviteCode) {
  if (inviteCode === undefined || inviteCode === null || inviteCode === "") {
    const err = new Error("invite_required");
    err.status = 400;
    err.code = "invite_required";
    throw err;
  }
  if (typeof inviteCode !== "string" || inviteCode.length < 4 || inviteCode.length > 128) {
    const err = new Error("invalid_invite");
    err.status = 400;
    err.code = "invalid_invite";
    throw err;
  }
  return inviteCode;
}

async function registerUser(pool, { username, password, inviteCode }) {
  const name = validateUsername(username);
  const pass = validatePassword(password);
  const code = validateInviteCode(inviteCode);
  const passwordHash = await hashPassword(pass);

  try {
    return await withTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [REGISTER_LOCK]);

      const invite = await client.query(
        `SELECT id FROM invites
         WHERE code = $1
           AND used_by IS NULL
           AND (expires_at IS NULL OR expires_at > now())
         FOR UPDATE`,
        [code],
      );
      if (invite.rowCount === 0) {
        const err = new Error("invalid_invite");
        err.status = 400;
        err.code = "invalid_invite";
        throw err;
      }

      const count = await client.query("SELECT count(*)::int AS n FROM users");
      const role = count.rows[0].n === 0 ? "admin" : "user";

      const inserted = await client.query(
        `INSERT INTO users (username, email, password_hash, role, status)
         VALUES ($1, NULL, $2, $3, 'active')
         RETURNING id, username, email, role, status, created_at`,
        [name, passwordHash, role],
      );
      const user = inserted.rows[0];

      await client.query("UPDATE invites SET used_by = $1 WHERE id = $2", [user.id, invite.rows[0].id]);
      return user;
    });
  } catch (err) {
    if (err && err.code === "23505") {
      const taken = new Error("username_taken");
      taken.status = 409;
      taken.code = "username_taken";
      throw taken;
    }
    throw err;
  }
}

async function authenticateUser(pool, { username, password }) {
  if (typeof username !== "string" || typeof password !== "string") {
    const err = new Error("invalid_credentials");
    err.status = 401;
    err.code = "invalid_credentials";
    throw err;
  }

  const { rows } = await pool.query(
    `SELECT id, username, email, role, status, created_at, password_hash
     FROM users
     WHERE lower(username) = lower($1)`,
    [username],
  );
  const row = rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) {
    const err = new Error("invalid_credentials");
    err.status = 401;
    err.code = "invalid_credentials";
    throw err;
  }
  if (row.status === "disabled") {
    const err = new Error("disabled");
    err.status = 403;
    err.code = "disabled";
    throw err;
  }
  delete row.password_hash;
  return row;
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  hashToken,
  warnIfNoSessionSecret,
  createSession,
  loadSessionUser,
  revokeSession,
  registerUser,
  authenticateUser,
  validateUsername,
  validatePassword,
};
