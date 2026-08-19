"use strict";

const { timingSafeEqual } = require("node:crypto");

function normalizePath(url) {
  const path = String(url ?? "/").split("?")[0];
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path || "/";
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

function bearerToken(req) {
  const header = String(req.headers.authorization ?? "");
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return "";
  }
  return header.slice(prefix.length).trim();
}

function tokenOk(got, expected) {
  if (!expected || !got) {
    return false;
  }
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

module.exports = {
  normalizePath,
  sendText,
  sendJson,
  readJson,
  bearerToken,
  tokenOk,
};
