// Egyszerű helyi szerver a public mappához: node dev.mjs  ->  http://localhost:3009
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve("public");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json" };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) return res.writeHead(404).end("nincs");
  res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(f).pipe(res);
}).listen(3009, () => console.log("http://localhost:3009"));
