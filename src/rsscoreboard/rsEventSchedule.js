// Corp RS Events recur every 28 days, from Saturday 00:00 UTC to Sunday 23:59 UTC (48 h).
// Anchor: the event that started Saturday 2026-10-10 00:00 UTC is Corp RS Event #51.
const ANCHOR_START_MS = Date.UTC(2026, 9, 10);
const ANCHOR_EVENT_NUMBER = 51;
const PERIOD_MS = 28 * 24 * 60 * 60 * 1000;
const DURATION_MS = 48 * 60 * 60 * 1000;

function windowForIndex(index) {
  const start = new Date(ANCHOR_START_MS + index * PERIOD_MS);
  return {
    number: ANCHOR_EVENT_NUMBER + index,
    start,
    end: new Date(start.getTime() + DURATION_MS)
  };
}

// The scheduled event window closest to `date` (the one a run at `date` belongs to)
export function getEventWindow(date) {
  const index = Math.round((new Date(date).getTime() - ANCHOR_START_MS) / PERIOD_MS);
  return windowForIndex(index);
}

// The first scheduled event window that starts after `now`
export function getNextEventWindow(now = new Date()) {
  const index = Math.floor((new Date(now).getTime() - ANCHOR_START_MS) / PERIOD_MS) + 1;
  return windowForIndex(index);
}

export function isEventWindowActive(window, now = new Date()) {
  const t = new Date(now).getTime();
  return t >= window.start.getTime() && t < window.end.getTime();
}
