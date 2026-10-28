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
const AXIS_H = 170;
// Rows drawn per hour column before the rest collapse into "+N more"
const MAX_ROWS = 40;

const COLORS = {
  text: '#eef4ff',
  muted: '#8fa3c7',
  line: '#e6ecf7',
  guide: 'rgba(148, 163, 214, 0.08)',
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

function drawBackground(ctx, height) {
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#0b1430');
  bg.addColorStop(0.6, '#0a1026');
  bg.addColorStop(1, '#070a1a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, height);

  const random = seededRandom(24);
  const starCount = Math.round((WIDTH * height) / 9000);
  for (let i = 0; i < starCount; i++) {
    ctx.globalAlpha = 0.2 + random() * 0.5;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(random() * WIDTH, random() * height, random() < 0.9 ? 0.8 : 1.5, 0, Math.PI * 2);
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

function entryHeight(entry) {
  return entry.names.length * ROW_H + (entry.hasAlts ? GROUP_PAD * 2 : 0);
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
    if (entry.hasAlts) {
      ctx.fillStyle = withAlpha(colors.group, 0.12);
      roundRect(ctx, colX + 5, top, COL_W - 10, height, 7);
      ctx.fill();
      ctx.strokeStyle = colors.group;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Main account sits nearest the line, alts stack above it
    entry.names.forEach((name, i) => {
      const rowBottom = bottom - (entry.hasAlts ? GROUP_PAD : 0) - i * ROW_H;
      const rowCenter = rowBottom - ROW_H / 2;

      if (entry.hasAlts && name === entry.main) {
        ctx.fillStyle = withAlpha(colors.main, 0.16);
        roundRect(ctx, colX + 9, rowBottom - ROW_H + 2, COL_W - 18, ROW_H - 4, 5);
        ctx.fill();
        ctx.strokeStyle = colors.main;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.fillStyle = COLORS.text;
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

/**
 * Renders the 24-hour UTC timeline.
 * data: { guildName, columns[24]: { hour, entries[], people, accounts }, stats, now }
 */
export async function renderQSTimeline(data) {
  const now = data.now || new Date();
  const currentHour = now.getUTCHours();
  const layouts = data.columns.map(layoutColumn);
  const stackH = Math.max(MIN_STACK_H, Math.max(...layouts.map(l => l.height)) + 40);
  const lineY = HEADER_H + stackH;
  const height = lineY + AXIS_H;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, height);

  // Header
  drawGlowText(ctx, 'QUANTUM SCHEDULER', PAD_X, 70, { font: `bold 44px ${FONT}` });
  ctx.fillStyle = COLORS.muted;
  ctx.font = `22px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${data.guildName ? `${data.guildName} · ` : ''}Corp availability timeline · all times UTC`, PAD_X, 108);

  const { stats } = data;
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 24px ${FONT}`;
  ctx.fillText(`👤 ${stats.people} members   🎮 ${stats.accounts} accounts   ⌀ ${stats.avgPeoplePerHour.toFixed(1)} members/hour`, WIDTH - PAD_X, 70);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `20px ${FONT}`;
  const nowText = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  ctx.fillText(`Updated ${nowText} UTC`, WIDTH - PAD_X, 108);

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

  // Now marker on the line
  const markerX = PAD_X + (currentHour + now.getUTCMinutes() / 60) * COL_W;
  ctx.save();
  ctx.fillStyle = COLORS.now;
  ctx.shadowColor = COLORS.now;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(markerX - 8, lineY - 18);
  ctx.lineTo(markerX + 8, lineY - 18);
  ctx.lineTo(markerX, lineY - 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Hour legend under the splitters
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let h = 0; h <= 24; h++) {
    const active = h === currentHour || h === currentHour + 1;
    ctx.fillStyle = active ? COLORS.now : COLORS.text;
    ctx.font = `${active ? 'bold ' : ''}18px ${FONT}`;
    ctx.fillText(h === 24 ? '24:00' : formatHour(h), PAD_X + h * COL_W, lineY + 48);
  }

  // Members and accounts per hour, centred in each slot
  ctx.font = `15px ${FONT}`;
  for (const column of data.columns) {
    if (column.people === 0) continue;
    ctx.fillStyle = column.hour === currentHour ? COLORS.now : COLORS.muted;
    ctx.fillText(`👤${column.people} 🎮${column.accounts}`, PAD_X + (column.hour + 0.5) * COL_W, lineY + 84);
  }

  // Legend
  let legendX = PAD_X;
  const legendY = height - 34;
  const [firstGroup, firstMain] = GROUP_PALETTE[0];
  legendX = drawLegendSwatch(ctx, legendX, legendY, { fill: withAlpha(firstGroup, 0.12), stroke: firstGroup }, 'One member\'s accounts (colour per member)');
  legendX = drawLegendSwatch(ctx, legendX, legendY, { fill: withAlpha(firstMain, 0.16), stroke: firstMain }, 'Main account');
  legendX = drawLegendSwatch(ctx, legendX, legendY, { gradient: true }, 'Current hour');
  ctx.fillStyle = COLORS.muted;
  ctx.font = `16px ${FONT}`;
  ctx.fillText('👤 members · 🎮 game accounts per hour', legendX, legendY + 1);

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
