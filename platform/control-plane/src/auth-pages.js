"use strict";

const fsSync = require("node:fs");
const path = require("node:path");
const {
  normalizePath,
  clearSessionCookie,
  sendHtml,
  sendJson,
  sendRedirect,
} = require("./http");

const LOGIN_HTML = fsSync.readFileSync(path.join(__dirname, "login-page.html"), "utf8");
const REGISTER_HTML = fsSync.readFileSync(path.join(__dirname, "register-page.html"), "utf8");

function wantsJson(req) {
  const accept = String(req.headers?.accept ?? req.headers?.Accept ?? "").toLowerCase();
  return accept.includes("json");
}

function isPublic(method, pathname) {
  if (method === "GET" && pathname === "/healthz") {
    return true;
  }
  if (method === "GET" && (pathname === "/auth/login" || pathname === "/auth/register" || pathname === "/auth/logout")) {
    return true;
  }
  if (method === "POST" && (pathname === "/auth/login" || pathname === "/auth/register")) {
    return true;
  }
  return false;
}

function sendUnauthenticated(req, res, pathname) {
  if ((req.method ?? "GET") === "GET" && pathname === "/") {
    if (wantsJson(req)) {
      sendJson(res, 401, { error: "unauthenticated" });
      return;
    }
    sendRedirect(res, "/auth/login");
    return;
  }
  sendJson(res, 401, { error: "unauthenticated" });
}

function sendLogoutRedirect(res) {
  sendRedirect(res, "/auth/login", { "set-cookie": clearSessionCookie() });
}

/** GET login/register HTML. Logged-in → 302 /. POST is not handled (JSON API stays). */
function handleAuthGetPages(req, res, session) {
  const method = req.method ?? "GET";
  const pathname = normalizePath(req.url);
  if (method !== "GET") {
    return false;
  }
  if (pathname !== "/auth/login" && pathname !== "/auth/register") {
    return false;
  }
  if (session && session.user) {
    sendRedirect(res, "/");
    return true;
  }
  sendHtml(res, 200, pathname === "/auth/login" ? LOGIN_HTML : REGISTER_HTML);
  return true;
}

module.exports = {
  LOGIN_HTML,
  REGISTER_HTML,
  wantsJson,
  isPublic,
  sendUnauthenticated,
  sendLogoutRedirect,
  handleAuthGetPages,
};
