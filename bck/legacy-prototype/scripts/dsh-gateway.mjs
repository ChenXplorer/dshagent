#!/usr/bin/env node
/**
 * Preview gateway: DSH's browser auth is a one-shot ?token= cookie bound to
 * loopback Host. The in-browser preview cannot complete that dance, so this
 * process exchanges the launch token server-side and attaches the session
 * cookie to every upstream hop.
 *
 * Also shortens DSH's 2.5k `/plugins/??…` combo URLs — those 414/timeout in
 * the mobile preview iframe and leave a white screen.
 */
import http from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const LISTEN_HOST = "0.0.0.0";
const LISTEN_PORT = Number(process.env.DSH_GATEWAY_PORT || 8080);
const UPSTREAM_HOST = process.env.DSH_UPSTREAM_HOST || "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.DSH_UPSTREAM_PORT || 3080);
const TOKEN_FILE = process.env.DSH_TOKEN_FILE || "/tmp/dsh-web.token";
const COOKIE_FILE = process.env.DSH_COOKIE_FILE || "/tmp/dsh-web.cookie";
const LOG_FILE = process.env.DSH_LOG_FILE || "/tmp/dsh-web.log";
const UPSTREAM_AUTHORITY = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;

let sessionCookie = loadCookie();
const pluginAliases = new Map();
const pluginCache = new Map();

function isBenignNetError(error) {
  const code = error && typeof error === "object" ? error.code : "";
  return code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED" || code === "ECONNREFUSED" || code === "ETIMEDOUT";
}

function swallow(error) {
  if (!isBenignNetError(error)) process.stderr.write(`dsh-gateway: ${error?.stack || error}\n`);
}

process.on("uncaughtException", (error) => {
  if (isBenignNetError(error)) return;
  process.stderr.write(`dsh-gateway fatal: ${error?.stack || error}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  if (isBenignNetError(error)) return;
  process.stderr.write(`dsh-gateway rejection: ${error}\n`);
});

function loadCookie() {
  if (!existsSync(COOKIE_FILE)) return "";
  return readFileSync(COOKIE_FILE, "utf8").trim();
}

function saveCookie(cookie) {
  sessionCookie = cookie;
  try {
    writeFileSync(COOKIE_FILE, cookie, { mode: 0o600 });
  } catch (error) {
    swallow(error);
  }
}

function launchToken() {
  const fromFile = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "";
  if (fromFile) return fromFile;
  if (!existsSync(LOG_FILE)) return "";
  const match = readFileSync(LOG_FILE, "utf8").match(/[?&]token=([A-Za-z0-9._~-]+)/);
  return match?.[1] ?? "";
}

function parseSetCookie(headerValue) {
  const first = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!first) return "";
  return String(first).split(";")[0].trim();
}

function requestUpstream(path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path,
        method: "GET",
        headers: { host: UPSTREAM_AUTHORITY, accept: "text/html", ...extraHeaders },
      },
      (incoming) => {
        incoming.resume();
        incoming.on("error", swallow);
        resolve(incoming);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function cookieFrom(incoming) {
  return parseSetCookie(incoming.headers["set-cookie"]);
}

async function cookieWorks(cookie) {
  if (!cookie) return false;
  const incoming = await requestUpstream("/", { cookie });
  return incoming.statusCode === 200;
}

async function exchangeToken() {
  if (sessionCookie && (await cookieWorks(sessionCookie))) return sessionCookie;
  const stored = loadCookie();
  if (stored && stored !== sessionCookie && (await cookieWorks(stored))) {
    saveCookie(stored);
    return stored;
  }
  const token = launchToken();
  if (!token) throw new Error("missing DSH launch token");
  const incoming = await requestUpstream(`/?token=${encodeURIComponent(token)}`);
  const cookie = cookieFrom(incoming);
  if ((incoming.statusCode === 303 || incoming.statusCode === 302) && cookie) {
    saveCookie(cookie);
    return cookie;
  }
  if (incoming.statusCode === 401 && stored && (await cookieWorks(stored))) {
    saveCookie(stored);
    return stored;
  }
  throw new Error(`token exchange ${incoming.statusCode}`);
}

async function ensureCookie() {
  if (sessionCookie) return sessionCookie;
  return exchangeToken();
}

function upstreamHeaders(req) {
  const headers = { ...req.headers, host: UPSTREAM_AUTHORITY };
  delete headers["origin"];
  delete headers["referer"];
  delete headers["referrer"];
  delete headers["sec-fetch-site"];
  delete headers["sec-fetch-mode"];
  delete headers["sec-fetch-dest"];
  delete headers["forwarded"];
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  if (sessionCookie) {
    const current = typeof headers.cookie === "string" ? headers.cookie : "";
    headers.cookie = current.includes(sessionCookie)
      ? current
      : current
        ? `${current}; ${sessionCookie}`
        : sessionCookie;
  }
  return headers;
}

function rewriteCookies(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((value) => {
    let next = String(value)
      .replace(/SameSite=Strict/gi, "SameSite=None")
      .replace(/SameSite=Lax/gi, "SameSite=None");
    if (!/SameSite=/i.test(next)) next += "; SameSite=None";
    if (!/;\s*Secure/i.test(next)) next += "; Secure";
    return next;
  });
}

const OWNS_HOST_SCRIPT =
  "<script>globalThis.__DSH_TRANSPORT__=Object.assign(globalThis.__DSH_TRANSPORT__||{},{ownsHost:true});</script>";

const BOOT_STYLE = `<style id="dsh-preview-boot">html,body,#root{background:#111318;color:#f3f4f6;min-height:100%;margin:0}#dsh-preview-fallback{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;background:#111318;color:#e5e7eb}#dsh-preview-fallback[data-done]{display:none}</style>`;

const BOOT_MARKUP = `<div id="dsh-preview-fallback">正在加载 DeepSeek Harness…</div><script>(function(){var f=document.getElementById("dsh-preview-fallback");function hide(){if(f)f.setAttribute("data-done","1");}function ready(){var r=document.getElementById("root");return r&&r.childElementCount>0;}if(ready()){hide();return;}var obs=new MutationObserver(function(){if(ready()){hide();obs.disconnect();}});obs.observe(document.documentElement,{childList:true,subtree:true});setTimeout(function(){obs.disconnect();if(ready())hide();else if(f)f.textContent="页面脚本没起来，请再刷新一次。";},15000);})();</script>`;

function aliasForPluginUrl(raw) {
  const url = raw.replaceAll("&", "&");
  const digest = createHash("sha1").update(url).digest("hex").slice(0, 16);
  const alias = `/__dsh/boot/${digest}.js`;
  pluginAliases.set(alias, url);
  return alias;
}

function shortenPluginUrls(html) {
  return html.replace(/\/plugins\/\?\?[^"'<\s]+/g, (match) => {
    const plain = match.replaceAll("&", "&");
    return plain.length > 180 ? aliasForPluginUrl(match) : match;
  });
}

function injectOwnsHost(html) {
  let next = html;
  if (!next.includes("ownsHost:true")) {
    if (next.includes("__DSH_TRANSPORT__")) {
      next = next.replace(
        /globalThis\.__DSH_TRANSPORT__\s*=\s*\{[^}]*\}/,
        "globalThis.__DSH_TRANSPORT__={ownsHost:true}",
      );
    }
    next = next.replace(/<head([^>]*)>/i, `<head$1>${OWNS_HOST_SCRIPT}`);
  }
  if (!next.includes("id=\"dsh-preview-boot\"")) {
    next = next.replace(/<head([^>]*)>/i, `<head$1>${BOOT_STYLE}`);
  }
  if (!next.includes("id=\"dsh-preview-fallback\"")) {
    next = next.replace(/<body([^>]*)>/i, `<body$1>${BOOT_MARKUP}`);
  }
  return shortenPluginUrls(next);
}

function fetchUpstreamBuffer(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path,
        method: "GET",
        headers: upstreamHeaders({ headers: { accept: "*/*" } }),
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 502,
            contentType: String(incoming.headers["content-type"] || "text/javascript; charset=utf-8"),
            body: Buffer.concat(chunks),
          });
        });
        incoming.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function servePluginAlias(req, res) {
  const path = req.url.split("?")[0];
  const original = pluginAliases.get(path);
  if (!original) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("unknown plugin alias");
    return;
  }
  let cached = pluginCache.get(path);
  if (!cached) {
    cached = await fetchUpstreamBuffer(original);
    if (cached.status === 200) pluginCache.set(path, cached);
  }
  res.writeHead(cached.status, {
    "content-type": cached.contentType,
    "content-length": cached.body.length,
    "cache-control": "public, max-age=60",
  });
  res.end(cached.body);
}

function proxy(req, res, retried) {
  req.on("error", swallow);
  res.on("error", swallow);
  const path = (req.url || "/").split("?")[0];
  if (pluginAliases.has(path)) {
    void servePluginAlias(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`DSH gateway: ${error.message}`);
      }
    });
    return;
  }
  const upstream = http.request(
    {
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      headers: upstreamHeaders(req),
    },
    (incoming) => {
      incoming.on("error", swallow);
      if (incoming.statusCode === 401 && !retried) {
        incoming.resume();
        sessionCookie = "";
        void exchangeToken()
          .then(() => proxy(req, res, true))
          .catch((error) => {
            if (!res.headersSent) {
              res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
              res.end(`DSH gateway: ${error.message}`);
            }
          });
        return;
      }
      const headers = { ...incoming.headers };
      delete headers["transfer-encoding"];
      delete headers["connection"];
      delete headers["content-security-policy"];
      delete headers["x-frame-options"];
      if (headers["set-cookie"]) headers["set-cookie"] = rewriteCookies(headers["set-cookie"]);
      else if (sessionCookie) {
        headers["set-cookie"] = rewriteCookies([
          `${sessionCookie}; Path=/; HttpOnly; SameSite=None; Max-Age=2592000`,
        ]);
      }
      const contentType = String(headers["content-type"] || "");
      const encoded = String(headers["content-encoding"] || "");
      const html =
        incoming.statusCode === 200 &&
        contentType.includes("text/html") &&
        !encoded.includes("gzip") &&
        !encoded.includes("br");
      if (!html) {
        res.writeHead(incoming.statusCode ?? 502, headers);
        incoming.pipe(res);
        return;
      }
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = injectOwnsHost(Buffer.concat(chunks).toString("utf8"));
        delete headers["content-length"];
        delete headers["content-encoding"];
        headers["content-length"] = Buffer.byteLength(body);
        res.writeHead(incoming.statusCode ?? 502, headers);
        res.end(body);
      });
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`DSH gateway: ${error.message}`);
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  void ensureCookie()
    .catch(() => "")
    .then(() => proxy(req, res, false));
});

server.on("clientError", (error, socket) => {
  swallow(error);
  socket.destroy();
});

server.on("upgrade", (req, socket, head) => {
  socket.on("error", swallow);
  void ensureCookie()
    .catch(() => "")
    .then(() => {
      const upstream = http.request({
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: req.url,
        method: req.method,
        headers: upstreamHeaders(req),
      });
      upstream.on("upgrade", (incoming, upstreamSocket) => {
        upstreamSocket.on("error", swallow);
        try {
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(incoming.headers)
              .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
              .join("\r\n")}\r\n\r\n`,
          );
        } catch (error) {
          swallow(error);
          upstreamSocket.destroy();
          socket.destroy();
          return;
        }
        if (head?.length) upstreamSocket.write(head);
        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      upstream.end();
    });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  process.stdout.write(`dsh-gateway listening ${LISTEN_HOST}:${LISTEN_PORT} → ${UPSTREAM_AUTHORITY}\n`);
  void ensureCookie().catch((error) => {
    process.stderr.write(`dsh-gateway token exchange deferred: ${error.message}\n`);
  });
});
