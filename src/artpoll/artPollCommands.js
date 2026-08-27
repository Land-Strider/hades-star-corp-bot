import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType
} from 'discord.js';
import { getArtPollConfig, saveArtPollConfig, hasPollPermission } from './artPollConfig.js';
import {
  ensureStatsTablesExist,
  getQuarterlyStats,
  buildQuarterlyReportEmbed,
  snapshotPollVotes
} from './artPollStats.js';

export const artPollCommand = new SlashCommandBuilder()
  .setName('artpoll')
  .setDescription('Manage the Artifact Poll module')
  .addSubcommand(sub =>
    sub.setName('config')
      .setDescription('Open the interactive Artifact Poll configuration menu')
  )
  .addSubcommand(sub =>
    sub.setName('poll')
      .setDescription('Open the Artifact Poll management menu')
  )
  .addSubcommand(sub =>
    sub.setName('stats')
      .setDescription('View quarterly artifact poll statistics')
      .addIntegerOption(opt =>
        opt.setName('quarter')
          .setDescription('Quarter number (1-4)')
          .setMinValue(1)
          .setMaxValue(4)
          .setRequired(false)
      )
      .addIntegerOption(opt =>
        opt.setName('year')
          .setDescription('Year (e.g. 2026)')
          .setMinValue(2020)
          .setRequired(false)
      )
  );

function attachAutoClose(interaction, response, timeoutLabel) {
  const collector = response.createMessageComponentCollector({ idle: 60_000 });

  collector.on('end', async (_, reason) => {
    if (reason === 'idle') {
      await interaction.editReply({
        content: `⏱️ ${timeoutLabel} timed out due to 1 minute of inactivity.`,
        embeds: [],
        components: []
      }).catch(() => null);
    }
  });
}

export function buildConfigPayload(config) {
  const channelText = config.channelId ? `<#${config.channelId}>` : '⚠️ *Not set*';
  const accessRoleText = config.allowedRoleIds && config.allowedRoleIds.length > 0
    ? config.allowedRoleIds.map(id => `<@&${id}>`).join(', ')
    : '*Administrators / Manage Channels default*';
  const mentionRoleText = config.roleMentionId ? `<@&${config.roleMentionId}>` : '*None*';
  const statusText = config.enabled ? '🟢 Enabled' : '🔴 Disabled';
  const statsStatusText = config.statsEnabled ? '🟢 Enabled' : '🔴 Disabled';
  const flowText = config.pollStarted ? '▶️ Active' : '⏸️ Waiting for First Manual Start';

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Artifact Poll Configuration')
    .setColor(config.enabled ? 0x2b2d31 : 0x700000)
    .addFields(
      { name: 'Poll State', value: flowText, inline: true },
      { name: 'Auto-Repost', value: statusText, inline: true },
      { name: 'Stats Tracking', value: statsStatusText, inline: true },
      { name: 'Post Channel', value: channelText, inline: false },
      { name: 'Management Role', value: accessRoleText, inline: false },
      { name: 'Mention Role', value: mentionRoleText, inline: false }
    )
    .setFooter({ text: 'Use the controls below to configure settings.' });

  const channelSelect = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('artpoll_cfg_channel')
      .setPlaceholder('Select Poll Channel or Forum Post Thread')
      .setChannelTypes(
        ChannelType.GuildText,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.GuildAnnouncement,
        ChannelType.AnnouncementThread
      )
  );

  const accessRoleSelect = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('artpoll_cfg_access_role')
      .setPlaceholder('Select Management Access Role')
  );

  const mentionRoleSelect = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('artpoll_cfg_mention_role')
      .setPlaceholder('Select Ping Mention Role')
  );

  const actionRowOne = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('artpoll_cfg_toggle')
      .setLabel(config.enabled ? 'Disable Auto-Posting' : 'Enable Auto-Posting')
      .setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('artpoll_cfg_toggle_stats')
      .setLabel(config.statsEnabled ? 'Disable Stats Tracking' : 'Enable Stats Tracking')
      .setStyle(config.statsEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
  );

  const actionRowTwo = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('artpoll_cfg_clear_access')
      .setLabel('Clear Access Role')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('artpoll_cfg_clear_mention')
      .setLabel('Clear Mention Role')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('artpoll_cfg_exit')
      .setLabel('Exit')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [channelSelect, accessRoleSelect, mentionRoleSelect, actionRowOne, actionRowTwo],
    flags: 64,
    fetchReply: true
  };
}

export async function buildPollPayload(pool, config, guildId) {
  const activeRes = await pool.query(
    `SELECT * FROM artifact_polls WHERE guild_id = $1 AND is_closed = FALSE ORDER BY poll_id DESC LIMIT 1`,
    [guildId]
  );

  const hasActivePoll = activeRes.rows.length > 0;
  const embed = new EmbedBuilder()
    .setTitle('📊 Artifact Poll Control Panel')
    .setColor(hasActivePoll ? 0x57f287 : 0x5865f2);

  if (hasActivePoll) {
    const poll = activeRes.rows[0];
    const msgLink = `https://discord.com/channels/${poll.guild_id}/${poll.channel_id}/${poll.message_id}`;
    embed.addFields(
      { name: 'Status', value: '🟢 Poll Running', inline: true },
      { name: 'Poll ID', value: `#${poll.poll_id}`, inline: true },
      { name: 'Channel', value: `<#${poll.channel_id}>`, inline: true },
      { name: 'Message Link', value: `[Jump to Poll](${msgLink})`, inline: false },
      { name: 'Closes At', value: `<t:${Math.floor(new Date(poll.closes_at).getTime() / 1000)}:F>`, inline: false }
    );
  } else {
    embed.addFields(
      { name: 'Status', value: '🔴 No Poll Running', inline: true },
      { name: 'Cycle Present?', value: config.pollStarted ? 'Yes ✅' : 'No ❌ (Manual Start Required)', inline: true }
    );
  }

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('artpoll_poll_start')
      .setLabel('Start New Poll')
      .setStyle(ButtonStyle.Success)
      .setDisabled(hasActivePoll),
    new ButtonBuilder()
      .setCustomId('artpoll_poll_snapshot_test')
      .setLabel('📸 Force Snapshot & Close (Test)')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasActivePoll),
    new ButtonBuilder()
      .setCustomId('artpoll_poll_delete')
      .setLabel('Delete Poll & Pause Cycle')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasActivePoll),
    new ButtonBuilder()
      .setCustomId('artpoll_poll_exit')
      .setLabel('Exit')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [buttons],
    flags: 64,
    fetchReply: true
  };
}

export async function handleArtPollInteraction(interaction, client, pool, { terminateActivePoll, deleteActivePoll, createNewArtifactPoll }) {
  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.reply({
      content: '❌ This command can only be executed inside a server.',
      flags: 64
    });
  }

  const config = getArtPollConfig(guildId);

  if (!hasPollPermission(interaction.member, config)) {
    return interaction.reply({
      content: '❌ You do not have permission to execute artifact poll actions.',
      flags: 64
    });
  }

  if (interaction.isChatInputCommand()) {
    const subcommand = interaction.options.getSubcommand();
    
    if (subcommand === 'config') {
      const response = await interaction.reply(buildConfigPayload(config));
      attachAutoClose(interaction, response, 'Configuration menu');
      return;
    }

    if (subcommand === 'poll') {
      const payload = await buildPollPayload(pool, config, guildId);
      const response = await interaction.reply(payload);
      attachAutoClose(interaction, response, 'Poll control panel');
      return;
    }

    if (subcommand === 'stats') {
      if (!config.statsEnabled) {
        return interaction.reply({
          content: '⚠️ Stats tracking is currently **disabled**. Enable it via `/artpoll config` first.',
          flags: 64
        });
      }

      await interaction.deferReply({ flags: 64 });

      await ensureStatsTablesExist(pool);

      const now = new Date();
      const currentQuarter = Math.floor(now.getUTCMonth() / 3) + 1;
      const quarter = interaction.options.getInteger('quarter') || currentQuarter;
      const year = interaction.options.getInteger('year') || now.getUTCFullYear();

      const stats = await getQuarterlyStats(pool, client, year, quarter, guildId);
      const embed = buildQuarterlyReportEmbed(stats);

      return interaction.editReply({
        embeds: [embed]
      });
    }
  }

  if (interaction.isMessageComponent()) {
    const { customId } = interaction;

    if (customId === 'artpoll_cfg_toggle') {
      config.enabled = !config.enabled;
      saveArtPollConfig(guildId, config);
      return interaction.update(buildConfigPayload(config));
    }

    if (customId === 'artpoll_cfg_toggle_stats') {
      config.statsEnabled = !config.statsEnabled;
      saveArtPollConfig(guildId, config);

      if (config.statsEnabled) {
        await ensureStatsTablesExist(pool);
      }

      return interaction.update(buildConfigPayload(config));
    }

    if (customId === 'artpoll_cfg_channel') {
      config.channelId = interaction.values[0];
      saveArtPollConfig(guildId, config);
      return interaction.update(buildConfigPayload(config));
    }

    if (customId === 'artpoll_cfg_access_role') {
      config.allowedRoleIds = [interaction.values[0]];
      saveArtPollConfig(guildId, config);
      return interaction.update(buildConfigPayload(config));
    }

    if (customId === 'artpoll_cfg_clear_access') {
      config.allowedRoleIds = [];
      saveArtPollConfig(guildId, config);
      return interaction.update(buildConfigPayload(config));
    }

    if (customId === 'artpoll_cfg_mention_role') {
      config.roleMentionId = interaction.values[0];
      saveArtPollConfig(guildId, config);
      return interaction.update(buildConfigPayload(config));
    }

    if (customId === 'artpoll_cfg_clear_mention') {
      config.roleMentionId = '';
      saveArtPollConfig(guildId, config);
      return interaction.update(buildConfigPayload(config));
    }

    if (customId === 'artpoll_cfg_exit') {
      return interaction.update({
        content: '⚙️ Configuration menu closed.',
        embeds: [],
        components: []
      });
    }

    if (customId === 'artpoll_poll_start') {
      const activeRes = await pool.query(
        `SELECT * FROM artifact_polls WHERE guild_id = $1 AND is_closed = FALSE ORDER BY poll_id DESC LIMIT 1`,
        [guildId]
      );
      if (activeRes.rows.length > 0) {
        return interaction.reply({
          content: '⚠️ An active poll is already running in this server. Delete it first.',
          flags: 64
        });
      }

      const targetChannelId = config.channelId;
      if (!targetChannelId) {
        return interaction.reply({
          content: '❌ No target channel set. Please select a posting channel via `/artpoll config` first.',
          flags: 64
        });
      }

      await createNewArtifactPoll(client, pool, targetChannelId, guildId);

      const payload = await buildPollPayload(pool, config, guildId);
      return interaction.update(payload);
    }

    if (customId === 'artpoll_poll_snapshot_test') {
      await interaction.deferUpdate();

      const activeRes = await pool.query(
        `SELECT * FROM artifact_polls WHERE guild_id = $1 AND is_closed = FALSE ORDER BY poll_id DESC LIMIT 1`,
        [guildId]
      );

      if (activeRes.rows.length === 0) return;

      const poll = activeRes.rows[0];

      await snapshotPollVotes(client, pool, poll);

      await pool.query(
        `UPDATE artifact_polls SET is_closed = TRUE, is_manual = FALSE WHERE poll_id = $1`,
        [poll.poll_id]
      );

      try {
        const channel = client.channels.cache.get(poll.channel_id) || await client.channels.fetch(poll.channel_id);
        const message = channel.messages.cache.get(poll.message_id) || await channel.messages.fetch(poll.message_id);
        if (message && message.poll) {
          await message.poll.end().catch(() => null);
        }
      } catch (err) {
        console.error('Error closing test poll message:', err);
      }

      const payload = await buildPollPayload(pool, config, guildId);
      return interaction.editReply(payload);
    }

    if (customId === 'artpoll_poll_delete') {
      await deleteActivePoll(client, pool, guildId);

      config.pollStarted = false;
      saveArtPollConfig(guildId, config);

      const payload = await buildPollPayload(pool, config, guildId);
      return interaction.update(payload);
    }

    if (customId === 'artpoll_poll_exit') {
      return interaction.update({
        content: '📊 Poll control panel closed.',
        embeds: [],
        components: []
      });
    }
  }
}