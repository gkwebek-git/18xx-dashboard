# 18xx élő dashboard

Bárki beilleszthet egy 18xx.games játék-linkjét, és élő táblát kap (vagyon, készpénz, részvények, körönkénti alakulás).

**Oldal:** https://xx18-dashboard.pages.dev (Cloudflare Pages, `public/`)
**Szerver:** `worker/` – Cloudflare Worker + Durable Object (`xx18-live`), ingyenes csomagon fut.

## Hogyan működik
1. A főoldalon beillesztett link a `POST /api/track` hívással bekerül a követett játékok közé.
2. A Worker kíméletesen figyeli az 18xx.games-t: összesen legfeljebb 1 kérés / 10 mp (a robots.txt Crawl-delay-je),
   és csak az ujjlenyomat (méret + utolsó módosítás + állapot) változását nézi.
3. Változáskor elindítja a GitHub Actions `Kiolvasás` munkafolyamatot (`scrape.yml`), ami egy böngészővel kiolvassa a táblázatot.
4. Az eredmény a `POST /api/ingest` hívással visszajön, és WebSocketen azonnal megy minden nézőnek.

Nincs időzített lekérdezés, a kiolvasó csak akkor fut, ha tényleg történt lépés. Késés: kb. 1 perc.

## Titkok (nincsenek a repóban)
- Worker: `INGEST_TOKEN`, `GH_TOKEN` (`wrangler secret put ...`)
- GitHub: titok `INGEST_TOKEN`, változó `HUB_URL`

## Kiadás
- Worker: `cd worker && npx wrangler deploy`
- Oldal: `node deploy.mjs`
