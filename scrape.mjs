// 18xx.games "Spreadsheet" adatok kinyerése (cash, value, liquidity, shares, companies, certs + érték-történet).
// A táblázatot maga az oldal számolja a böngészőben, ezért egy láthatatlan böngészővel olvassuk ki.
//
//   node scrape.mjs 272021                  -> out/272021.json
//   node scrape.mjs 272021 --out=public/data --watch=30   (helyben, 30 mp-enként újra)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { collect } from "./collect.mjs";

const args = process.argv.slice(2);
const ids = args.filter((a) => /^\d+$/.test(a));
const opt = (name, def) => (args.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${def}`).split("=")[1];
const outDir = opt("out", "out");
const watch = Number(opt("watch", "0"));
const postUrl = opt("post", "");
const token = process.env.INGEST_TOKEN ?? "";
if (!ids.length) {
  console.error("Használat: node scrape.mjs <játék-azonosító> [...] [--out=mappa] [--watch=másodperc]");
  process.exit(1);
}

const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const executablePath = chromeCandidates.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error("Nem találok Chrome/Edge böngészőt. Állítsd be a CHROME_PATH változót.");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

async function readPrevious(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function post(body) {
  const r = await fetch(postUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Küldési hiba: ${r.status}`);
}

async function scrapeOne(getBrowser, id) {
  // 1) játék adatai a nyilvános API-ból (gyors) – ha nem változott a lépésszám, nem kell újra kiolvasni
  const res = await fetch(`https://18xx.games/api/game/${id}`, { headers: { accept: "application/json", "user-agent": "xx18-dashboard/1.0 (+https://github.com/gkwebek-git/18xx-dashboard)" } });
  if (!res.ok) throw new Error(`API hiba: ${res.status}`);
  const g = await res.json();
  const actionCount = Array.isArray(g.actions) ? g.actions.length : 0;
  const prev = postUrl ? null : await readPrevious(id);
  if (prev && prev.actionCount === actionCount && prev.status === g.status && prev.players?.length) {
    console.log(`[${id}] nincs új lépés (${actionCount}), kihagyva`);
    return false;
  }

  // 2) a Spreadsheet fül kiolvasása
  const page = await (await getBrowser()).newPage();
  try {
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(`https://18xx.games/game/${id}#spreadsheet`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector("#player_details", { timeout: 90000 });
    await new Promise((r) => setTimeout(r, 1500));
    const { out, view, players } = await collect(page, id, g);
    fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(out));
    if (view) fs.writeFileSync(path.join(outDir, `${id}.view.json`), JSON.stringify(view));
    if (postUrl) await post({ id: String(id), data: out, view });
    console.log(`[${id}] kész: ${players.map((p) => `${p.name} $${p.value}`).join(", ")}`);
    return true;
  } finally {
    await page.close();
  }
}

async function runAll() {
  let browser = null; // csak akkor indítunk böngészőt, ha tényleg van mit kiolvasni
  const getBrowser = async () => (browser ??= await puppeteer.launch({ executablePath, headless: "new", args: ["--no-sandbox", "--disable-gpu"] }));
  let failed = false;
  try {
    for (const id of ids) {
      try {
        await scrapeOne(getBrowser, id);
      } catch (e) {
        failed = true;
        console.error(`[${id}] hiba:`, e.message);
        if (postUrl) await post({ id: String(id), error: String(e.message).slice(0, 200) }).catch(() => {});
      }
    }
  } finally {
    if (browser) await browser.close();
  }
  return !failed;
}

if (watch > 0) {
  for (;;) {
    await runAll();
    await new Promise((r) => setTimeout(r, watch * 1000));
  }
} else {
  process.exit((await runAll()) ? 0 : 1);
}
