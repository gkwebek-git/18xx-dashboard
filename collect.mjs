// Egy már megnyitott játékoldalról összeállítja a kimenetet: Spreadsheet (játékosok, történet) + TV-nézet adatai.
import { extractView } from "./extract-view.mjs";

export async function collect(page, id, g) {
  const actionCount = Array.isArray(g.actions) ? g.actions.length : 0;
  await page.evaluate(() => { if (document.getElementById("player_details")) return; const a = [...document.querySelectorAll("#game_menu a")].find((e) => e.textContent.trim() === "Spreadsheet"); if (a) a.click(); });
  await page.waitForSelector("#player_details", { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 400));
    const sheet = await page.evaluate(() => {
      const num = (s) => {
        const t = String(s).replace(/[^0-9.\-]/g, "");
        return t === "" || t === "-" ? null : Number(t);
      };
      const det = document.getElementById("player_details");
      const table = det.closest("table");
      const names = [...table.querySelectorAll("th.name")].map((e) => e.textContent.trim());
      const rows = {};
      for (const tr of det.rows) {
        const label = tr.querySelector("th").textContent.trim();
        rows[label] = [...tr.querySelectorAll("td")].map((td) => td.innerText.trim());
      }
      const hist = [];
      const hb = document.getElementById("player_or_history");
      if (hb)
        for (const tr of hb.rows) {
          const label = tr.querySelector("th").textContent.trim();
          hist.push({ label, values: [...tr.querySelectorAll("td")].map((td) => num(td.innerText)) });
        }
      return { names, rows, hist, num: undefined };
    });

    const pick = (prefix) => {
      const key = Object.keys(sheet.rows).find((k) => k.toLowerCase().startsWith(prefix));
      return key ? { key, cells: sheet.rows[key] } : { key: "", cells: [] };
    };
    const n = (s) => {
      const t = String(s ?? "").replace(/[^0-9.\-]/g, "");
      return t === "" || t === "-" ? 0 : Number(t);
    };
    const certs = pick("certs");
    const certLimit = Number((/\/(\d+)/.exec(certs.key) ?? [])[1] ?? 0) || null;
    const players = sheet.names.map((name, i) => ({
      name,
      cash: n(pick("cash").cells[i]),
      value: n(pick("value").cells[i]),
      liquidity: n(pick("liquidity").cells[i]),
      shares: n(pick("shares").cells[i]),
      certs: n(certs.cells[i]),
      companies: (pick("companies").cells[i] ?? "").split(/[\s,]+/).filter(Boolean),
    }));
    if (!players.length) throw new Error("Üres táblázat");

    // történet: csak a kör végi sorok (OR / SR), időrendben
    const history = sheet.hist
      .filter((h) => /^(OR|SR|ISR)\b/.test(h.label))
      .reverse()
      .map((h) => ({ label: h.label, values: h.values }));

    const out = {
      id: Number(id),
      title: g.title,
      description: g.description,
      status: g.status,
      round: g.round,
      turn: g.turn,
      updatedAt: g.updated_at,
      actionCount,
      acting: (g.acting ?? []).map((pid) => (g.players ?? []).find((p) => p.id === pid)?.name).filter(Boolean),
      certLimit,
      players,
      history,
    };
    let view = null;
    try {
      view = await extractView(page);
    } catch (e) {
      console.warn(`[${id}] a TV-nézet adatai nem olvashatók ki: ${e.message}`);
    }
  return { out, view, players };
}
