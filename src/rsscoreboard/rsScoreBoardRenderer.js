import { createCanvas } from '@napi-rs/canvas';

// Fonts come from the font-dejavu and font-noto-emoji Alpine packages installed in the dockerfile
const FONT = '"DejaVu Sans", "Noto Color Emoji", sans-serif';

const WIDTH = 900;
const COLORS = {
  text: '#ffffff',
  muted: '#a59cc4',
  track: '#2e2a5c',
  belowRequirement: '#ff6b6b',
  aboveRequirement: '#ff9f1a',
  redStar: '#f43f5e',
  darkRedStar: '#ff4d6d',
  normalStar: '#c084fc',
  met: '#4ade80',
  footer: '#ff6a1a'
};
const MEDALS = { 1: '#facc15', 2: '#d4d4d8', 3: '#f59e0b' };

function formatNumber(num) {
  return Math.round(num || 0).toLocaleString('en-US');
}

function formatShort(num) {
  const n = Math.round(num || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return days > 0 ? `${days}D ${hours}H` : `${hours}H ${minutes}M`;
}

function formatUTC(date) {
  return new Date(date).toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
}

function starLabel(dark, level) {
  return `${dark ? 'DRS' : 'RS'} ${level}`;
}

// Deterministic PRNG so the starfield doesn't change between edits of the same board
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function drawBackground(ctx, height, seed) {
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#1a0f2e');
  bg.addColorStop(0.6, '#120c26');
  bg.addColorStop(1, '#0a0b1e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, height);

  const random = seededRandom(seed);
  const starCount = Math.round((WIDTH * height) / 9000);
  for (let i = 0; i < starCount; i++) {
    ctx.globalAlpha = 0.25 + random() * 0.6;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(random() * WIDTH, random() * height, random() < 0.9 ? 0.8 : 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawGlowText(ctx, text, x, y, { font, color = COLORS.text, glow = '#ff2a4d', blur = 18, align = 'center' }) {
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

function drawRedStarIcon(ctx, x, y, radius) {
  const grad = ctx.createRadialGradient(x - radius / 3, y - radius / 3, 1, x, y, radius);
  grad.addColorStop(0, '#ffd27a');
  grad.addColorStop(0.45, '#ff5a1f');
  grad.addColorStop(1, '#b3121f');
  ctx.save();
  ctx.shadowColor = '#ff3b1f';
  ctx.shadowBlur = 8;
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = '#5c0a12';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(trimmed + '…').width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed + '…';
}

function drawChip(ctx, x, y, text, color) {
  ctx.font = `bold 14px ${FONT}`;
  const width = ctx.measureText(text).width + 24;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.beginPath();
  ctx.roundRect(x, y, width, 30, 15);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 12, y + 20);
  return width;
}

// Event header: number, corp total vs goal, countdown, runs per star type and level
export async function renderRSSummaryImage(data) {
  const { event, totalCorpPoints, eventGoal, totalRuns, runsByStar, nonEventRunCount, lastNonEventRunAt, nextEvent, now } = data;

  // Lay the run chips out first to know the height
  const measure = createCanvas(10, 10).getContext('2d');
  measure.font = `bold 14px ${FONT}`;
  const chips = [
    ...runsByStar.map(s => ({ text: `${starLabel(s.dark, s.level)} × ${s.runs}`, color: s.dark ? COLORS.darkRedStar : COLORS.normalStar })),
    { text: `TOTAL × ${totalRuns}`, color: COLORS.text }
  ];
  const lines = [[]];
  let lineWidth = 0;
  for (const chip of chips) {
    chip.width = measure.measureText(chip.text).width + 24;
    if (lineWidth + chip.width > WIDTH - 120 && lines[lines.length - 1].length > 0) {
      lines.push([]);
      lineWidth = 0;
    }
    lines[lines.length - 1].push(chip);
    lineWidth += chip.width + 10;
  }

  const chipsTop = 262;
  const height = chipsTop + lines.length * 40 + 50;
  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, height, (event?.number || 0) * 7919 + 17);

  const title = event ? `RED STAR EVENT #${event.number}` : 'RED STAR EVENT';
  drawGlowText(ctx, title, WIDTH / 2, 70, { font: `bold 42px ${FONT}` });

  ctx.fillStyle = COLORS.muted;
  ctx.font = `600 15px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText((data.corpName || '').toUpperCase(), WIDTH / 2, 100);

  // Corp progress toward the goal
  const barX = 100;
  const barW = WIDTH - 200;
  const barY = 120;
  ctx.fillStyle = COLORS.track;
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, 12, 6);
  ctx.fill();

  const ratio = eventGoal > 0 ? Math.min(totalCorpPoints / eventGoal, 1) : (totalCorpPoints > 0 ? 1 : 0);
  if (ratio > 0) {
    const fill = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    fill.addColorStop(0, '#ff7a00');
    fill.addColorStop(1, '#ffb300');
    ctx.save();
    ctx.shadowColor = '#ff8c00';
    ctx.shadowBlur = 10;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(barX, barY, Math.max(barW * ratio, 12), 12, 6);
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 19px ${FONT}`;
  ctx.textAlign = 'center';
  const progressText = eventGoal > 0
    ? `${formatNumber(totalCorpPoints)} / ${formatNumber(eventGoal)} (${((totalCorpPoints / eventGoal) * 100).toFixed(1)}%)`
    : `${formatNumber(totalCorpPoints)} POINTS`;
  ctx.fillText(progressText, WIDTH / 2, 162);

  let statusText;
  let statusColor = '#ff4d4d';
  if (event?.active) {
    statusText = `ENDS IN ${formatDuration(event.end - now)}`;
  } else if (event) {
    statusText = `ENDED · NEXT EVENT IN ${formatDuration(nextEvent.start - now)}`;
    statusColor = COLORS.muted;
  } else {
    statusText = `NO EVENT RECORDED YET · NEXT EVENT IN ${formatDuration(nextEvent.start - now)}`;
    statusColor = COLORS.muted;
  }
  drawGlowText(ctx, statusText, WIDTH / 2, 205, { font: `bold 20px ${FONT}`, color: statusColor, glow: statusColor, blur: 6 });

  ctx.fillStyle = COLORS.muted;
  ctx.font = `bold 12px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('RUNS COMPLETED', WIDTH / 2, chipsTop - 12);

  lines.forEach((line, i) => {
    const total = line.reduce((sum, chip) => sum + chip.width, 0) + (line.length - 1) * 10;
    let x = (WIDTH - total) / 2;
    for (const chip of line) {
      x += drawChip(ctx, x, chipsTop + i * 40, chip.text, chip.color) + 10;
    }
  });

  ctx.fillStyle = '#7c739c';
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = 'center';
  const lastText = lastNonEventRunAt ? ` · last ${formatUTC(lastNonEventRunAt)}` : '';
  ctx.fillText(`Non-event runs logged: ${nonEventRunCount || 0}${lastText} · Updated ${formatUTC(now)}`, WIDTH / 2, height - 20);

  return canvas.toBuffer('image/png');
}

function drawProgressBar(ctx, x, y, width, height, player, scale) {
  const toX = points => x + (Math.min(points, scale) / scale) * width;
  const required = player.tier?.required || 0;
  const requiredX = required > 0 ? toX(required) : null;

  ctx.fillStyle = COLORS.track;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, height / 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, height / 2);
  ctx.clip();

  // One segment per star type and level, light red up to the requirement and orange beyond it
  let cumulative = 0;
  player.segments.forEach((segment, i) => {
    const x0 = toX(cumulative);
    cumulative += segment.points;
    const x1 = toX(cumulative);
    ctx.globalAlpha = i % 2 === 0 ? 1 : 0.82;

    const splitX = requiredX === null ? x1 : Math.min(Math.max(requiredX, x0), x1);
    ctx.fillStyle = COLORS.belowRequirement;
    ctx.fillRect(x0, y, splitX - x0, height);
    if (splitX < x1) {
      ctx.fillStyle = COLORS.aboveRequirement;
      ctx.fillRect(splitX, y, x1 - splitX, height);
    }
    ctx.globalAlpha = 1;

    if (i < player.segments.length - 1) {
      ctx.fillStyle = 'rgba(20, 12, 40, 0.75)';
      ctx.fillRect(x1 - 1, y, 2, height);
    }

    const label = `${starLabel(segment.dark, segment.level).replace(' ', '')} ${formatShort(segment.points)}`;
    ctx.font = `bold 10px ${FONT}`;
    if (ctx.measureText(label).width + 10 <= x1 - x0) {
      ctx.fillStyle = '#2a0710';
      ctx.textAlign = 'left';
      ctx.fillText(label, x0 + 5, y + height - 4);
    }
  });
  ctx.restore();

  // Requirement threshold marker
  if (requiredX !== null) {
    ctx.save();
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(requiredX - 1.5, y - 5, 3, height + 10);
    ctx.restore();
  }
}

// One page of up to 10 ranked players
export async function renderRSRankingPage({ eventNumber, firstRank, players, scale }) {
  const headerHeight = 120;
  const rowHeight = 70;
  const footerHeight = 40;
  const rows = Math.max(players.length, 1);
  const height = headerHeight + rows * rowHeight + footerHeight;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, height, (eventNumber || 0) * 104729 + firstRank);

  const band = ctx.createLinearGradient(0, 0, 0, headerHeight);
  band.addColorStop(0, 'rgba(70, 8, 24, 0.75)');
  band.addColorStop(1, 'rgba(70, 8, 24, 0.15)');
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, WIDTH, headerHeight);

  const lastRank = firstRank + players.length - 1;
  const title = `RED STAR EVENT${eventNumber ? ` #${eventNumber}` : ''} | TOP ${firstRank}-${Math.max(lastRank, firstRank)}`;
  drawGlowText(ctx, title, WIDTH / 2, 74, { font: `bold 36px ${FONT}` });

  if (players.length === 0) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `16px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('No contributions recorded yet', WIDTH / 2, headerHeight + 42);
  }

  players.forEach((player, i) => {
    const rank = firstRank + i;
    const top = headerHeight + i * rowHeight;

    if (i % 2 === 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.fillRect(0, top, WIDTH, rowHeight);
    }

    // Rank, glowing for the podium
    if (MEDALS[rank]) {
      drawGlowText(ctx, `${rank}`, 40, top + 36, { font: `bold 24px ${FONT}`, color: MEDALS[rank], glow: MEDALS[rank], blur: 14 });
    } else {
      ctx.fillStyle = COLORS.text;
      ctx.font = `bold 19px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(`${rank}`, 40, top + 35);
    }

    // Points with red star icon, right aligned
    ctx.font = `bold 21px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.text;
    const pointsText = formatNumber(player.totalPoints);
    ctx.fillText(pointsText, 870, top + 33);
    const pointsWidth = ctx.measureText(pointsText).width;
    drawRedStarIcon(ctx, 870 - pointsWidth - 16, top + 26, 9);

    // Tier chip after the name
    let tierText = '';
    let tierColor = '';
    if (player.tier) {
      const met = player.totalPoints >= player.tier.required;
      tierText = `${starLabel(player.tier.dark, player.tier.level)} · ${formatShort(player.tier.required)}${met ? ' ✓' : ''}`;
      tierColor = met ? COLORS.met : '#fda4af';
    }
    ctx.font = `bold 12px ${FONT}`;
    const tierWidth = tierText ? ctx.measureText(tierText).width + 18 : 0;

    ctx.font = `500 21px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    const nameMax = (870 - pointsWidth - 40) - 80 - tierWidth - 12;
    const name = fitText(ctx, player.playerName, nameMax);
    ctx.fillText(name, 80, top + 33);

    if (tierText) {
      const nameWidth = ctx.measureText(name).width;
      const chipX = 80 + nameWidth + 12;
      ctx.font = `bold 12px ${FONT}`;
      ctx.strokeStyle = tierColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(chipX, top + 16, tierWidth, 22, 11);
      ctx.stroke();
      ctx.fillStyle = tierColor;
      ctx.fillText(tierText, chipX + 9, top + 31);
    }

    drawProgressBar(ctx, 80, top + 45, 790, 15, player, scale);
  });

  // Footer band
  ctx.fillStyle = 'rgba(30, 30, 36, 0.9)';
  ctx.fillRect(0, height - footerHeight, WIDTH, footerHeight);
  ctx.fillStyle = COLORS.footer;
  ctx.font = `13px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('GENERATED BY QUILLIANCE CORSAIR', WIDTH / 2, height - 14);

  return canvas.toBuffer('image/png');
}
