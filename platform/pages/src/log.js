"use strict";

/**
 * One JSON line per request / error. Never print secrets.
 * Keep this file in sync with control-plane/src/log.js and runtime-manager/src/log.js.
 */

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_RE =
  /^(password|passwd|pass|cookie|set-cookie|authorization|auth|session_secret|sessionsecret|session-secret|platform_token|platformtoken|platform-token|platform_token_secret|runtime_manager_token|writetoken|write_token|write-token|dns_api_token|dns-api-token|postgres_password|postgres-password|credentials|api_key|apikey|api-key)$/i;

const SECRET_ENV_KEYS = [
  "SESSION_SECRET",
  "PLATFORM_TOKEN",
  "PLATFORM_TOKEN_SECRET",
  "RUNTIME_MANAGER_TOKEN",
  "DNS_API_TOKEN",
  "POSTGRES_PASSWORD",
];

function pathOnly(url) {
  const path = String(url ?? "/").split("?")[0];
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path || "/";
}

function redactString(s) {
  let out = String(s);
  for (const envKey of SECRET_ENV_KEYS) {
    const v = process.env[envKey];
    if (typeof v === "string" && v.length >= 4) {
      out = out.split(v).join(REDACTED);
    }
  }
  out = out.replace(/(Authorization\s*[:=]\s*)([^\r\n]+)/gi, `$1${REDACTED}`);
  out = out.replace(/(Set-Cookie\s*[:=]\s*)([^\r\n]+)/gi, `$1${REDACTED}`);
  out = out.replace(/(Cookie\s*[:=]\s*)([^\r\n]+)/gi, `$1${REDACTED}`);
  out = out.replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`);
  out = out.replace(/dsh_session=[^;\s]*/gi, `dsh_session=${REDACTED}`);
  out = out.replace(/("writeToken"\s*:\s*")[^"]*"/gi, `$1${REDACTED}"`);
  out = out.replace(/(\.credentials\.yaml[^\r\n]*)/gi, ".credentials.yaml [REDACTED]");
  return out;
}

function redact(value, key) {
  if (value == null) {
    return value;
  }
  if (key && SENSITIVE_KEY_RE.test(String(key))) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, key));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return redactString(String(value));
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") {
      out[k] = v;
    }
  }
  return out;
}

function formatLogLine(record) {
  return JSON.stringify(redact(compact(record)));
}

function writeLog(record) {
  process.stdout.write(`${formatLogLine(record)}\n`);
}

function logError(err, extra = {}) {
  process.stderr.write(
    `${formatLogLine({
      ts: extra.ts || new Date().toISOString(),
      svc: extra.svc,
      level: "error",
      method: extra.method,
      path: extra.path,
      userId: extra.userId,
      err: err && (err.code || err.message || String(err)),
      stack: err && err.stack,
    })}\n`,
  );
}

/**
 * Access log on res finish. Does not copy Cookie / Authorization headers.
 * Skip GET /healthz (compose healthcheck noise).
 */
function attachRequestLog(req, res, ctx = {}) {
  const start = process.hrtime.bigint();
  const method = req.method ?? "GET";
  const path = pathOnly(req.url);
  if (method === "GET" && path === "/healthz") {
    return ctx;
  }
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    writeLog({
      ts: new Date().toISOString(),
      svc: ctx.svc,
      method,
      path,
      status: res.statusCode || 0,
      ms: Math.round(ms),
      userId: ctx.userId,
    });
  });
  return ctx;
}

module.exports = {
  REDACTED,
  redact,
  formatLogLine,
  writeLog,
  logError,
  attachRequestLog,
  pathOnly,
};
