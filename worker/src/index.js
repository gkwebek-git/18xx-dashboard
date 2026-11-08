// 18xx élő figyelő – Cloudflare Worker + egyetlen Durable Object ("Hub").
//
// Feladata:
//  * nyilvántartja, melyik játékokat követjük (bárki hozzáadhat egy linkkel),
//  * KÍMÉLETESEN figyeli az 18xx.games-t (összesen max. 1 kérés / 10 mp – ez a robots.txt Crawl-delay-e),
//    és csak akkor kéri le az adatot, ha tényleg változott valami,
//  * változáskor elindítja a GitHub Actions kiolvasót (az számolja ki a táblázatot egy böngészővel),
//  * az eredményt WebSocketen azonnal kiküldi minden nézőnek.

const API = "https://18xx.games/api/game/";
const UA = "xx18-dashboard/1.0 (+https://github.com/gkwebek-git/18xx-dashboard; polite: max 1 req/10s, change detection)";

const MIN_GAP = 10_000; // két 18xx.games kérés között legalább ennyi idő
const DISPATCH_GAP = 45_000; // két kiolvasó-indítás között legalább ennyi
const INFLIGHT_MAX = 6 * 60_000; // ennyi ideig várjuk meg a kiolvasót
const LIVE_ALIVE = 150_000; // ennyi ideig számít élőnek a figyelő a szívverés után
const LIVE_START_GRACE = 150_000; // indítás után ennyit várunk, mielőtt újat kérnénk
const LIVE_IDLE_STOP = 15 * 60_000; // ennyi néző nélküli idő után leáll
const MAX_LIVE = 3; // egyszerre futó élő figyelők száma
const MAX_ACTIVE = 40; // egyszerre követett, még futó játékok
const MAX_TOTAL = 200;
const TRACK_PER_HOUR = 8; // egy IP-ről óránként hány új játék

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return json({ ok: true, service: "xx18-live" }, 200, CORS);
    const stub = env.HUB.get(env.HUB.idFromName("main"));
    const res = await stub.fetch(req);
    if (res.status === 101) return res;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  },
};

// Játékidő-óra: mindenki összesített "soron lévő" ideje. Az óra alapból áll, a Start gomb indítja.
// A határokat a játék saját időbélyege adja (az utolsó lépés ideje), így akkor is pontos, ha a figyelő későn veszi észre a lépést.
// Hosszú tétlenséget (éjszaka) nem számolunk tovább a korlátnál.
const CLOCK_CAP = 30 * 60_000;
function advanceClock(c, acting, ts) {
  if (!c || typeof c !== "object") c = { ms: {}, turn: {}, since: Date.now(), acting: [], running: false };
  if (!c.ms) c.ms = {};
  if (!c.turn) c.turn = {};
  if (c.running && ts > c.since) {
    const gap = Math.min(ts - c.since, CLOCK_CAP);
    for (const n of c.acting || []) { c.ms[n] = (c.ms[n] || 0) + gap; c.turn[n] = (c.turn[n] || 0) + gap; }
    c.since = ts;
  }
  // aki most került sorra, annak a köridője nulláról indul; aki lépett, annak a utolsó köridője megmarad
  for (const n of acting) if (!(c.acting || []).includes(n)) c.turn[n] = 0;
  c.acting = [...acting];
  return c;
}
function controlClock(c, action, now) {
  if (!c || typeof c !== "object") c = { ms: {}, turn: {}, since: now, acting: [], running: false };
  if (!c.ms) c.ms = {};
  if (!c.turn) c.turn = {};
  if (action === "start" && !c.running) { c.running = true; c.since = now; }
  else if (action === "pause" && c.running) {
    const gap = Math.min(Math.max(now - c.since, 0), CLOCK_CAP);
    for (const n of c.acting || []) { c.ms[n] = (c.ms[n] || 0) + gap; c.turn[n] = (c.turn[n] || 0) + gap; }
    c.running = false; c.since = now;
  } else if (action === "reset") { c.ms = {}; c.turn = {}; c.since = now; }
  return c;
}
function parseGameId(input) {
  const s = String(input ?? "").trim();
  let m = /18xx\.games\/game\/(\d{1,9})/i.exec(s) || /^\s*#?(\d{1,9})\s*$/.exec(s);
  if (!m) m = /[?&]game=(\d{1,9})/.exec(s);
  return m ? String(Number(m[1])) : null;
}

export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.games = {};
    this.st = { lastApi: 0, lastDispatch: 0, inflight: null, lastGc: 0 };
    this.lock = Promise.resolve();
    this.rl = new Map();
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ctx.blockConcurrencyWhile(async () => {
      this.games = (await this.ctx.storage.get("games")) || {};
      this.st = { ...this.st, ...((await this.ctx.storage.get("st")) || {}) };
    });
  }

  async save() {
    await this.ctx.storage.put({ games: this.games, st: this.st });
  }

  liveAlive(g) {
    return !!g.liveAt && Date.now() - g.liveAt < LIVE_ALIVE;
  }

  liveCount() {
    const now = Date.now();
    return Object.values(this.games).filter((g) => !g.gone && (this.liveAlive(g) || now - (g.liveDispatch || 0) < LIVE_START_GRACE)).length;
  }

  // ha nézik a játékot, de nem fut élő figyelő, indítunk egyet (GitHub Actions, egy nyitva tartott böngészőlappal)
  async maybeLive(g) {
    const now = Date.now();
    if (g.gone || g.status === "finished" || !this.viewers(g.id) || this.liveAlive(g)) return;
    if (now - (g.liveDispatch || 0) < LIVE_START_GRACE || this.liveCount() >= MAX_LIVE) return;
    const e = this.env;
    if (!e.GH_TOKEN) return;
    g.liveDispatch = now;
    try {
      const res = await fetch(`https://api.github.com/repos/${e.GH_REPO}/actions/workflows/${e.GH_LIVE_WORKFLOW || "live.yml"}/dispatches`, {
        method: "POST",
        headers: { authorization: `Bearer ${e.GH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "xx18-live", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
        body: JSON.stringify({ ref: e.GH_REF, inputs: { id: String(g.id) } }),
      });
      if (res.status !== 204) { console.error("élő indítás státusz", res.status, (await res.text()).slice(0, 200)); g.liveDispatch = now + 60_000; }
    } catch (err) {
      console.error("élő indítás hiba", String(err));
    }
  }

  viewers(id) {
    return this.ctx.getWebSockets(String(id)).length;
  }

  broadcast(id, msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(String(id))) {
      try {
        ws.send(text);
      } catch {}
    }
  }

  // ---------- útvonalak ----------
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/api/games") return this.listGames();
      if (req.method === "POST" && p === "/api/track") return await this.track(req);
      if (req.method === "POST" && p === "/api/ingest") return await this.ingest(req);
      if (req.method === "POST" && p === "/api/clock") return await this.clockCtl(req);
      if (req.method === "POST" && p === "/api/custom") return await this.customCtl(req);
      let m = /^\/api\/game\/(\d{1,9})\/view$/.exec(p);
      if (req.method === "GET" && m) return await this.getView(m[1]);
      m = /^\/api\/game\/(\d{1,9})$/.exec(p);
      if (req.method === "GET" && m) return await this.getSnapshot(m[1]);
      m = /^\/api\/ws\/(\d{1,9})$/.exec(p);
      if (req.method === "GET" && m) return await this.openSocket(req, m[1]);
      return json({ error: "nincs ilyen cím" }, 404);
    } catch (e) {
      console.error("hiba", p, e && e.stack ? e.stack : e);
      return json({ error: "Belső hiba" }, 500);
    }
  }

  listGames() {
    const list = Object.values(this.games)
      .filter((g) => !g.gone)
      .map((g) => ({
        id: g.id, title: g.title, description: g.description, status: g.status, round: g.round, turn: g.turn,
        players: g.players, updatedAt: g.updatedAt, lastScrape: g.lastScrape, hasSnap: !!g.hasSnap, viewers: this.viewers(g.id),
        updating: !!(g.dirty || g.scraping),
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return json({ games: list });
  }

  async getSnapshot(id) {
    const g = this.games[id];
    if (!g) return json({ error: "Ezt a játékot még nem követjük." }, 404);
    const snap = await this.ctx.storage.get("s:" + id);
    if (!snap) return json({ pending: true, id: Number(id), status: g.status, title: g.title }, 202);
    return new Response(snap, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }

  async getView(id) {
    const v = await this.ctx.storage.get("v:" + id);
    if (!v) return json({ error: "Ehhez a játékhoz még nincs TV-nézet." }, 404);
    return new Response(v, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }

  async openSocket(req, id) {
    if (req.headers.get("upgrade") !== "websocket") return json({ error: "WebSocket kell" }, 426);
    const g = this.games[id];
    if (!g) return json({ error: "Ezt a játékot még nem követjük." }, 404);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [id]);
    g.lastViewer = Date.now();
    const snap = await this.ctx.storage.get("s:" + id);
    if (snap) pair[1].send(JSON.stringify({ type: "snapshot", data: JSON.parse(snap) }));
    else pair[1].send(JSON.stringify({ type: "status", state: "pending" }));
    if (g.dirty || g.scraping) pair[1].send(JSON.stringify({ type: "status", state: "updating" }));
    // aki megnyitja az oldalt, kapjon friss adatot (de nem gyakrabban, mint percenként)
    if (Date.now() - (g.lastCheck || 0) > 60_000) {
      g.nextCheck = Date.now();
      await this.save();
      await this.schedule();
    }
    await this.maybeLive(g);
    await this.save();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage() {}
  webSocketClose(ws) {
    try {
      ws.close();
    } catch {}
  }

  // ---------- új játék követése ----------
  async track(req) {
    let body = {};
    try {
      body = await req.json();
    } catch {}
    const id = parseGameId(body.url ?? body.id);
    if (!id) return json({ error: "Ez nem tűnik 18xx.games játék-linknek. Példa: https://18xx.games/game/272021" }, 400);
    if (this.games[id] && !this.games[id].gone) {
      this.games[id].nextCheck = Math.min(this.games[id].nextCheck || 0, Date.now() + 5000);
      await this.save();
      await this.schedule();
      return json({ id: Number(id), existing: true });
    }
    const ip = req.headers.get("cf-connecting-ip") || "?";
    const now = Date.now();
    const hits = (this.rl.get(ip) || []).filter((t) => now - t < 3600_000);
    if (hits.length >= TRACK_PER_HOUR) return json({ error: "Túl sok új játék rövid idő alatt. Próbáld később." }, 429);
    const active = Object.values(this.games).filter((g) => !g.gone && g.status !== "finished").length;
    if (active >= MAX_ACTIVE) return json({ error: "Most tele vagyunk (túl sok egyszerre követett játék). Próbáld később." }, 429);
    if (Object.keys(this.games).length >= MAX_TOTAL) await this.gc(true);

    const r = await this.apiGet(id);
    if (r.code === 404) return json({ error: "Ilyen játékot nem találok az 18xx.games-en." }, 404);
    if (!r.ok) return json({ error: "Az 18xx.games most nem válaszol, próbáld később." }, 502);
    hits.push(now);
    this.rl.set(ip, hits);
    this.games[id] = {
      id: Number(id), title: r.title, description: r.description, status: r.status, players: r.players,
      updatedAt: r.updatedAt, addedAt: now, fp: r.fp, dirty: true, scraping: false, fails: 0, retryAt: 0,
      lastCheck: now, lastChange: r.updatedAt * 1000 || now, nextCheck: now + 60_000, hasSnap: false,
    };
    await this.save();
    await this.schedule();
    return json({ id: Number(id), existing: false });
  }

  // ---------- az 18xx.games lekérdezése (kímélő: sorban, 10 mp-es hézaggal) ----------
  apiGet(id) {
    const run = async () => {
      const wait = this.st.lastApi + MIN_GAP - Date.now();
      if (wait > 0) await sleep(wait);
      this.st.lastApi = Date.now();
      let res;
      try {
        res = await fetch(API + id, { headers: { accept: "application/json", "user-agent": UA } });
      } catch {
        return { ok: false, code: 0 };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { ok: false, code: res.status };
      }
      const text = await res.text();
      const head = text.slice(0, 4000);
      const tail = text.slice(-400);
      const status = (/"status":"([^"]*)"/.exec(head) || [])[1] || "";
      const updatedAt = Number((/"updated_at":(\d+)/.exec(tail) || [])[1] || 0);
      let title = "";
      try {
        title = JSON.parse('"' + ((/"title":"((?:[^"\\]|\\.)*)"/.exec(head) || [])[1] || "") + '"');
      } catch {}
      let description = "";
      try {
        description = JSON.parse('"' + ((/"description":"((?:[^"\\]|\\.)*)"/.exec(head) || [])[1] || "") + '"').trim();
      } catch {}
      let players = [];
      try {
        const pm = /"players":(\[[^\]]*\])/.exec(head);
        if (pm) players = JSON.parse(pm[1]).map((x) => String(x.name));
      } catch {}
      return { ok: true, code: 200, status, updatedAt, title, description, players, fp: `${text.length}:${updatedAt}:${status}` };
    };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => {});
    return p;
  }

  interval(g) {
    const viewers = this.viewers(g.id);
    const active = Object.values(this.games).filter((x) => !x.gone && x.status !== "finished").length;
    if (this.liveAlive(g) && g.status !== "finished") return Infinity; // az élő figyelő hozza az adatot, nem kérdezgetünk
    if (g.status === "finished") return viewers ? 180_000 : Infinity;
    if (viewers) return Math.max(45_000, MIN_GAP * active);
    const idle = Date.now() - (g.lastChange || g.addedAt || 0);
    if (idle < 86400_000) return Math.max(10 * 60_000, MIN_GAP * active);
    if (idle < 7 * 86400_000) return 30 * 60_000;
    return 2 * 3600_000;
  }

  backoff(fails) {
    return Math.min(60_000 * 2 ** Math.max(0, fails - 1), 30 * 60_000);
  }

  // ---------- az ébresztő: egy ellenőrzés + (ha kell) kiolvasó indítása ----------
  async alarm() {
    const now = Date.now();
    // elveszett kiolvasás
    if (this.st.inflight && now - this.st.inflight.at > INFLIGHT_MAX) {
      for (const id of this.st.inflight.ids) {
        const g = this.games[id];
        if (!g) continue;
        g.scraping = false;
        g.dirty = true;
        g.fails = (g.fails || 0) + 1;
        g.retryAt = now + this.backoff(g.fails);
      }
      this.st.inflight = null;
    }
    // leállt élő figyelők: visszaesünk a kímélő lekérdezésre, és ha még nézik, indítunk újat
    for (const g of Object.values(this.games)) {
      if (g.liveAt && !this.liveAlive(g)) { g.liveAt = 0; g.nextCheck = now; }
      if (this.viewers(g.id)) { g.lastViewer = now; await this.maybeLive(g); }
    }
    // egy játék ellenőrzése
    const due = Object.values(this.games)
      .filter((g) => !g.gone && Number.isFinite(g.nextCheck) && g.nextCheck <= now && this.interval(g) !== Infinity)
      .sort((a, b) => a.nextCheck - b.nextCheck)[0];
    if (due && now >= this.st.lastApi + MIN_GAP) await this.check(due);
    await this.maybeDispatch();
    if (now - (this.st.lastGc || 0) > 86400_000) await this.gc(false);
    await this.save();
    await this.schedule();
  }

  async check(g) {
    const r = await this.apiGet(g.id);
    const now = Date.now();
    g.lastCheck = now;
    if (!r.ok) {
      g.fails = (g.fails || 0) + 1;
      if (r.code === 404 && g.fails >= 3) g.gone = true;
      g.nextCheck = now + this.backoff(g.fails);
      return;
    }
    if (r.fp !== g.fp) {
      g.fp = r.fp;
      g.status = r.status || g.status;
      g.updatedAt = r.updatedAt || g.updatedAt;
      g.lastChange = r.updatedAt ? r.updatedAt * 1000 : now;
      if (r.title) g.title = r.title;
      if (r.players.length) g.players = r.players;
      g.dirty = true;
      this.broadcast(g.id, { type: "status", state: "updating" });
    }
    g.nextCheck = now + this.interval(g);
  }

  async maybeDispatch() {
    const now = Date.now();
    if (this.st.inflight || now < (this.st.lastDispatch || 0) + DISPATCH_GAP) return;
    const ids = Object.values(this.games)
      .filter((g) => !g.gone && g.dirty && !g.scraping && (g.retryAt || 0) <= now)
      .sort((a, b) => (b.lastChange || 0) - (a.lastChange || 0))
      .slice(0, 5)
      .map((g) => String(g.id));
    if (!ids.length) return;
    this.st.lastDispatch = now;
    const e = this.env;
    if (!e.GH_TOKEN) return;
    let res;
    try {
      res = await fetch(`https://api.github.com/repos/${e.GH_REPO}/actions/workflows/${e.GH_WORKFLOW}/dispatches`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${e.GH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "xx18-live",
          "x-github-api-version": "2022-11-28", "content-type": "application/json",
        },
        body: JSON.stringify({ ref: e.GH_REF, inputs: { ids: ids.join(" ") } }),
      });
    } catch (err) {
      console.error("dispatch hiba", String(err));
      return;
    }
    if (res.status !== 204) {
      console.error("dispatch státusz", res.status, (await res.text()).slice(0, 200));
      this.st.lastDispatch = now + 60_000; // hiba: egy percet várunk
      return;
    }
    this.st.inflight = { ids, at: now };
    for (const id of ids) {
      this.games[id].dirty = false;
      this.games[id].scraping = true;
      this.broadcast(id, { type: "status", state: "updating" });
    }
  }

  async schedule() {
    const now = Date.now();
    let t = Infinity;
    for (const g of Object.values(this.games)) {
      if (g.gone) continue;
      if (g.liveAt && this.liveAlive(g)) t = Math.min(t, g.liveAt + LIVE_ALIVE + 1000);
      else if (this.viewers(g.id) && g.status !== "finished") t = Math.min(t, now + LIVE_START_GRACE);
      if (Number.isFinite(g.nextCheck) && this.interval(g) !== Infinity) t = Math.min(t, Math.max(g.nextCheck, this.st.lastApi + MIN_GAP));
      if (g.dirty && !g.scraping) {
        const gate = this.st.inflight ? this.st.inflight.at + INFLIGHT_MAX : Math.max((this.st.lastDispatch || 0) + DISPATCH_GAP, g.retryAt || 0);
        t = Math.min(t, gate);
      }
    }
    if (this.st.inflight) t = Math.min(t, this.st.inflight.at + INFLIGHT_MAX + 1000);
    if (Number.isFinite(t)) await this.ctx.storage.setAlarm(Math.max(t, now + 1000));
  }

  // ---------- játékos megjelenített neve / színe (mindenki ugyanazt látja) ----------
  async customCtl(req) {
    let body = {};
    try { body = await req.json(); } catch {}
    const id = String(body.id ?? "");
    const g = this.games[id];
    if (!g) return json({ error: "ismeretlen játék" }, 404);
    const player = String(body.player ?? "").slice(0, 60);
    if (!player || !(g.players || []).includes(player)) return json({ error: "ismeretlen játékos" }, 400);
    const name = String(body.name ?? "").replace(/[<>]/g, "").trim().slice(0, 24);
    const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color ?? "")) ? String(body.color) : "";
    g.custom = g.custom || {};
    if (!name && !color) delete g.custom[player];
    else g.custom[player] = { ...(name ? { name } : {}), ...(color ? { color } : {}) };
    const raw = await this.ctx.storage.get("s:" + id);
    if (raw) {
      const d = JSON.parse(raw);
      d.custom = g.custom;
      await this.ctx.storage.put("s:" + id, JSON.stringify(d));
      this.broadcast(id, { type: "snapshot", data: d });
    }
    await this.save();
    return json({ ok: true, custom: g.custom });
  }
  // ---------- játékidő-óra gombjai (Start / Szünet / Nullázás) ----------
  async clockCtl(req) {
    let body = {};
    try { body = await req.json(); } catch {}
    const id = String(body.id ?? "");
    const g = this.games[id];
    if (!g) return json({ error: "ismeretlen játék" }, 404);
    if (!["start", "pause", "reset"].includes(body.action)) return json({ error: "ismeretlen művelet" }, 400);
    g.clock = controlClock(g.clock, body.action, Date.now());
    const raw = await this.ctx.storage.get("s:" + id);
    if (raw) {
      const d = JSON.parse(raw);
      d.clock = g.clock;
      if (g.custom) d.custom = g.custom;
      await this.ctx.storage.put("s:" + id, JSON.stringify(d));
      this.broadcast(id, { type: "snapshot", data: d });
    }
    await this.save();
    return json({ ok: true, clock: g.clock });
  }
  // ---------- a kiolvasó (GitHub Actions) ide küldi az eredményt ----------
  async ingest(req) {
    const auth = req.headers.get("authorization") || "";
    const expected = "Bearer " + (this.env.INGEST_TOKEN || "");
    if (!this.env.INGEST_TOKEN || auth.length !== expected.length || !timingSafeEqual(auth, expected)) return json({ error: "nincs jogosultság" }, 401);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "hibás adat" }, 400);
    }
    const id = String(body.id ?? "");
    const g = this.games[id];
    if (!g) return json({ error: "ismeretlen játék" }, 404);
    const now = Date.now();
    if (body.hb) {
      g.liveAt = now;
      if (this.viewers(id)) g.lastViewer = now;
      const stop = !this.viewers(id) && now - (g.lastViewer || 0) > LIVE_IDLE_STOP;
      if (stop) g.liveAt = 0;
      await this.save();
      await this.schedule();
      return json({ ok: true, stop });
    }
    if (this.st.inflight) {
      this.st.inflight.ids = this.st.inflight.ids.filter((x) => x !== id);
      if (!this.st.inflight.ids.length) this.st.inflight = null;
    }
    g.scraping = false;
    if (body.error || !body.data) {
      g.fails = (g.fails || 0) + 1;
      g.dirty = true;
      g.retryAt = now + this.backoff(g.fails);
      this.broadcast(id, { type: "status", state: "error" });
    } else {
      const d = { ...body.data, fresh: now };
      g.clock = advanceClock(g.clock, Array.isArray(d.acting) ? d.acting : [], (d.updatedAt || 0) * 1000 || now);
      d.clock = g.clock;
      if (g.custom) d.custom = g.custom;
      if (body.view && typeof body.view === "object") {
        d.vrev = now;
        await this.ctx.storage.put("v:" + id, JSON.stringify(body.view));
      } else {
        const prev = await this.ctx.storage.get("s:" + id);
        if (prev) d.vrev = JSON.parse(prev).vrev;
      }
      await this.ctx.storage.put("s:" + id, JSON.stringify(d));
      g.hasSnap = true;
      g.lastScrape = now;
      g.fails = 0;
      g.retryAt = 0;
      g.title = d.title || g.title;
      g.description = (d.description || "").trim();
      g.status = d.status || g.status;
      g.round = d.round;
      g.turn = d.turn;
      g.updatedAt = d.updatedAt || g.updatedAt;
      if (Array.isArray(d.players)) g.players = d.players.map((p) => p.name);
      this.broadcast(id, { type: "snapshot", data: d });
      if (body.live) { g.liveAt = now; g.dirty = false; }
    }
    await this.save();
    await this.schedule();
    const stop = !!body.live && !this.viewers(id) && now - (g.lastViewer || 0) > LIVE_IDLE_STOP;
    if (stop) g.liveAt = 0;
    return json({ ok: true, stop });
  }

  async gc(force) {
    const now = Date.now();
    this.st.lastGc = now;
    const all = Object.values(this.games);
    for (const g of all) {
      if ((g.gone && now - (g.lastCheck || 0) > 7 * 86400_000) || (g.status === "finished" && now - (g.lastScrape || g.addedAt) > 60 * 86400_000 && !this.viewers(g.id))) {
        delete this.games[g.id];
        await this.ctx.storage.delete(["s:" + g.id, "v:" + g.id]);
      }
    }
    if (force) {
      const oldest = Object.values(this.games).filter((g) => g.status === "finished").sort((a, b) => (a.lastScrape || 0) - (b.lastScrape || 0))[0];
      if (oldest) {
        delete this.games[oldest.id];
        await this.ctx.storage.delete(["s:" + oldest.id, "v:" + oldest.id]);
      }
    }
  }
}

function timingSafeEqual(a, b) {
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
