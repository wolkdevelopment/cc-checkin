/* Local preview: `npm run dev`, then open http://localhost:8888/admin
   Data is kept in memory and vanishes when you stop the server.
   ADMIN_KEY defaults to "local-admin-key". Camera scanning needs https or localhost. */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createMemoryBlobs } from "./memory-blobs.mjs";
import { handle, netlifyStore } from "../netlify/lib/core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const PORT = Number(process.env.PORT || 8888);
const env = { ...process.env, ADMIN_KEY: process.env.ADMIN_KEY || "local-admin-key" };
const store = netlifyStore(createMemoryBlobs().getStore);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json" };
// The same page-route rewrites and security headers as netlify.toml.
const PAGES = new Set(["/admin", "/me", "/door", "/board", "/join"]);
const toml = await readFile(path.join(root, "..", "netlify.toml"), "utf8");
const HEADERS = {};
for (const m of toml.matchAll(/^\s*([A-Za-z-]+) = "([^"]*)"\s*$/gm)) if (/^(X-|Referrer|Permissions|Content-Security)/.test(m[1])) HEADERS[m[1].toLowerCase()] = m[2];

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const hasBody = !["GET", "HEAD"].includes(req.method);
      const request = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: "half" });
      const ip = req.headers["x-test-ip"] || req.socket.remoteAddress;
      const response = await handle(request, { ip }, { store, env });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    let pathname = url.pathname.replace(/\/+$/, "") || "/";
    if (PAGES.has(pathname) || pathname === "/") pathname = "/index.html";
    const file = path.normalize(path.join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { ...HEADERS, "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch (e) {
    const missing = e && (e.code === "ENOENT" || e.code === "EISDIR");
    res.writeHead(missing ? 404 : 500, { "content-type": "text/plain; charset=utf-8" }).end(missing ? "Not found" : "Server error");
    if (!missing) console.error(e);
  }
}).listen(PORT, () => console.log("Check-in running at http://localhost:" + PORT + "/admin  (admin key: " + (process.env.ADMIN_KEY ? "from ADMIN_KEY" : "local-admin-key") + ")"));
