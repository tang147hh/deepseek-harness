"use strict";

const http = require("node:http");
const { Pool } = require("pg");
const { handlePagesRequest } = require("./serve");
const { attachRequestLog, logError, pathOnly } = require("./log");

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const host = process.env.HOST ?? "0.0.0.0";
const snapshotsRoot = process.env.SNAPSHOTS_ROOT ?? "/data/snapshots";
const pagesParent = process.env.PAGES_PARENT ?? "pages.localhost";
const pagesHost = process.env.PAGES_HOST ?? pagesParent;

// Postgres for public site KV (plate H). Same dsh role is OK for phase 1.
// Do not inject SESSION_SECRET — write tokens are sha256(token), not sessions.
const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? "postgres",
  port: Number.parseInt(process.env.POSTGRES_PORT ?? "5432", 10),
  user: process.env.POSTGRES_USER ?? "dsh",
  password: process.env.POSTGRES_PASSWORD ?? "dsh",
  database: process.env.POSTGRES_DB ?? "dsh",
  max: 10,
});

const server = http.createServer((req, res) => {
  attachRequestLog(req, res, { svc: "pages" });
  handlePagesRequest(req, res, { snapshotsRoot, pagesParent, pagesHost, pool }).catch((err) => {
    logError(err, { svc: "pages", method: req.method, path: pathOnly(req.url) });
    if (!res.headersSent) {
      res.writeHead(500, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "x-content-origin": "user-generated",
      });
      res.end("internal\n");
    } else {
      res.destroy();
    }
  });
});

server.listen(port, host, () => {
  process.stdout.write(`pages listening on ${host}:${port}\n`);
});

function shutdown(signal) {
  process.stdout.write(`pages received ${signal}, shutting down\n`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
