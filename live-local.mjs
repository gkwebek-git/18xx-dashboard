// Helyi, valós idejű figyelő: egyetlen (láthatatlan) böngészőlap nyitva van a játékon, pont úgy, mint egy
// átlagos nézőnél. Az oldal maga kapja a lépéseket az 18xx.games saját élő csatornáján, így nincs
// folyamatos lekérdezés – csak akkor olvasunk ki, ha tényleg változott valami.
//
//   node live-local.mjs 272021 [--out=public/data]                     (helyi: fájlokba ír)
//   node live-local.mjs 272021 --post=https://.../api/ingest          (GitHub Actions: a hubnak küldi; INGEST_TOKEN kell)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { collect } from "./collect.mjs";
import { advanceClock } from "./clock.mjs";

process.env.TAB_SLEEP ??= "100";
const args = process.argv.slice(2);
const id = args.find((a) => /^\d+$/.test(a));
const outDir = (args.find((a) => a.startsWith("--out=")) || "--out=public/data").split("=")[1];
const postUrl = (args.find((a) => a.startsWith("--post=")) || "--post=").slice(7);
const token = process.env.INGEST_TOKEN ?? "";
const maxMs = Number((args.find((a) => a.startsWith("--max-minutes=")) || "--max-minutes=0").split("=")[1]) * 60_000;
const startedAt = Date.now();
if (!id) { console.error("Használat: node live-local.mjs <játék-azonosító> [--out=mappa | --post=URL]"); process.exit(1); }

const candidates = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));
if (!executablePath) { console.error("Nem találok Chrome/Edge böngészőt. Állítsd be a CHROME_PATH változót."); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString("hu-HU"), `[${id}]`, ...a);
const UA = "xx18-dashboard/1.0 (+https://github.com/gkwebek-git/18xx-dashboard)";

async function api() {
  const r = await fetch(`https://18xx.games/api/game/${id}`, { headers: { accept: "application/json", "user-agent": UA } });
  if (!r.ok) throw new Error(`API hiba: ${r.status}`);
  return r.json();
}
async function post(body) {
  const r = await fetch(postUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  if (r.status === 404 || r.status === 401) { log(`a hub elutasította (${r.status}), leállás`); await quit(); }
  if (!r.ok) throw new Error(`Küldési hiba: ${r.status}`);
  const j = await r.json().catch(() => ({}));
  if (j.stop) { log("nincs néző, leállás"); await quit(); }
}function writeAtomic(name, data) {
  const f = path.join(outDir, name), tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, f);
}

let quitting = false;
async function quit() { quitting = true; try { await browser.close(); } catch {} process.exit(0); }
const browser = await puppeteer.launch({ executablePath, headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
let busy = false, dirty = false, lastSig = "", lastCount = -1, timer = null;

// Az oldal "jele": az állapotsor + a napló utolsó sorai a Game fülön. Ha ez változik, volt lépés.
async function signature() {
  return page.evaluate(() => {
    const a = [...document.querySelectorAll("#game_menu a")].find((e) => e.textContent.trim() === "Game");
    if (a && !document.getElementById("chatlog")) a.click();
    const g = document.querySelector(".game") || document.body;
    const status = (g.innerText.match(/^.*\bPhase\s.*$/m) || [""])[0].trim();
    const lines = (document.getElementById("chatlog")?.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean).slice(-4);
    return status + "|" + lines.join("|");
  }).catch(() => "");
}

async function refresh(reason) {
  if (busy) { dirty = true; return; }
  busy = true;
  try {
    do {
      dirty = false;
      const t0 = Date.now();
      const gp = api(); // az API-kérés párhuzamosan fut a kiolvasással
      gp.catch(() => {});
      const { out, view, players } = await collect(page, id, gp);
      const rev = Date.now();
      out.vrev = rev;
      if (postUrl) await post({ id, data: out, view, live: true }); // az órát a hub vezeti
      else {
        // helyi mód: az óra állapota egy fájlban él, hogy újraindítás után se vesszen el
        const cf = path.join(outDir, `${id}.clock.json`);
        let prevClock = null; try { prevClock = JSON.parse(fs.readFileSync(cf, "utf8")); } catch {}
        out.clock = advanceClock(prevClock, out.acting || [], (out.updatedAt || 0) * 1000 || Date.now());
        fs.writeFileSync(cf, JSON.stringify(out.clock));
        if (view) writeAtomic(`${id}.view.json`, view);
        writeAtomic(`${id}.json`, out);
      }
      lastCount = out.actionCount;
      // vissza a Game fülre, onnan figyeljük a változást
      lastSig = await signature();
      await sleep(300);
      lastSig = await signature();
      log(`frissítve (${reason}, ${((Date.now() - t0) / 1000).toFixed(1)} mp): ${players.map((p) => `${p.name} $${p.value}`).join(", ")}`);
    } while (dirty);
  } catch (e) {
    log("hiba:", e.message);
  } finally {
    busy = false;
  }
}

async function open() {
  await page.goto(`https://18xx.games/game/${id}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector("#game_menu", { timeout: 90000 });
  await sleep(1500);
}

// változásfigyelő az oldalon belül (a mérés csak a háttérben, csendben történik)
await page.exposeFunction("__xxChanged", () => {
  if (busy) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (busy) return;
    const s = await signature();
    if (s && s !== lastSig) { log("változás az oldalon, kiolvasás…"); await refresh("élő"); }
  }, 350);
});
async function installObserver() {
  await page.evaluate(() => {
    if (window.__xxObs) return;
    window.__xxObs = new MutationObserver(() => window.__xxChanged());
    window.__xxObs.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

await open();
await installObserver();
await refresh("indulás");

// védőháló: ha az élő csatorna elakadna, ritkán (2 percenként) ellenőrizzük az API lépésszámát, és szükség esetén újratöltünk
setInterval(async () => {
  if (busy) return;
  try {
    const g = await api();
    const n = Array.isArray(g.actions) ? g.actions.length : 0;
    if (n !== lastCount) {
      log(`az élő csatorna elmaradt (${lastCount} → ${n}), újratöltés`);
      await open();
      await installObserver();
      await refresh("újratöltés");
    }
  } catch (e) { log("ellenőrzés:", e.message); }
}, 120000);

process.on("SIGINT", quit); process.on("SIGTERM", quit);
// szívverés + időkorlát (a hub ebből tudja, hogy él a figyelő)
if (postUrl) setInterval(async () => { try { await post({ id, hb: true }); } catch (e) { log("szívverés:", e.message); } if (maxMs && Date.now() - startedAt > maxMs) { log("időkorlát, leállás"); await quit(); } }, 45_000);
browser.on("disconnected", () => process.exit(quitting ? 0 : 1));
