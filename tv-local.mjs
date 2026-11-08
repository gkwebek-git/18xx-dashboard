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
import { controlClock, newClock } from "./clock.mjs";

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
  // játékidő-óra gombjai (Start / Szünet / Nullázás) – az óra állapota egy fájlban él
  if (req.method === "POST" && new URL(req.url, "http://x").pathname === "/api/custom") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(body);
        const cf = path.join(dataDir, `${id}.custom.json`);
        let cu = {}; try { cu = JSON.parse(fs.readFileSync(cf, "utf8")); } catch {}
        const player = String(b.player || "").slice(0, 60);
        const name = String(b.name || "").replace(/[<>]/g, "").trim().slice(0, 24);
        const color = /^#[0-9a-fA-F]{6}$/.test(String(b.color || "")) ? String(b.color) : "";
        if (!player) throw new Error("ismeretlen játékos");
        if (!name && !color) delete cu[player]; else cu[player] = { ...(name ? { name } : {}), ...(color ? { color } : {}) };
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(cf, JSON.stringify(cu));
        const sf = path.join(dataDir, `${id}.json`);
        try { const s = JSON.parse(fs.readFileSync(sf, "utf8")); s.custom = cu; fs.writeFileSync(sf, JSON.stringify(s)); } catch {}
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, custom: cu }));
      } catch (e) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e.message) })); }
    });
    return;
  }
  if (req.method === "POST" && new URL(req.url, "http://x").pathname === "/api/clock") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const action = JSON.parse(body).action;
        if (!["start", "pause", "reset"].includes(action)) throw new Error("ismeretlen művelet");
        const cf = path.join(dataDir, `${id}.clock.json`);
        let c = null; try { c = JSON.parse(fs.readFileSync(cf, "utf8")); } catch {}
        c = controlClock(c || newClock(), action);
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(cf, JSON.stringify(c));
        const sf = path.join(dataDir, `${id}.json`);
        try { const s = JSON.parse(fs.readFileSync(sf, "utf8")); s.clock = c; fs.writeFileSync(sf, JSON.stringify(s)); } catch {}
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, clock: c }));
      } catch (e) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e.message) })); }
    });
    return;
  }
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
    if (!process.env.NO_OPEN) exec(`start "" "${url}"`);
  }
}, 1000);
