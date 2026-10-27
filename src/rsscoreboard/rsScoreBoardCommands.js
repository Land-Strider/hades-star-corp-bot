import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  AttachmentBuilder,
  PermissionFlagsBits
} from 'discord.js';
import { getRSScoreBoardConfig, saveRSScoreBoardConfig } from './rsScoreBoardConfig.js';
import { renderRSScoreBoardImage } from './rsScoreBoardRenderer.js';

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

// Leaderboard for one Corp RS Event (defaults to the guild's most recent event).
// Each run's RSEventPoints are split evenly between its contributors.
export async function getRSLeaderboardData(pool, guildId, eventId = null) {
  const eventRes = await pool.query(
    `SELECT event_id, started_at, last_run_at FROM rs_events
     WHERE guild_id = $1 AND ($2::int IS NULL OR event_id = $2)
     ORDER BY started_at DESC
     LIMIT 1`,
    [guildId, eventId]
  );
  const event = eventRes.rows[0];

  if (!event) {
    return { corpName: 'Quilliance', totalCorpPoints: 0, totalRuns: 0, players: [], eventStart: null, eventEnd: null };
  }

  const corpStatsRes = await pool.query(
    `SELECT
       COALESCE(SUM(rs_event_points), 0)::int AS "totalCorpPoints",
       COUNT(run_id)::int AS "totalRuns",
       (ARRAY_AGG(corporation_name ORDER BY timestamp DESC) FILTER (WHERE corporation_name IS NOT NULL))[1] AS "corpName"
     FROM rs_event_runs
     WHERE event_id = $1`,
    [event.event_id]
  );

  const playersRes = await pool.query(
    `SELECT
       (ARRAY_AGG(p.player_name ORDER BY r.timestamp DESC))[1] AS "playerName",
       ROUND(SUM(r.rs_event_points::numeric / r.participant_count))::int AS "totalPoints",
       COUNT(*)::int AS "runsCount",
       MAX(r.star_level) AS "maxStarLevel",
       (ARRAY_AGG(r.dark_red_star ORDER BY r.star_level DESC, r.dark_red_star DESC))[1] AS "isDarkRS"
     FROM rs_event_participants p
     JOIN rs_event_runs r ON p.run_id = r.run_id
     WHERE r.event_id = $1
     GROUP BY p.player_id
     ORDER BY "totalPoints" DESC, "playerName"`,
    [event.event_id]
  );

  return {
    corpName: corpStatsRes.rows[0]?.corpName || 'Quilliance',
    totalCorpPoints: corpStatsRes.rows[0]?.totalCorpPoints || 0,
    totalRuns: corpStatsRes.rows[0]?.totalRuns || 0,
    players: playersRes.rows,
    eventStart: event.started_at,
    eventEnd: event.last_run_at
  };
}

export async function buildRSBoardMessage(pool, guildId, eventId = null) {
  const leaderboardData = await getRSLeaderboardData(pool, guildId, eventId);
  const imageBuffer = await renderRSScoreBoardImage(leaderboardData);
  const attachment = new AttachmentBuilder(imageBuffer, { name: 'rs_scoreboard.png' });

  const eventText = leaderboardData.eventStart
    ? `Event of ${leaderboardData.eventStart.toISOString().substring(0, 10)} • `
    : 'No Corp RS Event recorded yet • ';

  const embed = new EmbedBuilder()
    .setTitle('📊 Red Star Event Scoreboard')
    .setColor(0x00d2ff)
    .setImage('attachment://rs_scoreboard.png')
    .setFooter({ text: `${eventText}Total Runs: ${leaderboardData.totalRuns} • Total Corp Points: ${leaderboardData.totalCorpPoints.toLocaleString('en-US')}` });

  return { embeds: [embed], files: [attachment] };
}

export function buildRSConfigPayload(config) {
  const apiChannelText = config.channelId ? `<#${config.channelId}>` : '⚠️ *Not set*';
  const displayChannelText = config.displayChannelId ? `<#${config.displayChannelId}>` : '*None (Disabled)*';
  const statusText = config.enabled ? '🟢 Enabled' : '🔴 Disabled';

  const embed = new EmbedBuilder()
    .setTitle('⚙️ RS Event Scoreboard Configuration')
    .setColor(config.enabled ? 0x00d2ff : 0x700000)
    .addFields(
      { name: 'Tracking Status', value: statusText, inline: true },
      { name: 'API Log Channel (Input)', value: apiChannelText, inline: false },
      { name: 'Auto-Post Display Channel (Output)', value: displayChannelText, inline: false }
    )
    .setFooter({ text: 'Select channels below for API ingestion and automatic graphic scoreboard posting.' });

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
    components: [apiChannelSelect, displayChannelSelect, actionButtons],
    flags: 64
  };
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
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) &&
          !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          content: '❌ You require Manage Channels permission to configure RSScoreBoard.',
          flags: 64
        });
      }

      return interaction.reply(buildRSConfigPayload(config));
    }
  }

  if (interaction.isMessageComponent()) {
    const { customId } = interaction;

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

