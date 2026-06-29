#!/usr/bin/env node
// serve.mjs — zero-dependency static server for the SDLC visualizer.
// Usage: node serve.mjs [port]   (default 8000)  ->  http://localhost:8000/

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".mp3": "audio/mpeg",
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
    const info = await stat(filePath);
    if (info.isDirectory()) { res.writeHead(404); return res.end("not found"); }
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
                         "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

server.listen(PORT, () => console.log(`SDLC visualizer at http://localhost:${PORT}/  (root: ${ROOT})`));
