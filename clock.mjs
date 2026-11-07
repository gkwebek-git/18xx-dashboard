// Játékidő-óra (a hub/worker/src/index.js-ben lévő ugyanilyen függvény párja).
export const CLOCK_CAP = 30 * 60_000;
export function advanceClock(c, acting, ts) {
  if (!c || typeof c !== "object") c = { ms: {}, since: ts, acting: [] };
  if (ts > c.since) {
    const gap = Math.min(ts - c.since, CLOCK_CAP);
    for (const n of c.acting || []) c.ms[n] = (c.ms[n] || 0) + gap;
    c.since = ts;
  }
  c.acting = [...acting];
  return c;
}
