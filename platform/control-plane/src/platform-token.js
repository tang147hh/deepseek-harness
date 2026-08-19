"use strict";

const { createHmac, timingSafeEqual } = require("node:crypto");

/** Prefix so a platform user token cannot be mistaken for a session or KV write token. */
const PREFIX = "dshput.v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TTL = 12 * 60 * 60;

function platformTokenSecret() {
  return String(process.env.PLATFORM_TOKEN_SECRET ?? "").trim();
}

function platformTokenTtlSeconds() {
  const n = Number.parseInt(process.env.PLATFORM_TOKEN_TTL_SECONDS ?? String(DEFAULT_TTL), 10);
  if (!Number.isFinite(n) || n < 60) {
    return DEFAULT_TTL;
  }
  return n;
}

function hmacSig(bodyB64, secret) {
  return createHmac("sha256", secret).update(`${PREFIX}.${bodyB64}`).digest("base64url");
}

function hmacEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function signPlatformUserToken(userId, { now = Math.floor(Date.now() / 1000), ttlSeconds } = {}) {
  const secret = platformTokenSecret();
  if (!secret) {
    const err = new Error("platform_token_secret_missing");
    err.status = 500;
    err.code = "platform_token_secret_missing";
    throw err;
  }
  const id = String(userId ?? "").trim();
  if (!UUID_RE.test(id)) {
    const err = new Error("invalid_user_id");
    err.status = 400;
    err.code = "invalid_user_id";
    throw err;
  }
  const ttl = ttlSeconds == null ? platformTokenTtlSeconds() : ttlSeconds;
  const iat = now;
  const exp = now + ttl;
  const body = Buffer.from(JSON.stringify({ v: 1, sub: id, iat, exp }), "utf8").toString("base64url");
  return `${PREFIX}.${body}.${hmacSig(body, secret)}`;
}

function verifyPlatformUserToken(token, { now = Math.floor(Date.now() / 1000) } = {}) {
  const secret = platformTokenSecret();
  if (!secret) {
    return null;
  }
  const raw = String(token ?? "").trim();
  const parts = raw.split(".");
  if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== PREFIX) {
    return null;
  }
  const body = parts[2];
  const sig = parts[3];
  if (!body || !sig) {
    return null;
  }
  let expected;
  try {
    expected = hmacSig(body, secret);
  } catch {
    return null;
  }
  if (!hmacEqual(sig, expected)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || !UUID_RE.test(String(payload.sub ?? ""))) {
    return null;
  }
  const exp = Number(payload.exp);
  const iat = Number(payload.iat);
  if (!Number.isFinite(exp) || exp < now) {
    return null;
  }
  if (Number.isFinite(iat) && iat > now + 60) {
    return null;
  }
  return { sub: String(payload.sub), exp, iat };
}

function warnIfNoPlatformTokenSecret() {
  if (!platformTokenSecret()) {
    process.stderr.write(
      "warning: PLATFORM_TOKEN_SECRET is empty; Agent Bearer publish will 401 until it is set\n",
    );
  }
  const session = String(process.env.SESSION_SECRET ?? "").trim();
  if (session && platformTokenSecret() && session === platformTokenSecret()) {
    process.stderr.write(
      "warning: PLATFORM_TOKEN_SECRET must not equal SESSION_SECRET; issue a distinct HMAC secret\n",
    );
  }
}

module.exports = {
  PREFIX,
  UUID_RE,
  DEFAULT_TTL,
  platformTokenSecret,
  platformTokenTtlSeconds,
  signPlatformUserToken,
  verifyPlatformUserToken,
  warnIfNoPlatformTokenSecret,
};
