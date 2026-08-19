"use strict";

const { bearerToken } = require("./http");
const { verifyPlatformUserToken } = require("./platform-token");

/**
 * Paths an Agent PLATFORM_USER_TOKEN may call. Cookie sessions keep the full
 * /sites surface (HTML page, rollback, takedown, token rotate). A platform
 * token is not a login cookie and must not reach /auth or /files.
 */
function isPlatformTokenAllowed(method, pathname) {
  if (method === "GET" && pathname === "/sites/list") {
    return true;
  }
  if (method === "POST" && pathname === "/sites/publish") {
    return true;
  }
  return false;
}

async function loadUserById(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, username, email, role, status, created_at
     FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] || null;
}

/**
 * Resolve a PLATFORM_USER_TOKEN from Authorization: Bearer.
 * Invalid / expired / KV write tokens / session cookies → null (caller 401).
 * Disabled users are still returned so the gate can 403.
 */
async function tryPlatformUser(pool, req, method, pathname) {
  if (!isPlatformTokenAllowed(method, pathname)) {
    return null;
  }
  const claims = verifyPlatformUserToken(bearerToken(req));
  if (!claims) {
    return null;
  }
  return loadUserById(pool, claims.sub);
}

module.exports = {
  isPlatformTokenAllowed,
  bearerToken,
  loadUserById,
  tryPlatformUser,
};
