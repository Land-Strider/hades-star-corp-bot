import fs from 'fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

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
  darkRedStar: '#c084fc',
  normalStar: '#ff4d6d',
  met: '#4ade80',
  footer: '#ff6a1a'
};
const MEDALS = { 1: '#facc15', 2: '#d4d4d8', 3: '#f59e0b' };

// The bot's StarRed application emoji (id 1564626851278626937), bundled so rendering needs no network
const RED_STAR_ICON_URL = new URL('./assets/red_star.png', import.meta.url);
let redStarIcon;

async function getRedStarIcon() {
  if (redStarIcon === undefined) {
    try {
      redStarIcon = await loadImage(fs.readFileSync(RED_STAR_ICON_URL));
    } catch (err) {
      console.error('[RSScoreBoard] Could not load the StarRed icon, drawing a fallback:', err);
      redStarIcon = null;
    }
  }
  return redStarIcon;
}

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
  return days > 0 ? `${days}D ${hours}H ${minutes}M` : `${hours}H ${minutes}M`;
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

function drawRedStarIcon(ctx, x, y, size, icon) {
  if (icon) {
    ctx.drawImage(icon, x - size / 2, y - size / 2, size, size);
    return;
  }
  const radius = size / 3;
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

// Event header: number, corp total vs goal, countdown, runs per star type and level
export async function renderRSSummaryImage(data) {
  const { event, totalCorpPoints, eventGoal, totalRuns, runsByStar, nonEventRunCount, lastNonEventRunAt, nextEvent, now } = data;

  const runsTop = 250;
  const height = runsTop + (runsByStar.length > 0 ? 160 : 90) + 40;
  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, height, (event?.number || 0) * 7919 + 17);
  const icon = await getRedStarIcon();

  drawGlowText(ctx, 'RED STAR EVENT', WIDTH / 2, 70, { font: `bold 42px ${FONT}` });
  ctx.font = `bold 42px ${FONT}`;
  const titleHalf = ctx.measureText('RED STAR EVENT').width / 2;
  drawRedStarIcon(ctx, WIDTH / 2 - titleHalf - 38, 55, 54, icon);
  drawRedStarIcon(ctx, WIDTH / 2 + titleHalf + 38, 55, 54, icon);

  ctx.fillStyle = COLORS.muted;
  ctx.font = `600 15px ${FONT}`;
  ctx.textAlign = 'center';
  const subtitle = [event ? `SEASON ${event.number}` : '', data.corpName || ''].filter(Boolean).join(' · ');
  ctx.fillText(subtitle.toUpperCase(), WIDTH / 2, 100);

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
    statusText = `SEASON ${event.number} ENDS IN ${formatDuration(event.end - now)}`;
  } else if (event) {
    statusText = `SEASON ${event.number} ENDED · SEASON ${nextEvent.number} STARTS IN ${formatDuration(nextEvent.start - now)}`;
    statusColor = COLORS.muted;
  } else {
    statusText = `SEASON ${nextEvent.number} STARTS IN ${formatDuration(nextEvent.start - now)}`;
    statusColor = COLORS.muted;
  }
  drawGlowText(ctx, statusText, WIDTH / 2, 205, { font: `bold 20px ${FONT}`, color: statusColor, glow: statusColor, blur: event?.active ? 6 : 0 });

  ctx.fillStyle = COLORS.muted;
  ctx.font = `bold 12px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('RUNS COMPLETED', WIDTH / 2, runsTop);

  // One column per star type and level: run count in large type above its label
  let totalTop = runsTop + 20;
  if (runsByStar.length > 0) {
    const columnWidth = Math.min(96, (WIDTH - 80) / runsByStar.length);
    const startX = (WIDTH - columnWidth * runsByStar.length) / 2;
    runsByStar.forEach((s, i) => {
      const cx = startX + columnWidth * (i + 0.5);
      const style = levelStyle(s.dark, s.level);
      drawGlowText(ctx, `${s.runs}`, cx, runsTop + 44, { font: `bold 30px ${FONT}`, color: style.color, glow: style.glow, blur: style.blur });
      ctx.fillStyle = s.dark ? COLORS.darkRedStar : COLORS.normalStar;
      ctx.font = `bold 13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(starLabel(s.dark, s.level), cx, runsTop + 64);
    });

    ctx.strokeStyle = 'rgba(165, 156, 196, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(WIDTH / 2 - 160, runsTop + 82);
    ctx.lineTo(WIDTH / 2 + 160, runsTop + 82);
    ctx.stroke();
    totalTop = runsTop + 90;
  }

  drawGlowText(ctx, `${totalRuns}`, WIDTH / 2, totalTop + 38, { font: `bold 36px ${FONT}`, glow: '#ff2a4d', blur: 10 });
  ctx.fillStyle = COLORS.muted;
  ctx.font = `bold 13px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('TOTAL RUNS', WIDTH / 2, totalTop + 58);

  ctx.fillStyle = '#7c739c';
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = 'center';
  const lastText = lastNonEventRunAt ? ` · last ${formatUTC(lastNonEventRunAt)}` : '';
  ctx.fillText(`Non-event runs logged: ${nonEventRunCount || 0}${lastText} · Updated ${formatUTC(now)}`, WIDTH / 2, height - 20);

  return canvas.toBuffer('image/png');
}

// Level label colors: Red Star in fiery reds, Dark Red Star in violets, brighter and glowing more at higher levels
function levelStyle(dark, level) {
  const t = Math.min(Math.max((level - 7) / 5, 0), 1);
  const mix = (a, b) => Math.round(a + (b - a) * t);
  const [from, to] = dark
    ? [[178, 160, 214], [205, 120, 255]]
    : [[214, 128, 128], [255, 70, 40]];
  return {
    color: `rgb(${mix(from[0], to[0])}, ${mix(from[1], to[1])}, ${mix(from[2], to[2])})`,
    glow: dark ? '#a020ff' : '#ff2a00',
    blur: t * 7
  };
}

function levelLabels(dark, level) {
  return { full: `${dark ? 'DRS' : 'RS'}${level}`, short: dark ? `D${level}` : `${level}` };
}

const LABEL_FONT = `bold 10px ${FONT}`;

function pillWidth(ctx, text) {
  ctx.font = LABEL_FONT;
  return ctx.measureText(text).width + 10;
}

function drawLevelPill(ctx, x, barY, barHeight, text, style) {
  const width = pillWidth(ctx, text);
  const height = barHeight - 4;
  ctx.fillStyle = 'rgba(24, 6, 18, 0.8)';
  ctx.beginPath();
  ctx.roundRect(x, barY + 2, width, height, height / 2);
  ctx.fill();

  ctx.save();
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'left';
  ctx.fillStyle = style.color;
  if (style.blur > 0) {
    ctx.shadowColor = style.glow;
    ctx.shadowBlur = style.blur;
    ctx.fillText(text, x + 5, barY + barHeight - 5);
    ctx.shadowBlur = 0;
  }
  ctx.fillText(text, x + 5, barY + barHeight - 5);
  ctx.restore();
}

function drawPointsText(ctx, x, barY, barHeight, text) {
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#3a0a12';
  ctx.fillText(text, x, barY + barHeight - 5);
}

// Pixel widths per segment: proportional to points, but every segment keeps room for its short level
// label. The extra width is taken from segments with room to spare, in proportion to that room.
function layoutSegments(ctx, segments, totalPoints, fillWidth) {
  const natural = segments.map(s => (totalPoints > 0 ? (s.points / totalPoints) * fillWidth : 0));
  const minimum = segments.map(s => pillWidth(ctx, levelLabels(s.dark, s.level).short) + 4);
  if (minimum.reduce((a, b) => a + b, 0) > fillWidth) return natural;

  const deficit = natural.reduce((sum, w, i) => sum + Math.max(minimum[i] - w, 0), 0);
  const surplus = natural.reduce((sum, w, i) => sum + Math.max(w - minimum[i], 0), 0);
  return natural.map((w, i) => (w < minimum[i]
    ? minimum[i]
    : w - (surplus > 0 ? (deficit * (w - minimum[i])) / surplus : 0)));
}

// Each bar is scaled to its own player: the full width is their requirement until they pass it, then
// their total, so the marker starts at the right end and moves left as they exceed it. Players without
// an active tier are scaled against the event's top contributor.
// Returns the x position of the requirement marker, or null when the player has no active tier.
function drawProgressBar(ctx, x, y, width, height, player, leaderPoints) {
  const required = player.tier?.required || 0;
  const scale = Math.max(required > 0 ? Math.max(player.totalPoints, required) : leaderPoints, 1);
  const toX = points => x + (Math.min(points, scale) / scale) * width;
  const requiredX = required > 0 ? Math.min(toX(required), x + width - 2) : null;
  const fillWidth = toX(player.totalPoints) - x;

  ctx.fillStyle = COLORS.track;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, height / 2);
  ctx.fill();

  const widths = layoutSegments(ctx, player.segments, player.totalPoints, fillWidth);
  const bounds = [];
  let cursor = x;
  for (const w of widths) {
    bounds.push([cursor, cursor + w]);
    cursor += w;
  }

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, height / 2);
  ctx.clip();

  // Fills: light red up to the requirement and orange beyond it, segments split by thin gaps
  player.segments.forEach((segment, i) => {
    const [x0, x1] = bounds[i];
    ctx.globalAlpha = i % 2 === 0 ? 1 : 0.86;
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
  });

  // Labels: level pill + points, else level pill only, else the short level (D10 / 10)
  player.segments.forEach((segment, i) => {
    const [x0, x1] = bounds[i];
    const labels = levelLabels(segment.dark, segment.level);
    const style = levelStyle(segment.dark, segment.level);
    const pointsText = formatShort(segment.points);
    ctx.font = LABEL_FONT;
    const pointsWidth = ctx.measureText(pointsText).width;
    const fullPill = pillWidth(ctx, labels.full);
    const left = x0 + 4;
    const right = x1 - 4;

    // When the requirement line crosses this segment, centre the line in the gap between level and points
    if (requiredX !== null && requiredX > x0 && requiredX < x1) {
      const pillX = requiredX - 7 - fullPill;
      const pointsX = requiredX + 7;
      if (pillX >= left && pointsX + pointsWidth <= right) {
        drawLevelPill(ctx, pillX, y, height, labels.full, style);
        drawPointsText(ctx, pointsX, y, height, pointsText);
        return;
      }
    }

    // Keep a label off the requirement line by moving it to whichever side of the line has room
    const avoidLine = (labelWidth, preferredX) => {
      if (requiredX === null || requiredX <= x0 || requiredX >= x1) return preferredX;
      if (preferredX >= requiredX + 4 || preferredX + labelWidth <= requiredX - 4) return preferredX;
      if (requiredX + 5 + labelWidth <= x1 - 1) return requiredX + 5;
      if (requiredX - 5 - labelWidth >= x0 + 1) return requiredX - 5 - labelWidth;
      return preferredX;
    };

    const shortPill = pillWidth(ctx, labels.short);
    if (fullPill + 5 + pointsWidth <= right - left) {
      const labelX = avoidLine(fullPill + 5 + pointsWidth, left);
      drawLevelPill(ctx, labelX, y, height, labels.full, style);
      drawPointsText(ctx, labelX + fullPill + 5, y, height, pointsText);
    } else if (fullPill <= right - left) {
      drawLevelPill(ctx, avoidLine(fullPill, left), y, height, labels.full, style);
    } else if (shortPill <= x1 - x0 - 2) {
      drawLevelPill(ctx, avoidLine(shortPill, x0 + 1), y, height, labels.short, style);
    }
  });
  ctx.restore();

  if (requiredX !== null) {
    ctx.save();
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(requiredX - 1.5, y - 5, 3, height + 10);
    ctx.restore();
  }
  return requiredX;
}

// One page of up to 10 ranked players
export async function renderRSRankingPage({ eventNumber, firstRank, players, leaderPoints }) {
  const headerHeight = 120;
  const rowHeight = 70;
  const footerHeight = 40;
  const rows = Math.max(players.length, 1);
  const height = headerHeight + rows * rowHeight + footerHeight;
  const barX = 80;
  const barWidth = 790;
  const pointsRight = 870;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, height, (eventNumber || 0) * 104729 + firstRank);
  const icon = await getRedStarIcon();

  const band = ctx.createLinearGradient(0, 0, 0, headerHeight);
  band.addColorStop(0, 'rgba(70, 8, 24, 0.75)');
  band.addColorStop(1, 'rgba(70, 8, 24, 0.15)');
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, WIDTH, headerHeight);

  const lastRank = Math.max(firstRank + players.length - 1, firstRank);
  drawGlowText(ctx, 'RED STAR EVENT', WIDTH / 2, 40, { font: `bold 16px ${FONT}`, color: COLORS.muted, glow: '#ff2a4d', blur: 8 });
  const title = `${eventNumber ? `SEASON ${eventNumber} | ` : ''}TOP ${firstRank}-${lastRank}`;
  drawGlowText(ctx, title, WIDTH / 2, 86, { font: `bold 36px ${FONT}` });

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
    const pointsWidth = ctx.measureText(pointsText).width;
    ctx.fillText(pointsText, pointsRight, top + 31);
    drawRedStarIcon(ctx, pointsRight - pointsWidth - 18, top + 24, 28, icon);
    const pointsLeft = pointsRight - pointsWidth - 34;

    const requiredX = drawProgressBar(ctx, barX, top + 44, barWidth, 18, player, leaderPoints);

    let tierText = '';
    let tierColor = '';
    let tierWidth = 0;
    if (player.tier) {
      const met = player.totalPoints >= player.tier.required;
      tierText = `${starLabel(player.tier.dark, player.tier.level)} · ${formatShort(player.tier.required)}${met ? ' ✓' : ''}`;
      tierColor = met ? COLORS.met : '#fda4af';
      ctx.font = `bold 12px ${FONT}`;
      tierWidth = ctx.measureText(tierText).width + 18;
    }

    ctx.font = `500 21px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    const name = fitText(ctx, player.playerName, pointsLeft - barX - (tierText ? tierWidth + 24 : 12));
    ctx.fillText(name, barX, top + 31);
    const nameRight = barX + ctx.measureText(name).width;

    if (tierText) {
      // Centred above the requirement marker, pushed aside by the name or the points
      const preferred = (requiredX ?? nameRight) - tierWidth / 2;
      const chipX = Math.min(Math.max(preferred, nameRight + 12), pointsLeft - 12 - tierWidth);
      const chipY = top + 12;
      ctx.strokeStyle = tierColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(chipX, chipY, tierWidth, 22, 11);
      ctx.stroke();
      ctx.font = `bold 12px ${FONT}`;
      ctx.fillStyle = tierColor;
      ctx.fillText(tierText, chipX + 9, chipY + 15);

      // Pointer down to the marker when the chip sits over it
      if (requiredX !== null && requiredX >= chipX + 10 && requiredX <= chipX + tierWidth - 10) {
        ctx.beginPath();
        ctx.moveTo(requiredX - 4, chipY + 23);
        ctx.lineTo(requiredX + 4, chipY + 23);
        ctx.lineTo(requiredX, chipY + 28);
        ctx.closePath();
        ctx.fill();
      }
    }
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
