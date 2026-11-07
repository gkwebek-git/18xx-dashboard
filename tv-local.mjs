// Helyi TV nézet: saját kis szerver + saját kiolvasó, semmi sem megy külső szolgáltatáson át.
//   node tv-local.mjs 272021
//   node tv-local.mjs https://18xx.games/game/272021
// Megnyitja a böngészőben: http://localhost:3009/tv.html?game=ID&local=1
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn, exec } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "public");
const args = process.argv.slice(2);
const PORT = Number(process.env.PORT || 3009);

let raw = args.find((a) => !a.startsWith("--"));
if (!raw) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  raw = await rl.question("Játék linkje vagy azonosítója (pl. https://18xx.games/game/272021): ");
  rl.close();
}
const id = (String(raw).match(/(\d{3,})\s*$/) || String(raw).match(/game\/(\d+)/) || [])[1];
if (!id) { console.error("Nem találok játékazonosítót a megadott szövegben."); process.exit(1); }

// ---- szerver a public mappához ----
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  if (p === "/tv") p = "/tv.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end("nincs");
  res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(f).pipe(res);
});
server.on("error", (e) => { if (e.code !== "EADDRINUSE") throw e; console.log(`A ${PORT}-es port már foglalt, a már futó helyi szervert használom.`); });
server.listen(PORT, () => console.log(`Szerver: http://localhost:${PORT}`));

// ---- élő figyelő: egy nyitva tartott láthatatlan lap, ami az 18xx.games saját élő csatornáját hallgatja ----
const dataDir = path.join(root, "data");
const scraper = spawn(process.execPath, [path.join(here, "live-local.mjs"), id, `--out=${dataDir}`], { cwd: here, stdio: "inherit" });
const quit = () => { try { scraper.kill(); } catch {} process.exit(0); };
process.on("SIGINT", quit); process.on("SIGTERM", quit);
scraper.on("exit", (c) => { console.log(`A kiolvasó leállt (${c}).`); process.exit(c ?? 0); });

// ---- böngésző megnyitása, ha már van adat ----
const url = `http://localhost:${PORT}/tv.html?game=${id}&local=1`;
const t0 = Date.now();
const wait = setInterval(() => {
  if (fs.existsSync(path.join(dataDir, `${id}.view.json`)) || Date.now() - t0 > 120000) {
    clearInterval(wait);
    console.log(`Megnyitás: ${url}\nLeállítás: Ctrl+C`);
    exec(`start "" "${url}"`);
  }
}, 1000);
