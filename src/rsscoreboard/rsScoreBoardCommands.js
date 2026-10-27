import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits
} from 'discord.js';
import { getRSScoreBoardConfig, saveRSScoreBoardConfig, tierKey, TIER_LEVELS } from './rsScoreBoardConfig.js';
import { renderRSSummaryImage, renderRSRankingPage } from './rsScoreBoardRenderer.js';
import { getEventWindow, getNextEventWindow, isEventWindowActive } from './rsEventSchedule.js';

const PLAYERS_PER_PAGE = 10;
// Discord allows 10 embeds per message: one summary image + up to 9 ranking pages
const MAX_RANKING_PAGES = 9;

// Requirement modals: Discord modals hold at most 5 inputs, so each covers 3 levels of one star type
const REQUIREMENT_GROUPS = {
  RS_7: { dark: false, levels: [7, 8, 9] },
  RS_10: { dark: false, levels: [10, 11, 12] },
  DRS_7: { dark: true, levels: [7, 8, 9] },
  DRS_10: { dark: true, levels: [10, 11, 12] }
};

export const rsScoreBoardCommand = new SlashCommandBuilder()
  .setName('rsboard')
  .setDescription('Manage and view the RS Event Scoreboard')
  .addSubcommand(sub =>
    sub.setName('view')
      .setDescription('Generate and view the leaderboard of the current or most recent Corp RS Event')
  )
  .addSubcommand(sub =>
    sub.setName('config')
      .setDescription('Open the RS Event Scoreboard configuration menu')
  );

function starLabel(darkRedStar, starLevel) {
  return `${darkRedStar ? 'DRS' : 'RS'} ${starLevel}`;
}

function formatPoints(value) {
  return Math.round(value || 0).toLocaleString('en-US');
}

// Accepts "300000", "300,000", "300.000", "300k", "1.5m". Empty = 0 (inactive). Returns null if invalid.
export function parsePointsInput(raw) {
  const text = (raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (text === '' || text === '0' || text === '-') return 0;

  const match = text.match(/^(\d[\d.,]*)([km]?)$/);
  if (!match) return null;

  const [, numberPart, suffix] = match;
  let value;
  if (suffix) {
    value = parseFloat(numberPart.replace(',', '.')) * (suffix === 'k' ? 1_000 : 1_000_000);
  } else {
    value = parseInt(numberPart.replace(/[.,]/g, ''), 10);
  }
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

// A player's requirement tier for one event: the highest active Dark Red Star level they ran,
// or, if they ran no active Dark Red Star tier, the highest active Red Star level.
export function assignTier(segments, tierRequirements) {
  const active = segments.filter(s => (tierRequirements[tierKey(s.dark, s.level)] || 0) > 0);
  const darkActive = active.filter(s => s.dark);
  const candidates = darkActive.length > 0 ? darkActive : active;
  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) => (b.level > a.level ? b : a));
  return {
    dark: best.dark,
    level: best.level,
    required: tierRequirements[tierKey(best.dark, best.level)]
  };
}

// Leaderboard for one Corp RS Event (defaults to the guild's most recent event).
// Each run's RSEventPoints are split evenly between its contributors.
export async function getRSLeaderboardData(pool, guildId, eventId = null) {
  const config = await getRSScoreBoardConfig(pool, guildId);
  const now = new Date();

  const base = {
    corpName: 'Quilliance',
    eventGoal: config.eventGoal,
    nonEventRunCount: config.nonEventRunCount,
    lastNonEventRunAt: config.lastNonEventRunAt,
    nextEvent: getNextEventWindow(now),
    now
  };

  const eventRes = await pool.query(
    `SELECT event_id, started_at, last_run_at FROM rs_events
     WHERE guild_id = $1 AND ($2::int IS NULL OR event_id = $2)
     ORDER BY started_at DESC
     LIMIT 1`,
    [guildId, eventId]
  );
  const event = eventRes.rows[0];

  if (!event) {
    return { ...base, event: null, totalCorpPoints: 0, totalRuns: 0, runsByStar: [], players: [] };
  }

  const window = getEventWindow(event.started_at);

  const runsRes = await pool.query(
    `SELECT run_id, star_level, dark_red_star, rs_event_points, participant_count, timestamp, corporation_name
     FROM rs_event_runs
     WHERE event_id = $1
     ORDER BY timestamp`,
    [event.event_id]
  );

  const participantsRes = await pool.query(
    `SELECT p.run_id, p.player_id, p.player_name
     FROM rs_event_participants p
     JOIN rs_event_runs r ON p.run_id = r.run_id
     WHERE r.event_id = $1`,
    [event.event_id]
  );

  const runsById = new Map(runsRes.rows.map(r => [r.run_id, r]));
  const runsByStar = new Map();
  let totalCorpPoints = 0;
  let corpName = null;

  for (const run of runsRes.rows) {
    totalCorpPoints += run.rs_event_points;
    if (run.corporation_name) corpName = run.corporation_name;

    const key = tierKey(run.dark_red_star, run.star_level);
    const entry = runsByStar.get(key) || { dark: run.dark_red_star, level: run.star_level, runs: 0 };
    entry.runs++;
    runsByStar.set(key, entry);
  }

  const players = new Map();
  for (const row of participantsRes.rows) {
    const run = runsById.get(row.run_id);
    const share = run.rs_event_points / run.participant_count;

    let player = players.get(row.player_id);
    if (!player) {
      player = { playerId: row.player_id, playerName: row.player_name, nameAt: 0, totalPoints: 0, runsCount: 0, segments: new Map() };
      players.set(row.player_id, player);
    }

    // Show the name from the player's latest run
    const runTime = new Date(run.timestamp).getTime();
    if (runTime >= player.nameAt) {
      player.playerName = row.player_name;
      player.nameAt = runTime;
    }

    player.totalPoints += share;
    player.runsCount++;

    const key = tierKey(run.dark_red_star, run.star_level);
    const segment = player.segments.get(key) || { dark: run.dark_red_star, level: run.star_level, points: 0 };
    segment.points += share;
    player.segments.set(key, segment);
  }

  // Dark Red Star before Red Star, higher levels first
  const starOrder = (a, b) => (b.dark - a.dark) || (b.level - a.level);

  const rankedPlayers = [...players.values()]
    .map(p => {
      const segments = [...p.segments.values()].sort(starOrder);
      return {
        playerId: p.playerId,
        playerName: p.playerName,
        totalPoints: p.totalPoints,
        runsCount: p.runsCount,
        segments,
        tier: assignTier(segments, config.tierRequirements)
      };
    })
    .sort((a, b) => (b.totalPoints - a.totalPoints) || a.playerName.localeCompare(b.playerName));

  return {
    ...base,
    corpName: corpName || base.corpName,
    event: {
      eventId: event.event_id,
      number: window.number,
      start: window.start,
      end: window.end,
      active: isEventWindowActive(window, now)
    },
    totalCorpPoints,
    totalRuns: runsRes.rows.length,
    runsByStar: [...runsByStar.values()].sort(starOrder),
    players: rankedPlayers
  };
}

export async function buildRSBoardMessage(pool, guildId, eventId = null) {
  const data = await getRSLeaderboardData(pool, guildId, eventId);
  const files = [];
  const embeds = [];

  files.push(new AttachmentBuilder(await renderRSSummaryImage(data), { name: 'rs_summary.png' }));

  const unix = date => Math.floor(date.getTime() / 1000);
  let description;
  if (!data.event) {
    description = `No Corp RS Event recorded yet. Next event starts <t:${unix(data.nextEvent.start)}:R>.`;
  } else if (data.event.active) {
    description = `Corp RS Event #${data.event.number} ends <t:${unix(data.event.end)}:R>.`;
  } else {
    description = `Corp RS Event #${data.event.number} ended <t:${unix(data.event.end)}:f>. Next event starts <t:${unix(data.nextEvent.start)}:R>.`;
  }

  embeds.push(new EmbedBuilder()
    .setColor(0x9b1c31)
    .setDescription(description)
    .setImage('attachment://rs_summary.png'));

  // Bars share one scale across all pages: the highest of any player's points or requirement
  const scale = Math.max(1, ...data.players.map(p => Math.max(p.totalPoints, p.tier?.required || 0)));
  const pageCount = Math.min(Math.ceil(data.players.length / PLAYERS_PER_PAGE), MAX_RANKING_PAGES);

  for (let page = 0; page < pageCount; page++) {
    const firstRank = page * PLAYERS_PER_PAGE + 1;
    const name = `rs_ranking_${page + 1}.png`;
    const image = await renderRSRankingPage({
      eventNumber: data.event?.number,
      firstRank,
      players: data.players.slice(firstRank - 1, firstRank - 1 + PLAYERS_PER_PAGE),
      scale
    });
    files.push(new AttachmentBuilder(image, { name }));
    embeds.push(new EmbedBuilder().setColor(0x9b1c31).setImage(`attachment://${name}`));
  }

  const hidden = data.players.length - pageCount * PLAYERS_PER_PAGE;
  embeds[embeds.length - 1]
    .setFooter({ text: `Total Runs: ${data.totalRuns} • Non-event runs logged: ${data.nonEventRunCount}${hidden > 0 ? ` • ${hidden} more player(s) not shown` : ''}` })
    .setTimestamp(data.now);

  return { embeds, files };
}

function buildRequirementsText(tierRequirements) {
  const line = dark => TIER_LEVELS
    .map(level => {
      const value = tierRequirements[tierKey(dark, level)];
      return `${String(level).padStart(2)}: ${value ? formatPoints(value).padStart(9) : '        —'}`;
    });

  const rs = line(false);
  const drs = line(true);
  const rows = TIER_LEVELS.map((_, i) => `${rs[i]}   │ ${drs[i]}`);
  return '```\nRed Star        │ Dark Red Star\n' + rows.join('\n') + '\n```';
}

export function buildRSConfigPayload(config) {
  const apiChannelText = config.channelId ? `<#${config.channelId}>` : '⚠️ *Not set*';
  const displayChannelText = config.displayChannelId ? `<#${config.displayChannelId}>` : '*None (Disabled)*';
  const statusText = config.enabled ? '🟢 Enabled' : '🔴 Disabled';
  const goalText = config.eventGoal ? formatPoints(config.eventGoal) : '*Not set*';
  const nonEventText = config.lastNonEventRunAt
    ? `${config.nonEventRunCount} (last <t:${Math.floor(new Date(config.lastNonEventRunAt).getTime() / 1000)}:R>)`
    : `${config.nonEventRunCount || 0}`;

  const embed = new EmbedBuilder()
    .setTitle('⚙️ RS Event Scoreboard Configuration')
    .setColor(config.enabled ? 0x00d2ff : 0x700000)
    .addFields(
      { name: 'Tracking Status', value: statusText, inline: true },
      { name: 'Corp Event Goal', value: goalText, inline: true },
      { name: 'Non-event Runs Logged', value: nonEventText, inline: true },
      { name: 'API Log Channel (Input)', value: apiChannelText, inline: false },
      { name: 'Auto-Post Display Channel (Output)', value: displayChannelText, inline: false },
      { name: 'Required Contribution per Tier (— = inactive)', value: buildRequirementsText(config.tierRequirements || {}), inline: false }
    )
    .setFooter({ text: 'Players are assigned the tier of the highest active Dark Red Star level they ran, otherwise the highest active Red Star level.' });

  const apiChannelSelect = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('rsboard_cfg_api_channel')
      .setPlaceholder('Select API Ingestion Channel (Input)')
      .setChannelTypes(
        ChannelType.GuildText,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.GuildAnnouncement,
        ChannelType.AnnouncementThread
      )
  );

  const displayChannelSelect = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('rsboard_cfg_display_channel')
      .setPlaceholder('Select Auto-Post Display Channel (Output)')
      .setChannelTypes(
        ChannelType.GuildText,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.GuildAnnouncement,
        ChannelType.AnnouncementThread
      )
  );

  const requirementButtons = new ActionRowBuilder().addComponents(
    ...Object.entries(REQUIREMENT_GROUPS).map(([group, { dark, levels }]) =>
      new ButtonBuilder()
        .setCustomId(`rsboard_cfg_req_${group}`)
        .setLabel(`${dark ? 'DRS' : 'RS'} ${levels[0]}–${levels[levels.length - 1]}`)
        .setStyle(dark ? ButtonStyle.Danger : ButtonStyle.Primary)
    ),
    new ButtonBuilder()
      .setCustomId('rsboard_cfg_goal')
      .setLabel('Event Goal')
      .setStyle(ButtonStyle.Success)
  );

  const actionButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('rsboard_cfg_toggle')
      .setLabel(config.enabled ? 'Disable Ingestion' : 'Enable Ingestion')
      .setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('rsboard_cfg_clear_display')
      .setLabel('Clear Display Channel')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('rsboard_cfg_exit')
      .setLabel('Exit')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [apiChannelSelect, displayChannelSelect, requirementButtons, actionButtons],
    flags: 64
  };
}

export function buildRequirementModal(group, tierRequirements) {
  const { dark, levels } = REQUIREMENT_GROUPS[group];

  const modal = new ModalBuilder()
    .setCustomId(`rsboard_modal_req_${group}`)
    .setTitle(`${dark ? 'Dark Red Star' : 'Red Star'} ${levels[0]}–${levels[levels.length - 1]} Requirements`);

  for (const level of levels) {
    const current = tierRequirements[tierKey(dark, level)];
    const input = new TextInputBuilder()
      .setCustomId(tierKey(dark, level))
      .setLabel(`${starLabel(dark, level)}: required points per event`)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(15)
      .setPlaceholder('Empty = inactive. e.g. 300000 or 300k');
    if (current) input.setValue(String(current));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  return modal;
}

export function buildGoalModal(eventGoal) {
  const input = new TextInputBuilder()
    .setCustomId('event_goal')
    .setLabel('Corp points wanted per Corp RS Event')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(15)
    .setPlaceholder('Empty = no goal. e.g. 2500000 or 2.5m');
  if (eventGoal) input.setValue(String(eventGoal));

  return new ModalBuilder()
    .setCustomId('rsboard_modal_goal')
    .setTitle('Corp RS Event Goal')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function hasConfigPermission(member) {
  return member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    member.permissions.has(PermissionFlagsBits.Administrator);
}

export async function handleRSScoreBoardInteraction(interaction, client, pool) {
  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.reply({
      content: '❌ This command can only be executed inside a server.',
      flags: 64
    });
  }

  const config = await getRSScoreBoardConfig(pool, guildId);

  if (interaction.isChatInputCommand()) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'view') {
      await interaction.deferReply();
      return interaction.editReply(await buildRSBoardMessage(pool, guildId));
    }

    if (subcommand === 'config') {
      if (!hasConfigPermission(interaction.member)) {
        return interaction.reply({
          content: '❌ You require Manage Channels permission to configure RSScoreBoard.',
          flags: 64
        });
      }

      return interaction.reply(buildRSConfigPayload(config));
    }
  }

  if (interaction.isModalSubmit()) {
    if (!hasConfigPermission(interaction.member)) {
      return interaction.reply({ content: '❌ You require Manage Channels permission to configure RSScoreBoard.', flags: 64 });
    }

    const invalid = [];
    const readField = (fieldId, label) => {
      const value = parsePointsInput(interaction.fields.getTextInputValue(fieldId));
      if (value === null) invalid.push(label);
      return value;
    };

    if (interaction.customId.startsWith('rsboard_modal_req_')) {
      const group = REQUIREMENT_GROUPS[interaction.customId.replace('rsboard_modal_req_', '')];
      if (!group) return;

      const tierRequirements = { ...config.tierRequirements };
      for (const level of group.levels) {
        const key = tierKey(group.dark, level);
        const value = readField(key, starLabel(group.dark, level));
        if (value === null) continue;
        if (value > 0) tierRequirements[key] = value;
        else delete tierRequirements[key];
      }
      config.tierRequirements = tierRequirements;
    }

    if (interaction.customId === 'rsboard_modal_goal') {
      const value = readField('event_goal', 'Event goal');
      if (value !== null) config.eventGoal = value;
    }

    await saveRSScoreBoardConfig(pool, guildId, config);
    await interaction.update(buildRSConfigPayload(config));

    if (invalid.length > 0) {
      await interaction.followUp({
        content: `⚠️ Not a valid number, left unchanged: ${invalid.join(', ')}. Use e.g. \`300000\`, \`300.000\` or \`300k\`.`,
        flags: 64
      });
    }
    return;
  }

  if (interaction.isMessageComponent()) {
    const { customId } = interaction;

    if (customId.startsWith('rsboard_cfg_req_')) {
      const group = customId.replace('rsboard_cfg_req_', '');
      if (!REQUIREMENT_GROUPS[group]) return;
      return interaction.showModal(buildRequirementModal(group, config.tierRequirements));
    }

    if (customId === 'rsboard_cfg_goal') {
      return interaction.showModal(buildGoalModal(config.eventGoal));
    }

    if (customId === 'rsboard_cfg_toggle') {
      config.enabled = !config.enabled;
      await saveRSScoreBoardConfig(pool, guildId, config);
      return interaction.update(buildRSConfigPayload(config));
    }

    if (customId === 'rsboard_cfg_api_channel' || customId === 'rsboard_cfg_channel') {
      config.channelId = interaction.values[0];
      await saveRSScoreBoardConfig(pool, guildId, config);
      return interaction.update(buildRSConfigPayload(config));
    }

    if (customId === 'rsboard_cfg_display_channel') {
      config.displayChannelId = interaction.values[0];
      await saveRSScoreBoardConfig(pool, guildId, config);
      return interaction.update(buildRSConfigPayload(config));
    }

    if (customId === 'rsboard_cfg_clear_display') {
      config.displayChannelId = '';
      await saveRSScoreBoardConfig(pool, guildId, config);
      return interaction.update(buildRSConfigPayload(config));
    }

    if (customId === 'rsboard_cfg_exit') {
      return interaction.update({
        content: '⚙️ Configuration menu closed.',
        embeds: [],
        components: []
      });
    }
  }
}
