import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits
} from 'discord.js';
import {
  getQSConfig,
  saveQSConfig,
  getQSMember,
  saveQSMember,
  setQSSlots,
  removeQSSlots,
  getQSMemberSlots,
  getQSScheduleData,
  MAX_NAMES_PER_SLOT
} from './quantumSchedulerConfig.js';
import { buildQSBoardMessage, queueQSBoardUpdate } from './quantumSchedulerBoard.js';
import {
  normalizeTimeZone,
  getOffsetMinutes,
  describeTimeZone,
  searchTimeZones,
  parseLocalTime,
  localToUtcMinutes,
  utcToLocalMinutes,
  resolveHourRange,
  groupHourRanges,
  formatMinutes,
  formatHour,
  formatUtcRange
} from './quantumSchedulerTime.js';

const MAX_NAME_LENGTH = 32;

function addTimeOption(sub, name, description, required) {
  return sub.addStringOption(opt =>
    opt.setName(name)
      .setDescription(description)
      .setRequired(required)
      .setAutocomplete(true)
      .setMaxLength(10)
  );
}

export const quantumSchedulerCommand = new SlashCommandBuilder()
  .setName('quantum')
  .setDescription('Quantum corp tools')
  .addSubcommandGroup(group =>
    group.setName('scheduler')
      .setDescription('Corp availability timeline (shown in UTC)')
      .addSubcommand(sub =>
        sub.setName('view')
          .setDescription('Show the 24-hour corp availability timeline')
      )
      .addSubcommand(sub => {
        sub.setName('set')
          .setDescription('Add your hours (in your local time) and the game accounts you bring to them');
        addTimeOption(sub, 'from', 'Local start time, e.g. 03:00. Set timezone first to preview the UTC time', true);
        addTimeOption(sub, 'to', 'Local end time (not included), e.g. 06:00. Empty = one hour', false);
        sub.addStringOption(opt =>
          opt.setName('timezone')
            .setDescription('Your timezone, e.g. Europe/Istanbul or UTC+3. Saved for next time')
            .setAutocomplete(true)
            .setMaxLength(64)
        );
        for (let i = 1; i <= MAX_NAMES_PER_SLOT; i++) {
          sub.addStringOption(opt =>
            opt.setName(`name${i}`)
              .setDescription(i === 1
                ? 'Game account for these hours (main). Empty = the accounts you used last time'
                : `Additional game account (alt) ${i - 1} for these hours`)
              .setMaxLength(MAX_NAME_LENGTH)
          );
        }
        return sub;
      })
      .addSubcommand(sub => {
        sub.setName('remove')
          .setDescription('Remove your hours. Without times, removes all of them');
        addTimeOption(sub, 'from', 'Local start time, e.g. 03:00', false);
        addTimeOption(sub, 'to', 'Local end time (not included). Empty = one hour', false);
        return sub.addUserOption(opt =>
          opt.setName('member')
            .setDescription('Admins: remove another member\'s hours')
        );
      })
      .addSubcommand(sub =>
        sub.setName('config')
          .setDescription('Open the Quantum Scheduler configuration menu')
      )
  );

function hasConfigPermission(member) {
  return member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    member.permissions.has(PermissionFlagsBits.Administrator);
}

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

function memberDisplayName(interaction) {
  return interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
}

function cleanNames(raw) {
  const names = [];
  for (const value of raw) {
    const name = (value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
    if (name && !names.some(n => n.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names;
}

// The zone to read local times in: the one typed in this command, else the member's saved one, else UTC
async function resolveZone(pool, interaction) {
  const typed = interaction.options.getString('timezone');
  const typedZone = typed ? normalizeTimeZone(typed) : null;
  const member = await getQSMember(pool, interaction.guildId, interaction.user.id);
  return {
    typed,
    typedZone,
    member,
    zone: typedZone || member?.timeZone || null
  };
}

// --- Autocomplete: live local → UTC preview while the member types ---

function timeSuggestions(typed, zone, isEnd) {
  const offset = getOffsetMinutes(zone || 'UTC');
  const suffix = zone ? ` · ${zone}` : ' · no timezone set, read as UTC';
  const choices = [];
  const add = (localMinutes, label) => {
    const value = formatMinutes(localMinutes);
    if (!choices.some(c => c.value === value)) choices.push({ name: (label + suffix).slice(0, 100), value });
  };

  const typedMinutes = parseLocalTime((typed || '').replace(/[:.h]$/, ''));
  let firstHour = (new Date().getUTCHours() + (isEnd ? 1 : 0)) % 24;

  if (typedMinutes !== null) {
    const utc = localToUtcMinutes(typedMinutes, offset);
    const slot = isEnd ? Math.ceil(utc / 60) % 24 : Math.floor(utc / 60);
    const note = utc % 60 === 0 ? '' : ` (slot ${formatHour(slot)})`;
    add(typedMinutes, `${formatMinutes(typedMinutes)} local → ${formatMinutes(utc)} UTC${note}`);
    firstHour = slot;
  }

  for (let i = 0; i < 24; i++) {
    const hour = (firstHour + i) % 24;
    const local = utcToLocalMinutes(hour * 60, offset);
    add(local, `${formatMinutes(local)} local → ${formatHour(hour)} UTC`);
  }
  return choices.slice(0, 25);
}

async function handleAutocomplete(interaction, pool) {
  const focused = interaction.options.getFocused(true);

  if (focused.name === 'timezone') {
    const member = await getQSMember(pool, interaction.guildId, interaction.user.id);
    const choices = searchTimeZones(focused.value, member?.timeZone)
      .map(zone => ({ name: describeTimeZone(zone).slice(0, 100), value: zone }));
    return interaction.respond(choices);
  }

  if (focused.name === 'from' || focused.name === 'to') {
    const { zone } = await resolveZone(pool, interaction);
    return interaction.respond(timeSuggestions(focused.value, zone, focused.name === 'to'));
  }

  return interaction.respond([]);
}

// --- Replies ---

function describeSchedule(slots, zone) {
  if (slots.length === 0) return '*You have no hours on the schedule.*';

  const offset = getOffsetMinutes(zone || 'UTC');
  const byNames = new Map();
  for (const slot of slots) {
    const key = slot.names.join('\u0000');
    if (!byNames.has(key)) byNames.set(key, { names: slot.names, hours: [] });
    byNames.get(key).hours.push(slot.hour);
  }

  const lines = [];
  for (const { names, hours } of byNames.values()) {
    for (const range of groupHourRanges(hours)) {
      const local = zone && offset !== 0
        ? ` (${formatMinutes(utcToLocalMinutes(range.start * 60, offset))}–${formatMinutes(utcToLocalMinutes(range.end * 60, offset))} local)`
        : '';
      lines.push(`• **${formatUtcRange(range)} UTC**${local}: ${names.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function describeHours(hours) {
  return groupHourRanges(hours).map(r => `${formatUtcRange(r)} UTC`).join(', ');
}

async function handleSet(interaction, client, pool) {
  const guildId = interaction.guildId;
  const { typed, typedZone, member, zone } = await resolveZone(pool, interaction);
  if (typed && !typedZone) {
    return interaction.reply({
      content: `❌ Unknown timezone \`${typed}\`. Pick one from the list, or use e.g. \`Europe/Berlin\` or \`UTC+3\`.`,
      flags: 64
    });
  }

  const fromRaw = interaction.options.getString('from');
  const toRaw = interaction.options.getString('to');
  const fromLocal = parseLocalTime(fromRaw);
  const toLocal = toRaw ? parseLocalTime(toRaw) : null;
  if (fromLocal === null || (toRaw && toLocal === null)) {
    return interaction.reply({
      content: `❌ Couldn't read the time \`${fromLocal === null ? fromRaw : toRaw}\`. Use e.g. \`03:00\`, \`3\` or \`3pm\`.`,
      flags: 64
    });
  }

  const offset = getOffsetMinutes(zone || 'UTC');
  const hours = resolveHourRange(fromLocal, toLocal, offset);

  const givenNames = cleanNames(Array.from({ length: MAX_NAMES_PER_SLOT }, (_, i) => interaction.options.getString(`name${i + 1}`)));
  const displayName = memberDisplayName(interaction);
  const names = givenNames.length > 0
    ? givenNames
    : (member?.defaultNames?.length ? member.defaultNames : [displayName]);

  await saveQSMember(pool, guildId, interaction.user.id, { displayName, timeZone: typedZone, defaultNames: givenNames });
  await setQSSlots(pool, guildId, interaction.user.id, hours, names);
  const slots = await getQSMemberSlots(pool, guildId, interaction.user.id);

  const lines = [`✅ Added **${describeHours(hours)}** as ${names.join(', ')}.`];
  if (!zone) {
    lines.push('ℹ️ No timezone saved, so the times were read as **UTC**. Add `timezone` once to enter local times.');
  } else if (typedZone) {
    lines.push(`🌍 Timezone saved: **${describeTimeZone(zone)}**`);
  }
  lines.push('', '**Your schedule**', describeSchedule(slots, zone));

  await interaction.reply({ content: lines.join('\n'), flags: 64 });
  queueQSBoardUpdate(client, pool, guildId);
}

async function handleRemove(interaction, client, pool) {
  const guildId = interaction.guildId;
  const target = interaction.options.getUser('member');
  const targetId = target?.id || interaction.user.id;

  if (targetId !== interaction.user.id && !hasConfigPermission(interaction.member)) {
    return interaction.reply({
      content: '❌ You require Manage Channels permission to remove another member\'s hours.',
      flags: 64
    });
  }

  const fromRaw = interaction.options.getString('from');
  const toRaw = interaction.options.getString('to');
  let hours = null;

  if (fromRaw) {
    const fromLocal = parseLocalTime(fromRaw);
    const toLocal = toRaw ? parseLocalTime(toRaw) : null;
    if (fromLocal === null || (toRaw && toLocal === null)) {
      return interaction.reply({
        content: `❌ Couldn't read the time \`${fromLocal === null ? fromRaw : toRaw}\`. Use e.g. \`03:00\`, \`3\` or \`3pm\`.`,
        flags: 64
      });
    }
    const { zone } = await resolveZone(pool, interaction);
    hours = resolveHourRange(fromLocal, toLocal, getOffsetMinutes(zone || 'UTC'));
  }

  const removed = await removeQSSlots(pool, guildId, targetId, hours);
  const who = targetId === interaction.user.id ? 'your' : `<@${targetId}>'s`;
  const scope = hours ? ` in ${describeHours(hours)}` : '';
  const lines = [removed > 0 ? `🗑️ Removed ${removed} hour(s) of ${who} schedule${scope}.` : `ℹ️ Nothing of ${who} schedule to remove${scope}.`];

  if (targetId === interaction.user.id) {
    const member = await getQSMember(pool, guildId, targetId);
    lines.push('', '**Your schedule**', describeSchedule(await getQSMemberSlots(pool, guildId, targetId), member?.timeZone));
  }

  await interaction.reply({ content: lines.join('\n'), flags: 64, allowedMentions: { parse: [] } });
  if (removed > 0) queueQSBoardUpdate(client, pool, guildId);
}

export async function buildQSConfigPayload(pool, guildId, config, notice = '') {
  const { stats } = await getQSScheduleData(pool, guildId);
  const channelText = config.channelId ? `<#${config.channelId}>` : '*None (no board posted)*';
  const boardText = config.boardMessageId && config.boardChannelId === config.channelId
    ? `https://discord.com/channels/${guildId}/${config.boardChannelId}/${config.boardMessageId}`
    : '*Not posted yet*';

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Quantum Scheduler Configuration')
    .setColor(config.enabled ? 0x22d3ee : 0x700000)
    .addFields(
      { name: 'Auto-Post Status', value: config.enabled ? '🟢 Enabled' : '🔴 Disabled', inline: true },
      { name: 'Output Channel / Thread', value: channelText, inline: true },
      { name: 'Board Message', value: boardText, inline: true },
      { name: 'Members With ≥1 Hour', value: `👤 ${stats.people}`, inline: true },
      { name: 'Average Hours per Member', value: `⏱ ${stats.avgSlots.toFixed(1)}`, inline: true },
      { name: 'Game Accounts', value: `🎮 ${stats.accounts} (${stats.peopleWithAlts} member(s) with alts)`, inline: true },
      {
        name: 'Busiest Hour',
        value: stats.busiestHour === null ? '*None yet*' : `${formatHour(stats.busiestHour)}–${formatHour((stats.busiestHour + 1) % 24)} UTC (${stats.busiestPeople} member(s))`,
        inline: false
      }
    )
    .setFooter({ text: 'The board is re-rendered after every change and every 15 minutes. Forum posts are threads: pick the post itself.' });

  const channelSelect = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('quantum_cfg_channel')
      .setPlaceholder('Select the board output channel, thread or post')
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
      .setCustomId('quantum_cfg_toggle')
      .setLabel(config.enabled ? 'Disable Auto-Post' : 'Enable Auto-Post')
      .setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('quantum_cfg_refresh')
      .setLabel('Post / Refresh Board')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!config.enabled || !config.channelId),
    new ButtonBuilder()
      .setCustomId('quantum_cfg_clear')
      .setLabel('Clear Output Channel')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('quantum_cfg_exit')
      .setLabel('Exit')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    content: notice,
    embeds: [embed],
    components: [channelSelect, actionButtons],
    flags: 64
  };
}

export async function handleQuantumSchedulerInteraction(interaction, client, pool) {
  const guildId = interaction.guildId;

  if (interaction.isAutocomplete()) {
    if (!guildId) return interaction.respond([]);
    return handleAutocomplete(interaction, pool);
  }

  if (!guildId) {
    return interaction.reply({
      content: '❌ This command can only be executed inside a server.',
      flags: 64
    });
  }

  if (interaction.isChatInputCommand()) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'view') {
      await interaction.deferReply();
      return interaction.editReply(await buildQSBoardMessage(pool, interaction.guild));
    }

    if (subcommand === 'set') return handleSet(interaction, client, pool);
    if (subcommand === 'remove') return handleRemove(interaction, client, pool);

    if (subcommand === 'config') {
      if (!hasConfigPermission(interaction.member)) {
        return interaction.reply({
          content: '❌ You require Manage Channels permission to configure the Quantum Scheduler.',
          flags: 64
        });
      }

      const config = await getQSConfig(pool, guildId);
      const response = await interaction.reply(await buildQSConfigPayload(pool, guildId, config));
      attachAutoClose(interaction, response, 'Configuration menu');
      return;
    }
  }

  if (interaction.isMessageComponent()) {
    const { customId } = interaction;

    if (customId === 'quantum_cfg_exit') {
      return interaction.update({
        content: '⚙️ Configuration menu closed.',
        embeds: [],
        components: []
      });
    }

    if (!hasConfigPermission(interaction.member)) {
      return interaction.reply({
        content: '❌ You require Manage Channels permission to configure the Quantum Scheduler.',
        flags: 64
      });
    }

    // Rendering and posting the board can take longer than Discord's 3 s reply window
    await interaction.deferUpdate();
    const config = await getQSConfig(pool, guildId);
    const failed = '⚠️ Could not post the board there. Check that the bot can view the channel, send messages and attach files.';
    let notice = '';

    if (customId === 'quantum_cfg_channel') {
      config.channelId = interaction.values[0];
      await saveQSConfig(pool, guildId, config);
      if (config.enabled) {
        notice = await queueQSBoardUpdate(client, pool, guildId) ? `📢 Board posted to <#${config.channelId}>.` : failed;
      }
    } else if (customId === 'quantum_cfg_toggle') {
      config.enabled = !config.enabled;
      await saveQSConfig(pool, guildId, config);
      if (config.enabled && config.channelId) {
        notice = await queueQSBoardUpdate(client, pool, guildId) ? '📢 Auto-post enabled and board refreshed.' : failed;
      }
    } else if (customId === 'quantum_cfg_refresh') {
      notice = await queueQSBoardUpdate(client, pool, guildId) ? '🔄 Board refreshed.' : failed;
    } else if (customId === 'quantum_cfg_clear') {
      config.channelId = '';
      await saveQSConfig(pool, guildId, config);
      notice = 'Output channel cleared. The last posted board stays but is no longer updated.';
    }

    return interaction.editReply(await buildQSConfigPayload(pool, guildId, await getQSConfig(pool, guildId), notice));
  }
}
