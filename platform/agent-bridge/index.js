/**
 * Platform Cordis plugin: register model tool `publish_site`.
 * Calls control-plane POST /sites/publish with PLATFORM_USER_TOKEN.
 * Does not occupy /api (dsh keeps that). Does not use KV write tokens.
 */

import { readFile } from "node:fs/promises";

export const name = "platform-publish-site";
export const inject = ["tools"];

const TOKEN_FILE = ".platform-token";
const DEFAULT_PLATFORM_URL = "http://control-plane:8080";

const DESCRIPTION = [
  "Request approval to publish the current user's workspace/sites/<name> directory as a public static site snapshot.",
  "Writing or creating a website is not permission to publish it: finish the files, then call this tool exactly once so its approval card is the only question asking whether to publish.",
  "Do not ask about publishing in prose or with ask_user_question before calling this tool; that would create two confirmation steps.",
  "If the user already explicitly asked to publish or go live, call this tool directly, but publication still requires the user to approve its card.",
  "dir must be a workspace-relative path under sites/ (one segment, e.g. sites/demo) with index.html;",
  "forbidden files such as .env and *.pem are rejected by the control plane.",
  "Do not use this for files, KV writes, or any path outside sites/.",
].join(" ");

function joinHome(home, name) {
  const root = String(home).replace(/[\\/]+$/, "");
  return `${root}/${name}`;
}

export function parsePublishDir(raw) {
  if (raw == null) {
    throw new Error("invalid_path: dir is required");
  }
  const s = String(raw).trim();
  if (s === "" || s === ".") {
    throw new Error("invalid_path: dir must be sites/<name>");
  }
  if (s.includes("\0") || s.includes("\\") || s.includes("://")) {
    throw new Error("invalid_path");
  }
  if (/^[a-zA-Z]:/.test(s) || s.startsWith("/") || s.startsWith("\\")) {
    throw new Error("invalid_path");
  }
  const out = [];
  for (const part of s.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === ".." || part.includes("\0")) {
      throw new Error("invalid_path");
    }
    out.push(part);
  }
  const rel = out.join("/");
  if (!rel.startsWith("sites/") || rel === "sites") {
    throw new Error("invalid_path: dir must be sites/<name>");
  }
  const rest = rel.slice("sites/".length);
  if (!rest || rest.includes("/")) {
    throw new Error("invalid_path: dir must be sites/<name> (one segment)");
  }
  return { rel, name: rest };
}

export function platformUrlFromEnv(env = process.env) {
  const raw = String(env.PLATFORM_URL ?? DEFAULT_PLATFORM_URL).trim();
  return raw.replace(/\/+$/, "") || DEFAULT_PLATFORM_URL;
}

export async function readPlatformToken(homeDir, env = process.env, fsReadFile = readFile) {
  const home = String(homeDir || env.DSH_HOME || env.HOME || "/data/home");
  try {
    const fromFile = String(await fsReadFile(joinHome(home, TOKEN_FILE), "utf8") || "").trim();
    if (fromFile) {
      return fromFile;
    }
  } catch {
    // fall through to env
  }
  return String(env.PLATFORM_TOKEN ?? "").trim();
}

export async function callPublishSite({
  dir,
  slug,
  token,
  platformUrl,
  fetchImpl,
  signal,
}) {
  const { rel } = parsePublishDir(dir);
  const tok = String(token ?? "").trim();
  if (!tok) {
    throw new Error(
      "publish_site: no PLATFORM_USER_TOKEN (expected $DSH_HOME/.platform-token or PLATFORM_TOKEN). Re-open the app so ensure can mint one.",
    );
  }
  const base = String(platformUrl || DEFAULT_PLATFORM_URL).replace(/\/+$/, "");
  const url = `${base}/sites/publish`;
  const body = { dir: rel };
  if (slug != null && String(slug).trim() !== "") {
    body.slug = String(slug).trim();
  }
  const fetchFn = fetchImpl || fetch;
  let res;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tok}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new Error(`publish_site: control-plane unreachable: ${err && err.message ? err.message : err}`);
  }
  const text = await res.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: "bad_response", raw: text.slice(0, 200) };
    }
  }
  if (res.status === 401) {
    throw new Error(
      "publish_site: 401 unauthenticated (platform token missing, expired, or not accepted). KV writeToken cannot publish. Re-open the app to refresh the token.",
    );
  }
  if (!res.ok) {
    const code = json.error || `http_${res.status}`;
    throw new Error(`publish_site: ${code}`);
  }
  return json;
}

export function formatPublishResult(json) {
  const lines = [];
  if (json.url) {
    lines.push(`Published: ${json.url}`);
  }
  if (json.slug) {
    lines.push(`slug: ${json.slug}`);
  }
  if (json.version != null) {
    lines.push(`version: ${json.version}`);
  }
  if (json.writeToken) {
    lines.push(
      `writeToken (shown once; store it to PUT /v1/kv on the site host): ${json.writeToken}`,
    );
  }
  return lines.join("\n") || JSON.stringify(json);
}

export function buildApprovalReason(dir, slug) {
  const { rel, name } = parsePublishDir(dir);
  const requestedSlug = String(slug ?? "").trim();
  const publicSlug = requestedSlug || `{username}-${name}`;
  return `发布到公网：将 ${rel} 创建为静态站快照。允许后公网地址形如 https://${publicSlug}.{PAGES_PARENT}/。`;
}

function toOutput(json) {
  const out = {
    ok: Boolean(json.ok),
    url: String(json.url || ""),
  };
  if (json.slug) out.slug = String(json.slug);
  if (json.siteId) out.siteId = String(json.siteId);
  if (Number.isInteger(json.version)) out.version = json.version;
  if (json.status) out.status = String(json.status);
  if (Number.isInteger(json.bytes)) out.bytes = json.bytes;
  if (json.hasWriteToken != null) out.hasWriteToken = Boolean(json.hasWriteToken);
  if (json.writeToken) out.writeToken = String(json.writeToken);
  if (!out.url) {
    throw new Error("publish_site: control-plane response missing url");
  }
  return out;
}

export function apply(ctx) {
  ctx.tools.register({
    name: "publish_site",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description: "Workspace-relative site directory, must be sites/<name> (one segment), e.g. sites/demo.",
        },
        slug: {
          type: "string",
          description: "Optional public slug. Default is {username}-{name}.",
        },
      },
      required: ["dir"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          url: { type: "string" },
          slug: { type: "string" },
          siteId: { type: "string" },
          version: { type: "integer" },
          status: { type: "string" },
          bytes: { type: "integer" },
          hasWriteToken: { type: "boolean" },
          writeToken: { type: "string" },
        },
        required: ["ok", "url"],
      },
      render(_args, value) {
        return [{ type: "text", text: formatPublishResult(value) }];
      },
    },
    timeoutMs: 120_000,
    presentCall(args) {
      return {
        card: "generic",
        title: "发布站点到公网",
        kind: "other",
        rawInput: args && args.dir ? args.dir : args,
      };
    },
    async execute(args, exec) {
      const dir = args && args.dir;
      parsePublishDir(dir);
      const approval = ctx.get("approval");
      if (!approval || typeof approval.request !== "function") {
        throw new Error("publish_site: approval service is required; publication was not approved");
      }
      if (!exec || !exec.agent) {
        throw new Error("publish_site: approval is composed; an owning agent session is required");
      }
      const outcome = await approval.request({
        agent: exec.agent,
        toolName: "publish_site",
        callId: exec.callId,
        reason: buildApprovalReason(dir, args && args.slug),
        signal: exec.signal,
      });
      if (outcome !== "allowed-once") {
        throw new Error(`publish_site: publication was not approved (${outcome})`);
      }
      const token = await readPlatformToken();
      const json = await callPublishSite({
        dir,
        slug: args && args.slug,
        token,
        platformUrl: platformUrlFromEnv(),
        signal: exec && exec.signal,
      });
      return toOutput(json);
    },
  });
}

export { DESCRIPTION, TOKEN_FILE, DEFAULT_PLATFORM_URL, toOutput };
