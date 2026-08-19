"use strict";

const { isFilesPath } = require("./files");
const { isSitesPath } = require("./sites");
const { isPluginsPath } = require("./plugins");

function isAuthPath(pathname) {
  return pathname === "/auth/login"
    || pathname === "/auth/register"
    || pathname === "/auth/logout"
    || pathname.startsWith("/auth/");
}

function isAdminPath(pathname) {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function isReservedControlPath(pathname) {
  return pathname === "/healthz"
    || pathname === "/me"
    || pathname === "/runtime/status"
    || isAuthPath(pathname)
    || isFilesPath(pathname)
    || isSitesPath(pathname)
    || isPluginsPath(pathname)
    || isAdminPath(pathname);
}

function isRuntimeAlias(pathname) {
  return pathname === "/runtime" || pathname.startsWith("/runtime/");
}

module.exports = {
  isAuthPath,
  isAdminPath,
  isReservedControlPath,
  isRuntimeAlias,
  isPluginsPath,
};
