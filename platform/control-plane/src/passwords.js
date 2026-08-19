"use strict";

const { randomBytes, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");

const scryptAsync = promisify(scrypt);

// scrypt parameters (OWASP-adjacent; native libuv, no plaintext/md5).
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_LEN = 16;

const DUMMY_HASH = [
  "scrypt",
  String(N),
  String(R),
  String(P),
  Buffer.alloc(SALT_LEN).toString("base64url"),
  Buffer.alloc(KEYLEN).toString("base64url"),
].join("$");

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

async function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const key = asBuffer(await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P }));
  return ["scrypt", String(N), String(R), String(P), salt.toString("base64url"), key.toString("base64url")].join("$");
}

async function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    await verifyPassword(password, DUMMY_HASH);
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  if (!Number.isInteger(n) || n < 2 || !salt.length || !expected.length) {
    return false;
  }
  const key = asBuffer(await scryptAsync(password, salt, expected.length, { N: n, r, p }));
  if (key.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(key, expected);
}

module.exports = {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
};
