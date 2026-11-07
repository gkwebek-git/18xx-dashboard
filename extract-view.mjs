// A játék többi füléről (Game / Map / Market / Info / Entities) kiolvassa azt, amiből a TV-nézet készül:
// térkép (SVG), tőzsde, bank, vonatok, játékosok és cégek kártyái, napló. Minden hibatűrő: ha valami nem található, kihagyja.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTab(page, name, ready) {
  await page.evaluate((n) => {
    const a = [...document.querySelectorAll("#game_menu a")].find((e) => e.textContent.trim() === n);
    if (a) a.click();
  }, name);
  if (ready) await page.waitForSelector(ready, { timeout: 15000 }).catch(() => {});
  await sleep(600);
}

export async function extractView(page) {
  const view = { logos: {} };

  // --- Game: állapotsor + napló ---
  await openTab(page, "Game", "#chatlog");
  Object.assign(
    view,
    await page.evaluate(() => {
      const g = document.querySelector(".game") || document.body;
      const status = (g.innerText.match(/^.*\bPhase\s.*$/m) || [""])[0].trim();
      const log = (document.getElementById("chatlog")?.innerText || "")
        .split("\n").map((s) => s.trim()).filter(Boolean).slice(-8);
      return { status, log };
    })
  );

  // --- Map ---
  await openTab(page, "Map", "#map");
  view.map = await page.evaluate(() => document.getElementById("map")?.outerHTML || "");

  // --- Market: bank + tőzsde ---
  await openTab(page, "Market", "#legend");
  Object.assign(
    view,
    await page.evaluate(() => {
      const bank = [...(document.querySelectorAll("#bank tr") || [])]
        .map((tr) => [...tr.children].slice(0, 2).map((td) => td.textContent.trim()))
        .filter((r) => r.length === 2 && r[0] && !/^Loan Table$/i.test(r[0]));
      const pool = (document.getElementById("bank")?.innerText.match(/(No Trains in Bank Pool|Trains in Bank Pool[^\n]*)/i) || [""])[0];
      const legend = document.getElementById("legend");
      const market = legend?.previousElementSibling?.outerHTML || "";
      return { bank, pool, market };
    })
  );

  // --- Info: vonatok, fázisok ---
  await openTab(page, "Info", "#game_info");
  view.info = await page.evaluate(() => {
    const tables = [...document.querySelectorAll("#game_info table")];
    const grab = (t) => ({
      head: [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim()),
      rows: [...t.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent.trim())),
    });
    const phases = tables.find((t) => /Phase/i.test(t.innerText) && /Train Limit/i.test(t.innerText));
    const trains = tables.find((t) => /Remaining/i.test(t.innerText));
    const pool = [...document.querySelectorAll("#game_info h3")].find((h) => /Bank Pool/i.test(h.textContent));
    return { trains: trains ? grab(trains) : null, phases: phases ? grab(phases) : null, pool: pool?.nextElementSibling?.innerText.trim() || "" };
  });

  // --- Entities: játékosok és cégek ---
  await openTab(page, "Entities", "#entities");
  const ent = await page.evaluate(() => {
    const txt = (el, sel) => el.querySelector(sel)?.textContent.trim() || "";
    const rows = (t) => [...(t?.querySelectorAll("tr") || [])].map((tr) => [...tr.children].map((c) => c.textContent.trim()));
    const players = [];
    const corps = [];
    for (const c of document.querySelectorAll("#entities .card")) {
      if (c.id === "bank" || c.id === "upcoming_trains") continue;
      if (c.classList.contains("corp")) {
        const title = c.querySelector(".corp__title");
        const cs = title ? getComputedStyle(title) : null;
        const hold = c.querySelector(".corp__holdings");
        const sh = c.querySelector("table.center, table");
        const tr = (cls) => c.querySelector(`tr.${cls}`);
        const cells = (row) => (row ? [...row.children].map((x) => x.textContent.trim()) : []);
        const text = c.innerText;
        corps.push({
          name: txt(c, ".title"),
          logo: c.querySelector(".corp__title img")?.getAttribute("src") || "",
          bg: cs?.backgroundColor || "", fg: cs?.color || "",
          sym: hold?.children[0]?.textContent.trim() || "",
          trains: c.querySelector('[title="Trains"]')?.textContent.trim() || "",
          cash: c.querySelector('[title="Cash"]')?.textContent.trim() || "",
          tokens: [...c.querySelectorAll('[title^="token location"]')].map((d) => d.textContent.trim()),
          treasury: cells(tr("ipo")),
          market: cells(tr("market")),
          holders: [...c.querySelectorAll("tr.player")].map((r) => ({ name: r.children[0]?.textContent.trim(), pres: r.children[0]?.classList.contains("president"), shares: r.children[1]?.textContent.trim() })),
          privates: [...c.querySelectorAll(".company_table > div[title]")].map((d) => d.querySelector(".nowrap")?.textContent.trim() || ""),
          loans: (text.match(/Loans\s+(\d+\/\d+)/) || [])[1] || "",
          order: (text.match(/Order:\s*(\d+)/) || [])[1] || "",
          lastRun: (text.match(/Last Run:\s*\[?([^\]\n]*)\]?/) || [])[1]?.trim() || "",
        });
      } else {
        const name = c.querySelector("a")?.textContent.trim() || c.firstElementChild?.textContent.trim() || "";
        const tables = c.querySelectorAll("table");
        const stats = Object.fromEntries(rows(tables[0]).filter((r) => r.length >= 2).map((r) => [r[0], r[1]]));
        const holdings = [...(tables[1]?.querySelectorAll("tr") || [])].map((r) => ({
          logo: r.querySelector("img")?.getAttribute("src") || "",
          sym: r.children[1]?.textContent.trim() || "",
          pct: r.children[2]?.textContent.trim() || "",
        }));
        players.push({ name, stats, holdings, priority: /Priority Deal/i.test(c.innerText) });
      }
    }
    return { players, corps };
  });
  view.players = ent.players;
  view.corps = ent.corps;

  // --- logók beágyazása (nem kell az 18xx.games-t terhelni a nézőknek) ---
  const urls = new Set();
  for (const m of view.map.matchAll(/href="(\/[^"]+\.(?:svg|png|jpe?g|webp|gif))"/g)) urls.add(m[1]);
  for (const c of view.corps) if (c.logo) urls.add(c.logo);
  for (const pl of view.players) for (const h of pl.holdings) if (h.logo) urls.add(h.logo);
  for (const m of view.market.matchAll(/src="(\/[^"]+\.(?:svg|png|jpe?g|webp|gif))"/g)) urls.add(m[1]);
  view.logos = await page.evaluate(async (list) => {
    const out = {};
    for (const u of list) {
      try {
        const r = await fetch(u);
        if (!r.ok) continue;
        const blob = await r.blob();
        out[u] = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(blob); });
      } catch {}
    }
    return out;
  }, [...urls]);

  return view;
}
