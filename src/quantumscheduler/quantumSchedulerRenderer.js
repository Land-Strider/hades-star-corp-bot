import { createCanvas } from '@napi-rs/canvas';
import { formatHour } from './quantumSchedulerTime.js';

// Fonts come from the font-dejavu and font-noto-emoji Alpine packages installed in the dockerfile
const FONT = '"DejaVu Sans", "Noto Color Emoji", sans-serif';

const WIDTH = 2800;
const PAD_X = 60;
const COL_W = (WIDTH - PAD_X * 2) / 24;
const HEADER_H = 150;
const ROW_H = 26;
const GROUP_PAD = 5;
const GROUP_GAP = 10;
const MIN_STACK_H = 240;
const AXIS_H = 192;
// Per-slot player/account counts sit in this band at the top of the slots
const COUNT_ROW_H = 30;
// Rows drawn per hour column before the rest collapse into "+N more"
const MAX_ROWS = 40;

const COLORS = {
  text: '#eef4ff',
  muted: '#94adb2',
  line: '#e6ecf7',
  guide: 'rgba(150, 196, 200, 0.08)',
  now: '#22d3ee'
};

// Box colours per member with alts: [member's group box, main account box]. Cyan stays reserved for the current hour.
const GROUP_PALETTE = [
  ['#a855f7', '#fb923c'],
  ['#3b82f6', '#facc15'],
  ['#22c55e', '#f472b6'],
  ['#ef4444', '#a3e635'],
  ['#e879f9', '#34d399'],
  ['#f59e0b', '#818cf8'],
  ['#14b8a6', '#fb7185'],
  ['#94a3b8', '#fde047']
];

// Name colours for solo members (no alts), light enough to read on the dark background
const SOLO_TEXT_PALETTE = [
  '#fca5a5', '#fdba74', '#fde047', '#86efac', '#93c5fd',
  '#c4b5fd', '#f9a8d4', '#d9f99d', '#5eead4', '#fcd34d'
];

const EVENT_COLOR = '#4ade80';
const EVENT_END_COLOR = '#f87171';

// Lines hanging below the timeline: the event start/end, and the two 8 h splits of the event day
// (thinner and softer than the event line, but bolder than the hour splitters)
const EVENT_LINE = { color: EVENT_COLOR, width: 5, blur: 10 };
// Lavender, so it can't be mistaken for the white hour splitters and labels, the event band or the cyan current hour
const SPLIT_LINE = { color: 'rgba(196, 181, 253, 0.9)', width: 3, blur: 5 };

function drawHangingLine(ctx, x, top, bottom, { color, width, blur }) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  ctx.restore();
}

function groupColors(index) {
  const [group, main] = GROUP_PALETTE[index % GROUP_PALETTE.length];
  return { group, main };
}

function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Deterministic PRNG so the starfield doesn't change between edits of the same board
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Dark slate-teal space with cyan specks, like the in-game star map
function drawBackground(ctx, height) {
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  // Kept dark (close to the earlier navy's brightness), with no lighter band in the middle
  bg.addColorStop(0, '#0f1d23');
  bg.addColorStop(1, '#0a161b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, height);

  const random = seededRandom(24);
  const starCount = Math.round((WIDTH * height) / 9000);
  for (let i = 0; i < starCount; i++) {
    ctx.globalAlpha = 0.2 + random() * 0.5;
    ctx.fillStyle = random() < 0.6 ? '#5fe3d0' : '#ffffff';
    ctx.beginPath();
    ctx.arc(random() * WIDTH, random() * height, random() < 0.9 ? 0.9 : 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawGlowText(ctx, text, x, y, { font, color = COLORS.text, glow = COLORS.now, blur = 18, align = 'left' }) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.shadowColor = glow;
  ctx.shadowBlur = blur;
  ctx.fillText(text, x, y);
  // Crisp pass on top so the glow doesn't blur the glyphs
  ctx.shadowBlur = 0;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Shrinks the font down to 12px before cutting the name with an ellipsis
function drawFittedName(ctx, text, x, y, maxWidth) {
  for (const size of [15, 14, 13, 12]) {
    ctx.font = `bold ${size}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) {
      ctx.fillText(text, x, y);
      return;
    }
  }
  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(trimmed + '…').width > maxWidth) trimmed = trimmed.slice(0, -1);
  ctx.fillText(trimmed + '…', x, y);
}

// The outer box links accounts of one member. A main alone in a slot needs only its own main box;
// an alt alone keeps the outer box so it still reads as someone's alt.
function hasGroupBox(entry) {
  return entry.hasAlts && !(entry.names.length === 1 && entry.names[0] === entry.main);
}

function entryHeight(entry) {
  return entry.names.length * ROW_H + (hasGroupBox(entry) ? GROUP_PAD * 2 : 0);
}

// Splits a column into the entries that fit under MAX_ROWS and the number of accounts left out
function layoutColumn(column) {
  const shown = [];
  let rows = 0;
  let hidden = 0;
  for (const entry of column.entries) {
    if (rows + entry.names.length > MAX_ROWS) {
      hidden += entry.names.length;
      continue;
    }
    shown.push(entry);
    rows += entry.names.length;
  }
  const height = shown.reduce((sum, e) => sum + entryHeight(e) + GROUP_GAP, 0) + (hidden > 0 ? ROW_H : 0);
  return { shown, hidden, height };
}

function drawColumn(ctx, layout, colX, lineY) {
  const nameWidth = COL_W - 24;
  const centerX = colX + COL_W / 2;
  let bottom = lineY - 14;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const entry of layout.shown) {
    const height = entryHeight(entry);
    const top = bottom - height;

    // One member's accounts are boxed together; their main account gets its own highlight
    const colors = groupColors(entry.colorIndex || 0);
    const boxed = hasGroupBox(entry);
    if (boxed) {
      ctx.fillStyle = withAlpha(colors.group, 0.12);
      roundRect(ctx, colX + 5, top, COL_W - 10, height, 7);
      ctx.fill();
      ctx.strokeStyle = colors.group;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Main account sits nearest the line, alts stack above it
    entry.names.forEach((name, i) => {
      const rowBottom = bottom - (boxed ? GROUP_PAD : 0) - i * ROW_H;
      const rowCenter = rowBottom - ROW_H / 2;

      if (entry.hasAlts && name === entry.main) {
        ctx.fillStyle = withAlpha(colors.main, 0.16);
        roundRect(ctx, colX + 9, rowBottom - ROW_H + 2, COL_W - 18, ROW_H - 4, 5);
        ctx.fill();
        ctx.strokeStyle = colors.main;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Solo accounts get a name colour per member; accounts of members with alts stay white
      ctx.fillStyle = entry.hasAlts ? COLORS.text : SOLO_TEXT_PALETTE[(entry.soloColorIndex || 0) % SOLO_TEXT_PALETTE.length];
      drawFittedName(ctx, name, centerX, rowCenter + 1, nameWidth);
    });

    bottom = top - GROUP_GAP;
  }

  if (layout.hidden > 0) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillText(`+${layout.hidden} more`, centerX, bottom - ROW_H / 2);
  }
}

function drawLegendSwatch(ctx, x, y, { fill, stroke, gradient }, label) {
  if (gradient) {
    const grad = ctx.createLinearGradient(0, y + 9, 0, y - 9);
    grad.addColorStop(0, 'rgba(34, 211, 238, 0.65)');
    grad.addColorStop(1, 'rgba(34, 211, 238, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y - 9, 26, 18);
  } else {
    roundRect(ctx, x, y - 9, 26, 18, 4);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.fillStyle = COLORS.muted;
  ctx.font = `16px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 36, y + 1);
  return x + 36 + ctx.measureText(label).width + 40;
}

// One legend entry for main/alt groups and solos, stacked like a slot: unboxed "solo" on top, then
// the group box holding "alt" above the boxed "Main"
function drawGroupLegend(ctx, x, y) {
  const [group, main] = GROUP_PALETTE[0];
  ctx.font = `16px ${FONT}`;
  const innerW = ctx.measureText('Main').width + 16;
  const outerW = innerW + 12;
  const rowH = 22;

  roundRect(ctx, x, y - rowH - 6, outerW, rowH * 2 + 12, 6);
  ctx.fillStyle = withAlpha(group, 0.12);
  ctx.fill();
  ctx.strokeStyle = group;
  ctx.lineWidth = 2;
  ctx.stroke();
  roundRect(ctx, x + 6, y + 1, innerW, rowH - 2, 4);
  ctx.fillStyle = withAlpha(main, 0.16);
  ctx.fill();
  ctx.strokeStyle = main;
  ctx.stroke();

  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('alt', x + outerW / 2, y - rowH / 2);
  ctx.fillText('Main', x + outerW / 2, y + rowH / 2 + 1);
  // Solo accounts stack above groups in a slot, unboxed
  ctx.fillText('solo', x + outerW / 2, y - rowH - 6 - 13);
  ctx.textAlign = 'left';
  return x + outerW + 40;
}

const EVENT_BAND_ALPHA = 0.45;

function drawEventBand(ctx, lineY, eventMinutes) {
  const span = WIDTH - PAD_X * 2;
  const colorAt = minutes => {
    const elapsed = ((minutes - eventMinutes) % 1440 + 1440) % 1440;
    return elapsed < 720
      ? withAlpha(EVENT_COLOR, EVENT_BAND_ALPHA * (1 - elapsed / 720))
      : withAlpha(EVENT_END_COLOR, EVENT_BAND_ALPHA * ((elapsed - 720) / 720));
  };

  // Stops every 15 minutes, plus a sharp red-to-green switch at the event time
  const stops = [];
  for (let m = 0; m <= 1440; m += 15) stops.push([m / 1440, colorAt(m % 1440 === eventMinutes ? m - 0.01 : m)]);
  stops.push([eventMinutes / 1440, withAlpha(EVENT_END_COLOR, EVENT_BAND_ALPHA)]);
  stops.push([eventMinutes / 1440, withAlpha(EVENT_COLOR, EVENT_BAND_ALPHA)]);
  stops.sort((a, b) => a[0] - b[0]);

  // Drawn on its own canvas so the part over the hour labels can fade out downwards without touching the board
  // Full strength for the first rows under the timeline, then an eased fade well past the hour labels
  const solidH = 18;
  const fadeH = 62;
  const band = createCanvas(Math.ceil(span), solidH + fadeH);
  const bandCtx = band.getContext('2d');
  const gradient = bandCtx.createLinearGradient(0, 0, span, 0);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  bandCtx.fillStyle = gradient;
  bandCtx.fillRect(0, 0, span, solidH + fadeH);

  const fade = bandCtx.createLinearGradient(0, 0, 0, solidH + fadeH);
  fade.addColorStop(0, 'rgba(0, 0, 0, 1)');
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const alpha = (1 + Math.cos(Math.PI * t)) / 2; // cosine ease: no hard start or end to the fade
    fade.addColorStop((solidH + t * fadeH) / (solidH + fadeH), `rgba(0, 0, 0, ${alpha.toFixed(3)})`);
  }
  bandCtx.globalCompositeOperation = 'destination-in';
  bandCtx.fillStyle = fade;
  bandCtx.fillRect(0, 0, span, solidH + fadeH);

  ctx.drawImage(band, PAD_X, lineY + 3);
}

// Legend entry for a line hanging below the timeline, drawn with the same style
function drawLineLegend(ctx, x, y, style, label) {
  drawHangingLine(ctx, x + 3, y - 12, y + 12, style);

  ctx.fillStyle = COLORS.muted;
  ctx.font = `16px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 18, y + 1);
  return x + 18 + ctx.measureText(label).width + 40;
}

/**
 * Renders the 24-hour UTC timeline.
 * data: { guildName, columns[24]: { hour, entries[], people, accounts }, stats, now }
 */
export async function renderQSTimeline(data) {
  const now = data.now || new Date();
  const currentHour = now.getUTCHours();
  const layouts = data.columns.map(layoutColumn);
  const stackH = Math.max(MIN_STACK_H, Math.max(...layouts.map(l => l.height)) + 40 + COUNT_ROW_H);
  const lineY = HEADER_H + stackH;
  const height = lineY + AXIS_H;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, height);

  // Header: "<CORP NAME> QS SCHEDULER", shrunk to fit long server names
  const title = `${data.guildName ? `${data.guildName} ` : ''}QS Scheduler`.toUpperCase();
  let titleSize = 44;
  ctx.font = `bold ${titleSize}px ${FONT}`;
  while (titleSize > 26 && ctx.measureText(title).width > WIDTH * 0.55) {
    titleSize -= 2;
    ctx.font = `bold ${titleSize}px ${FONT}`;
  }
  drawGlowText(ctx, title, PAD_X, 70, { font: `bold ${titleSize}px ${FONT}` });
  ctx.fillStyle = COLORS.muted;
  ctx.font = `22px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  // At 22px this line is about as wide as a "QUILLIANCE QS SCHEDULER" title
  const nowText = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  ctx.fillText(`Corp availability timeline · all times UTC · Updated ${nowText} UTC`, PAD_X, 108);

  const { stats } = data;
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 24px ${FONT}`;
  ctx.fillText(`👤 ${stats.people} players   🎮 ${stats.accounts} accounts`, WIDTH - PAD_X, 70);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `22px ${FONT}`;
  ctx.fillText(`⌀ ${stats.avgPeoplePerHour.toFixed(1)} players/hour`, WIDTH - PAD_X, 108);

  // Current hour: a fade rising from the timeline
  const nowX = PAD_X + currentHour * COL_W;
  const glow = ctx.createLinearGradient(0, lineY, 0, HEADER_H);
  glow.addColorStop(0, 'rgba(34, 211, 238, 0.42)');
  glow.addColorStop(0.5, 'rgba(34, 211, 238, 0.12)');
  glow.addColorStop(1, 'rgba(34, 211, 238, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(nowX + 1, HEADER_H, COL_W - 2, lineY - HEADER_H);

  // Faint hour guides
  ctx.strokeStyle = COLORS.guide;
  ctx.lineWidth = 1;
  for (let h = 0; h <= 24; h++) {
    const x = Math.round(PAD_X + h * COL_W) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, HEADER_H);
    ctx.lineTo(x, lineY);
    ctx.stroke();
  }

  layouts.forEach((layout, h) => drawColumn(ctx, layout, PAD_X + h * COL_W, lineY));

  if (stats.people === 0) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `24px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No one has added their hours yet. Use /quantum scheduler set', WIDTH / 2, HEADER_H + stackH / 2);
  }

  // Event cycle band between the timeline and the hour labels: strong green right after the event starts,
  // fading out over 12 h (wrapping past 24:00), then red fading in until the event comes round again
  const hasEvent = data.eventTimeMinutes !== null && data.eventTimeMinutes !== undefined;
  if (hasEvent) drawEventBand(ctx, lineY, data.eventTimeMinutes);

  // Timeline and hour splitters
  ctx.strokeStyle = COLORS.line;
  ctx.lineCap = 'round';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(PAD_X - 16, lineY);
  ctx.lineTo(WIDTH - PAD_X + 16, lineY);
  ctx.stroke();

  for (let h = 0; h <= 24; h++) {
    const x = PAD_X + h * COL_W;
    const major = h % 6 === 0;
    ctx.lineWidth = major ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(x, lineY - (major ? 20 : 13));
    ctx.lineTo(x, lineY + (major ? 20 : 13));
    ctx.stroke();
  }

  // Current hour on the timeline: its two splitters and the line between them in cyan, like its labels and column
  ctx.save();
  ctx.strokeStyle = COLORS.now;
  ctx.shadowColor = COLORS.now;
  ctx.shadowBlur = 8;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(PAD_X + currentHour * COL_W, lineY);
  ctx.lineTo(PAD_X + (currentHour + 1) * COL_W, lineY);
  ctx.stroke();
  for (const h of [currentHour, currentHour + 1]) {
    const major = h % 6 === 0;
    ctx.lineWidth = major ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(PAD_X + h * COL_W, lineY - (major ? 20 : 13));
    ctx.lineTo(PAD_X + h * COL_W, lineY + (major ? 20 : 13));
    ctx.stroke();
  }
  ctx.restore();

  // Now marker on the line
  const markerX = PAD_X + (currentHour + now.getUTCMinutes() / 60) * COL_W;
  ctx.save();
  ctx.fillStyle = COLORS.now;
  ctx.shadowColor = COLORS.now;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  // Below the line, pointing up at it, so it never covers the names above
  ctx.moveTo(markerX - 8, lineY + 18);
  ctx.lineTo(markerX + 8, lineY + 18);
  ctx.lineTo(markerX, lineY + 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Event time (the 24 h event starts and ends at the same time of day): a line hanging from the timeline
  // to a little below the hour labels, drawn before them so the labels stay on top. The 8 h splits divide
  // the event day into three equal parts.
  if (hasEvent) {
    const xAt = minutes => PAD_X + ((minutes % 1440) / 60) * COL_W;
    for (const offset of [480, 960]) {
      drawHangingLine(ctx, xAt(data.eventTimeMinutes + offset), lineY + 4, lineY + 58, SPLIT_LINE);
    }
    drawHangingLine(ctx, xAt(data.eventTimeMinutes), lineY + 4, lineY + 58, EVENT_LINE);
  }

  // Hour legend under the splitters. A dark outline keeps the labels clearly in front of the event and split lines.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(12, 24, 29, 0.9)';
  for (let h = 0; h <= 24; h++) {
    const active = h === currentHour || h === currentHour + 1;
    const label = h === 24 ? '24:00' : formatHour(h);
    ctx.font = `${active ? 'bold ' : ''}18px ${FONT}`;
    ctx.strokeText(label, PAD_X + h * COL_W, lineY + 48);
    ctx.fillStyle = active ? COLORS.now : COLORS.text;
    ctx.fillText(label, PAD_X + h * COL_W, lineY + 48);
  }

  // Players and accounts per hour, at the top of each slot
  ctx.font = `15px ${FONT}`;
  ctx.textBaseline = 'middle';
  for (const column of data.columns) {
    if (column.people === 0) continue;
    ctx.fillStyle = column.hour === currentHour ? COLORS.now : COLORS.muted;
    ctx.fillText(`👤${column.people} 🎮${column.accounts}`, PAD_X + (column.hour + 0.5) * COL_W, HEADER_H + COUNT_ROW_H / 2);
  }
  ctx.textBaseline = 'alphabetic';

  // Legend
  let legendX = PAD_X;
  const legendY = height - 44;
  legendX = drawGroupLegend(ctx, legendX, legendY);
  legendX = drawLegendSwatch(ctx, legendX, legendY, { gradient: true }, 'Current hour');
  if (data.eventTimeMinutes !== null && data.eventTimeMinutes !== undefined) {
    legendX = drawLineLegend(ctx, legendX, legendY, EVENT_LINE, 'Event start/end');
    legendX = drawLineLegend(ctx, legendX, legendY, SPLIT_LINE, '8h split');
  }
  ctx.fillStyle = COLORS.muted;
  ctx.font = `16px ${FONT}`;
  ctx.fillText('👤 players · 🎮 accounts', legendX, legendY + 1);

  // The one instruction the board needs, in the empty bottom-right corner
  ctx.textAlign = 'right';
  const command = '/quantum scheduler set';
  ctx.font = `bold 18px ${FONT}`;
  const boldWidth = ctx.measureText(command).width;
  roundRect(ctx, WIDTH - PAD_X - boldWidth - 16, legendY - 15, boldWidth + 16, 32, 6);
  ctx.fillStyle = 'rgba(34, 211, 238, 0.14)';
  ctx.fill();
  ctx.fillStyle = COLORS.now;
  ctx.fillText(command, WIDTH - PAD_X - 8, legendY + 1);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `18px ${FONT}`;
  ctx.fillText('Add your hours (in your own timezone) with', WIDTH - PAD_X - boldWidth - 28, legendY + 1);

  return canvas.encode('png');
}
