// Játékidő-óra (a worker/src/index.js-ben lévő ugyanilyen függvények párja).
// Az óra alapból áll; a "Start" gomb indítja. Futás közben a soron lévő játékos ideje gyűlik.
export const CLOCK_CAP = 30 * 60_000;

export function newClock() {
  return { ms: {}, since: Date.now(), acting: [], running: false };
}

// új állapot a játékból (ki van soron, mikor volt az utolsó lépés)
export function advanceClock(c, acting, ts) {
  if (!c || typeof c !== "object") c = newClock();
  if (!c.ms) c.ms = {};
  if (c.running && ts > c.since) {
    const gap = Math.min(ts - c.since, CLOCK_CAP);
    for (const n of c.acting || []) c.ms[n] = (c.ms[n] || 0) + gap;
    c.since = ts;
  }
  c.acting = [...acting];
  return c;
}

// gombok: start / pause / reset
export function controlClock(c, action, now = Date.now()) {
  if (!c || typeof c !== "object") c = newClock();
  if (!c.ms) c.ms = {};
  if (action === "start" && !c.running) { c.running = true; c.since = now; }
  else if (action === "pause" && c.running) {
    const gap = Math.min(Math.max(now - c.since, 0), CLOCK_CAP);
    for (const n of c.acting || []) c.ms[n] = (c.ms[n] || 0) + gap;
    c.running = false; c.since = now;
  } else if (action === "reset") { c.ms = {}; c.since = now; }
  return c;
}