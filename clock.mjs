// Játékidő-óra (a worker/src/index.js-ben lévő ugyanilyen függvények párja).
// Az óra alapból áll; a "Start" gomb indítja. Futás közben a soron lévő játékos ideje gyűlik:
//   ms   = összidő, turn = köridő (újra sorra kerüléskor nulláról indul, lépés után megmarad az utolsó köridő).
export const CLOCK_CAP = Infinity; // nincs korlát: lokálisan játszanak, senki nem "tűnik el"

export function newClock() {
  return { ms: {}, turn: {}, since: Date.now(), acting: [], running: false };
}

export function advanceClock(c, acting, ts) {
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
export function controlClock(c, action, now = Date.now()) {
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
