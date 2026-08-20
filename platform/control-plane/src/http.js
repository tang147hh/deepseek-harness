"use strict";

const COOKIE_NAME = "dsh_session";

function normalizePath(url) {
  const path = String(url ?? "/").split("?")[0];
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path || "/";
}

function parseQuery(url) {
  const raw = String(url ?? "");
  const i = raw.indexOf("?");
  if (i === -1) {
    return new URLSearchParams();
  }
  return new URLSearchParams(raw.slice(i + 1));
}

function bearerToken(req) {
  const header = String(req.headers?.authorization ?? req.headers?.Authorization ?? "");
  const match = header.match(/^Bearer\s+(\S+)/i);
  return match ? match[1].trim() : "";
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = Object.create(null);
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function cookieDomain() {
  // Host-only (omit Domain): works for whatever host the browser used
  // (e.g. www.996-code.com). Never a parent like .example.com, or cookies
  // leak onto *.pages. An explicit Domain=APP_HOST fails if .env APP_HOST
  // does not match the public hostname.
  return "";
}

function serializeCookie(name, value, extras) {
  const parts = [`${name}=${value}`];
  const domain = extras.domain ?? cookieDomain();
  if (domain) {
    parts.push(`Domain=${domain}`);
  }
  parts.push(`Path=${extras.path ?? "/"}`);
  if (extras.maxAge !== undefined) {
    parts.push(`Max-Age=${extras.maxAge}`);
  }
  if (extras.httpOnly) {
    parts.push("HttpOnly");
  }
  if (extras.secure) {
    parts.push("Secure");
  }
  if (extras.sameSite) {
    parts.push(`SameSite=${extras.sameSite}`);
  }
  return parts.join("; ");
}

function sessionCookie(token, maxAge) {
  return serializeCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
}

function clearSessionCookie() {
  return serializeCookie(COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
  });
}

function send(res, status, headers, body) {
  const outHeaders = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  };
  res.writeHead(status, outHeaders);
  res.end(body);
}

function sendText(res, status, text) {
  send(res, status, { "content-type": "text/plain; charset=utf-8" }, text);
}

function sendHtml(res, status, html) {
  send(res, status, { "content-type": "text/html; charset=utf-8" }, html);
}

function sendRedirect(res, location, extraHeaders = {}) {
  send(res, 302, { location, ...extraHeaders }, "");
}

function sendJson(res, status, obj, extraHeaders = {}) {
  send(
    res,
    status,
    { "content-type": "application/json; charset=utf-8", ...extraHeaders },
    `${JSON.stringify(obj)}\n`,
  );
}

function readJson(req, { maxBytes = 16 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;

    const fail = (err) => {
      if (done) {
        return;
      }
      done = true;
      reject(err);
    };

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error("payload_too_large");
        err.status = 413;
        err.code = "payload_too_large";
        fail(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) {
        return;
      }
      done = true;
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          const err = new Error("invalid_json");
          err.status = 400;
          err.code = "invalid_json";
          reject(err);
          return;
        }
        resolve(parsed);
      } catch {
        const err = new Error("invalid_json");
        err.status = 400;
        err.code = "invalid_json";
        reject(err);
      }
    });
    req.on("error", fail);
  });
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    created_at: row.created_at,
  };
}

module.exports = {
  COOKIE_NAME,
  normalizePath,
  parseQuery,
  parseCookies,
  bearerToken,
  sessionCookie,
  clearSessionCookie,
  sendText,
  sendHtml,
  sendRedirect,
  sendJson,
  readJson,
  publicUser,
};
