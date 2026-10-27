import { createCanvas } from '@napi-rs/canvas';

// Fonts come from the font-dejavu and font-noto-emoji Alpine packages installed in the dockerfile
const FONT = '"DejaVu Sans", "Noto Color Emoji", sans-serif';

function formatNumber(num) {
  return (num || 0).toLocaleString('en-US');
}

function formatDate(date) {
  return date ? new Date(date).toISOString().substring(0, 10) : '';
}

// Emoji glyphs aren't available to the canvas, so medals and markers are drawn as shapes
function drawDot(ctx, x, y, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

export async function renderRSScoreBoardImage({ corpName, totalCorpPoints, totalRuns, players, eventStart, eventEnd }) {
  const rowHeight = 44;
  const headerHeight = 190;
  const tableHeaderHeight = 45;
  const paddingBottom = 60;
  const minRows = 10;
  const displayRowsCount = Math.max(players.length, minRows);
  const width = 1000;
  const height = headerHeight + tableHeaderHeight + (displayRowsCount * rowHeight) + paddingBottom;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background Gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0, '#0a0d14');
  bgGrad.addColorStop(0.5, '#121722');
  bgGrad.addColorStop(1, '#07090e');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Outer Border Accent
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, width - 20, height - 20);

  // Top Neon Line Accent
  const neonGrad = ctx.createLinearGradient(40, 0, width - 40, 0);
  neonGrad.addColorStop(0, '#00d2ff');
  neonGrad.addColorStop(0.5, '#3a7bd5');
  neonGrad.addColorStop(1, '#00d2ff');
  ctx.fillStyle = neonGrad;
  ctx.fillRect(40, 14, width - 80, 4);

  // Header Title
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 26px ${FONT}`;
  ctx.textAlign = 'left';
  drawDot(ctx, 50, 51, 10, '#ef4444');
  ctx.fillStyle = '#ffffff';
  ctx.fillText('RED STAR EVENT LEADERBOARD', 70, 60);

  // Corp Subheader
  const subTitle = corpName ? `Corporation: ${corpName}` : 'Corporation Leaderboard';
  ctx.fillStyle = '#94a3b8';
  ctx.font = `500 18px ${FONT}`;
  ctx.fillText(subTitle.toUpperCase(), 40, 90);

  // Event Date Range
  const startText = formatDate(eventStart);
  const endText = formatDate(eventEnd);
  const eventText = !startText
    ? 'NO CORP RS EVENT RECORDED YET'
    : startText === endText ? `EVENT OF ${startText}` : `EVENT ${startText} – ${endText}`;
  ctx.fillStyle = '#64748b';
  ctx.font = `500 15px ${FONT}`;
  ctx.fillText(eventText, 40, 118);

  // Stat Card 1: Total Corp Points
  const card1X = 550;
  const cardY = 40;
  const cardWidth = 190;
  const cardHeight = 65;

  ctx.fillStyle = '#1e293b';
  ctx.beginPath();
  ctx.roundRect(card1X, cardY, cardWidth, cardHeight, 8);
  ctx.fill();
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = `bold 12px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('TOTAL CORP POINTS', card1X + (cardWidth / 2), cardY + 22);

  ctx.fillStyle = '#38bdf8';
  ctx.font = `bold 22px ${FONT}`;
  ctx.fillText(formatNumber(totalCorpPoints), card1X + (cardWidth / 2), cardY + 50);

  // Stat Card 2: Total Runs
  const card2X = 760;
  ctx.fillStyle = '#1e293b';
  ctx.beginPath();
  ctx.roundRect(card2X, cardY, cardWidth, cardHeight, 8);
  ctx.fill();
  ctx.strokeStyle = '#334155';
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = `bold 12px ${FONT}`;
  ctx.fillText('TOTAL RUNS COMPLETED', card2X + (cardWidth / 2), cardY + 22);

  ctx.fillStyle = '#f43f5e';
  ctx.font = `bold 22px ${FONT}`;
  ctx.fillText(`${formatNumber(totalRuns)} Runs`, card2X + (cardWidth / 2), cardY + 50);

  // Table Header Background
  const startY = headerHeight;
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(40, startY, width - 80, tableHeaderHeight);
  ctx.strokeStyle = '#334155';
  ctx.strokeRect(40, startY, width - 80, tableHeaderHeight);

  // Table Header Labels
  ctx.fillStyle = '#cbd5e1';
  ctx.font = `bold 14px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('RANK', 90, startY + 28);

  ctx.textAlign = 'left';
  ctx.fillText('PLAYER NAME', 180, startY + 28);

  ctx.textAlign = 'right';
  ctx.fillText('TOTAL EVENT POINTS', 560, startY + 28);
  ctx.fillText('RUNS', 720, startY + 28);
  ctx.fillText('HIGHEST RS', 900, startY + 28);

  // Render Rows
  let currentY = startY + tableHeaderHeight;

  for (let i = 0; i < displayRowsCount; i++) {
    const player = players[i];
    const rank = i + 1;

    // Row Background Styling
    if (rank === 1 && player) {
      ctx.fillStyle = 'rgba(234, 179, 8, 0.15)';
    } else if (rank === 2 && player) {
      ctx.fillStyle = 'rgba(203, 213, 225, 0.12)';
    } else if (rank === 3 && player) {
      ctx.fillStyle = 'rgba(217, 119, 6, 0.12)';
    } else if (i % 2 === 0) {
      ctx.fillStyle = '#0f172a';
    } else {
      ctx.fillStyle = '#161e2e';
    }
    ctx.fillRect(40, currentY, width - 80, rowHeight);

    // Row Border Bottom
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, currentY + rowHeight);
    ctx.lineTo(width - 40, currentY + rowHeight);
    ctx.stroke();

    if (player) {
      // Rank Text / Badge
      ctx.textAlign = 'center';
      ctx.font = `bold 15px ${FONT}`;
      const medalColors = { 1: '#facc15', 2: '#e2e8f0', 3: '#fb923c' };
      if (medalColors[rank]) {
        drawDot(ctx, 90, currentY + rowHeight / 2, 14, medalColors[rank]);
        ctx.fillStyle = '#0f172a';
        ctx.fillText(`${rank}`, 90, currentY + 28);
      } else {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(`#${rank}`, 90, currentY + 28);
      }

      // Player Name
      ctx.textAlign = 'left';
      ctx.fillStyle = rank <= 3 ? '#ffffff' : '#e2e8f0';
      ctx.font = rank <= 3 ? `bold 16px ${FONT}` : `500 15px ${FONT}`;
      ctx.fillText(player.playerName, 180, currentY + 28);

      // Points Earned
      ctx.textAlign = 'right';
      ctx.fillStyle = '#38bdf8';
      ctx.font = `bold 16px ${FONT}`;
      ctx.fillText(formatNumber(player.totalPoints), 560, currentY + 28);

      // Runs Contributed
      ctx.fillStyle = '#cbd5e1';
      ctx.font = `500 15px ${FONT}`;
      ctx.fillText(`${player.runsCount}`, 720, currentY + 28);

      // Highest RS Level
      const rsLevelText = player.isDarkRS ? `DRS ${player.maxStarLevel}` : `RS ${player.maxStarLevel}`;
      ctx.fillStyle = player.isDarkRS ? '#f43f5e' : '#a855f7';
      ctx.font = `bold 14px ${FONT}`;
      ctx.fillText(rsLevelText, 900, currentY + 28);
    } else {
      // Empty Placeholder Row
      ctx.textAlign = 'center';
      ctx.fillStyle = '#334155';
      ctx.font = `14px ${FONT}`;
      ctx.fillText(`-`, 90, currentY + 28);
    }

    currentY += rowHeight;
  }

  // Footer Timestamp
  ctx.fillStyle = '#64748b';
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('Hades\' Star Corporation Event Tracker • Run points are split evenly between contributors', 40, height - 20);

  ctx.textAlign = 'right';
  ctx.fillText(new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC', width - 40, height - 20);

  return canvas.toBuffer('image/png');
}

