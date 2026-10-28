// Time zone and local-time helpers. Members enter local times; the schedule is stored and shown in UTC.

const MINUTES_PER_DAY = 1440;
const FIXED_OFFSET_RE = /^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?:\s*:?\s*(\d{2}))?$/i;

// IANA zones from the runtime's ICU data, plus plain UTC (not in the list on Node 20)
export const TIME_ZONES = ['UTC', ...Intl.supportedValuesOf('timeZone')];

// Whole and common half/quarter hour offsets, offered as "UTC+03:00" style zones
const FIXED_OFFSETS = [];
for (let minutes = -12 * 60; minutes <= 14 * 60; minutes += 15) {
  const quarter = Math.abs(minutes) % 60;
  if (quarter === 0 || [-570, -210, 210, 270, 330, 345, 390, 525, 570, 630, 765].includes(minutes)) {
    if (minutes !== 0) FIXED_OFFSETS.push(formatOffsetZone(minutes));
  }
}

const formatters = new Map();

function getFormatter(zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

export function formatMinutes(minutes) {
  const m = mod(minutes, MINUTES_PER_DAY);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function formatHour(hour) {
  return `${pad(hour)}:00`;
}

export function formatOffsetZone(offsetMinutes) {
  if (offsetMinutes === 0) return 'UTC';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function parseFixedOffset(text) {
  const match = text.match(FIXED_OFFSET_RE);
  if (!match) return null;
  const [, sign, hours, minutes = '0'] = match;
  const total = (parseInt(hours, 10) * 60 + parseInt(minutes, 10)) * (sign === '-' ? -1 : 1);
  if (parseInt(minutes, 10) >= 60 || total < -12 * 60 || total > 14 * 60) return null;
  return total;
}

// Returns the canonical zone id ("Europe/Istanbul", "UTC+05:30", "UTC") or null if not recognised
export function normalizeTimeZone(input) {
  const text = (input || '').trim();
  if (!text) return null;
  if (/^(utc|gmt|z)$/i.test(text)) return 'UTC';

  const fixed = parseFixedOffset(text);
  if (fixed !== null) return formatOffsetZone(fixed);

  const lower = text.toLowerCase().replace(/\s+/g, '_');
  const exact = TIME_ZONES.find(zone => zone.toLowerCase() === lower);
  if (exact) return exact;

  // Aliases ICU accepts but doesn't list, e.g. "US/Eastern"
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: text }).resolvedOptions().timeZone;
  } catch (_) {
    return null;
  }
}

// Minutes the zone is ahead of UTC at the given moment (follows DST for IANA zones)
export function getOffsetMinutes(zone, date = new Date()) {
  if (!zone || zone === 'UTC') return 0;
  const fixed = parseFixedOffset(zone);
  if (fixed !== null) return fixed;

  const parts = Object.fromEntries(getFormatter(zone).formatToParts(date).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const truncated = Math.floor(date.getTime() / 60_000) * 60_000;
  return Math.round((asUTC - truncated) / 60_000);
}

export function describeTimeZone(zone, date = new Date()) {
  const offset = getOffsetMinutes(zone, date);
  const localNow = formatMinutes(date.getUTCHours() * 60 + date.getUTCMinutes() + offset);
  const offsetText = formatOffsetZone(offset);
  return zone === offsetText ? `${zone} · now ${localNow}` : `${zone} · ${offsetText} · now ${localNow}`;
}

// Zone suggestions for autocomplete, best matches first
export function searchTimeZones(query, preferred = null, limit = 25) {
  const text = (query || '').trim().toLowerCase().replace(/\s+/g, '_');
  const results = [];
  const push = zone => {
    if (zone && !results.includes(zone)) results.push(zone);
  };

  if (!text) {
    push(preferred);
    push('UTC');
    ['Europe/London', 'Europe/Berlin', 'Europe/Istanbul', 'America/New_York', 'America/Chicago',
      'America/Los_Angeles', 'America/Sao_Paulo', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo',
      'Australia/Sydney'].forEach(push);
    FIXED_OFFSETS.filter(z => !z.includes(':30') && !z.includes(':45')).forEach(push);
    return results.slice(0, limit);
  }

  const asZone = normalizeTimeZone(query);
  push(asZone);

  const all = [...TIME_ZONES, ...FIXED_OFFSETS];
  const starts = all.filter(z => z.toLowerCase().startsWith(text) || z.toLowerCase().split('/').pop().startsWith(text));
  const contains = all.filter(z => z.toLowerCase().includes(text));
  [...starts, ...contains].forEach(push);
  return results.slice(0, limit);
}

// Accepts "3", "03", "3:00", "03:00", "0300", "3.30", "3pm", "3:30 am", "24:00".
// Returns minutes since local midnight (0..1440) or null.
export function parseLocalTime(input) {
  const text = (input || '').trim().toLowerCase().replace(/\s+/g, '');
  const match = text.match(/^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm|a|p)?$/);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];
  if (minutes >= 60) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (hours === 12) hours = 0;
    if (meridiem.startsWith('p')) hours += 12;
  }
  if (hours === 24 && minutes === 0) return MINUTES_PER_DAY;
  if (hours > 23) return null;
  return hours * 60 + minutes;
}

// Event moment from admin input: a countdown as shown in game ("10h27m", "2d 10h", "45m", "in 3h")
// or a local time of day ("14:30", "2pm"), meaning its next occurrence.
// Returns { clear: true } for "-", a Date, or null when the input can't be read.
export function parseEventInput(input, offsetMinutes, now = new Date()) {
  const text = (input || '').trim().toLowerCase();
  if (['-', 'clear', 'none', 'off', '0'].includes(text)) return { clear: true };

  const countdown = text.replace(/\s+/g, '').match(/^(?:in)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?:in)?)?$/);
  if (countdown && (countdown[1] || countdown[2] || countdown[3])) {
    const [, days = '0', hours = '0', minutes = '0'] = countdown;
    const ms = ((parseInt(days, 10) * 24 + parseInt(hours, 10)) * 60 + parseInt(minutes, 10)) * 60_000;
    return new Date(now.getTime() + ms);
  }

  const local = parseLocalTime(text);
  if (local === null) return null;
  const utcMinutes = localToUtcMinutes(local, offsetMinutes);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + utcMinutes * 60_000;
  return new Date(today > now.getTime() ? today : today + MINUTES_PER_DAY * 60_000);
}

export function localToUtcMinutes(localMinutes, offsetMinutes) {
  return mod(localMinutes - offsetMinutes, MINUTES_PER_DAY);
}

export function utcToLocalMinutes(utcMinutes, offsetMinutes) {
  return mod(utcMinutes + offsetMinutes, MINUTES_PER_DAY);
}

// UTC hour slots covered from a local start time up to (not including) a local end time.
// A start inside an hour includes that hour; an end inside an hour includes it too.
// No end = one hour. Equal start and end = the whole day.
export function resolveHourRange(fromLocal, toLocal, offsetMinutes) {
  const fromHour = Math.floor(localToUtcMinutes(fromLocal, offsetMinutes) / 60);
  if (toLocal === null || toLocal === undefined) return [fromHour];

  const toHour = mod(Math.ceil(localToUtcMinutes(toLocal, offsetMinutes) / 60), 24);
  const hours = [fromHour];
  for (let h = mod(fromHour + 1, 24); h !== toHour && h !== fromHour; h = mod(h + 1, 24)) {
    hours.push(h);
  }
  return hours;
}

// Groups hours into contiguous [start, end) UTC ranges, wrapping past midnight
export function groupHourRanges(hours) {
  const set = new Set(hours);
  if (set.size === 0) return [];
  if (set.size === 24) return [{ start: 0, end: 24 }];

  const ranges = [];
  for (let h = 0; h < 24; h++) {
    if (!set.has(h) || set.has(mod(h - 1, 24))) continue;
    let end = h;
    while (set.has(mod(end + 1, 24))) end++;
    ranges.push({ start: h, end: end + 1 });
  }
  return ranges;
}

export function formatUtcRange({ start, end }) {
  return `${formatHour(start)}–${formatHour(start === 0 && end === 24 ? 24 : end % 24)}`;
}
