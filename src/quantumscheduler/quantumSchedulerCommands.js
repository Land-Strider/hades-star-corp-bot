import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits
} from 'discord.js';
import {
  getQSConfig,
  saveQSConfig,
  getQSMember,
  saveQSMember,
  addQSSlots,
  renameQSAccount,
  removeQSSlots,
  getQSMemberSlots,
  getQSMemberAccounts,
  getQSScheduleData
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
  formatUtcRange,
  parseEventInput
} from './quantumSchedulerTime.js';

const MAX_NAME_LENGTH = 32;
const MAX_ALTS = 5;

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
          .setDescription('Add hours (in your local time) for your main and alt accounts. Keeps your other hours');
        addTimeOption(sub, 'from', 'Local start time, e.g. 03:00', true);
        addTimeOption(sub, 'to', 'Local end time (not included), e.g. 06:00. Empty = one hour', false);
        // Needed only the first time; after that the saved timezone is used unless a new one is given
        sub.addStringOption(opt =>
          opt.setName('timezone')
            .setDescription('Your timezone, e.g. Europe/Istanbul or UTC+3. Needed once, then saved. Use it to change')
            .setAutocomplete(true)
            .setMaxLength(64)
        );
        sub.addStringOption(opt =>
          opt.setName('main')
            .setDescription('Your main game account. Empty = your server nickname')
            .setMaxLength(MAX_NAME_LENGTH)
        );
        for (let i = 1; i <= MAX_ALTS; i++) {
          sub.addStringOption(opt =>
            opt.setName(`alt${i}`)
              .setDescription(`Alt game account ${i} for these hours`)
              .setMaxLength(MAX_NAME_LENGTH)
          );
        }
        return sub.addBooleanOption(opt =>
          opt.setName('alts_only')
            .setDescription('Add these hours only for the alts, not your main')
        );
      })
      .addSubcommand(sub => {
        sub.setName('remove')
          .setDescription('Remove hours. Without times, every hour; without account, every account');
        addTimeOption(sub, 'from', 'Local start time, e.g. 03:00', false);
        addTimeOption(sub, 'to', 'Local end time (not included). Empty = one hour', false);
        sub.addStringOption(opt =>
          opt.setName('account')
            .setDescription('Only remove this game account from those hours')
            .setAutocomplete(true)
            .setMaxLength(MAX_NAME_LENGTH)
        );
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

// Config and removing other members' hours are for server admins only, whatever their roles are called
function isServerAdmin(member) {
  return member?.permissions?.has(PermissionFlagsBits.Administrator) === true;
}

const ADMIN_ONLY = '❌ Only server admins (Administrator permission) can do this.';

function memberRoleIds(member) {
  if (!member?.roles) return [];
  return Array.isArray(member.roles) ? member.roles : [...member.roles.cache.keys()];
}

// set/remove: admins, or members with one of the configured roles (no roles configured = everyone)
function canSetSchedule(member, config) {
  if (isServerAdmin(member) || config.allowedRoleIds.length === 0) return true;
  return memberRoleIds(member).some(id => config.allowedRoleIds.includes(id));
}

// Commands run only in the configured channel or its threads (none configured = anywhere); admins anywhere
function inCommandChannel(interaction, config) {
  if (!config.commandChannelId || isServerAdmin(interaction.member)) return true;
  return interaction.channelId === config.commandChannelId || interaction.channel?.parentId === config.commandChannelId;
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
  const suffix = zone ? ` · ${zone}` : ' · as UTC: add timezone (first time only)';
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

  if (focused.name === 'account') {
    const userId = interaction.options.get('member')?.value || interaction.user.id;
    const typed = focused.value.toLowerCase();
    const accounts = await getQSMemberAccounts(pool, interaction.guildId, userId);
    return interaction.respond(accounts
      .filter(name => name.toLowerCase().includes(typed))
      .slice(0, 25)
      .map(name => ({ name, value: name })));
  }

  return interaction.respond([]);
}

// --- Replies ---

// One line per account: its UTC hour ranges, with the member's local times next to them
function describeSchedule(slots, zone, mainName) {
  if (slots.length === 0) return '*You have no hours on the schedule.*';

  const offset = getOffsetMinutes(zone || 'UTC');
  const byAccount = new Map();
  for (const slot of slots) {
    for (const name of slot.names) {
      if (!byAccount.has(name)) byAccount.set(name, []);
      byAccount.get(name).push(slot.hour);
    }
  }

  const accounts = [...byAccount.keys()]
    .sort((a, b) => (b.toLowerCase() === mainName?.toLowerCase()) - (a.toLowerCase() === mainName?.toLowerCase()));
  return accounts.map(name => {
    const ranges = groupHourRanges(byAccount.get(name)).map(range => {
      const local = zone && offset !== 0
        ? ` (${formatMinutes(utcToLocalMinutes(range.start * 60, offset))}–${formatMinutes(utcToLocalMinutes(range.end * 60, offset))})`
        : '';
      return `${formatUtcRange(range)}${local}`;
    });
    const label = name.toLowerCase() === mainName?.toLowerCase() ? `**${name}** (main)` : `**${name}**`;
    return `• ${label}: ${ranges.join(', ')} UTC`;
  }).join('\n') + (zone && offset !== 0 ? '\n-# Local times in brackets.' : '');
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
  if (!zone) {
    return interaction.reply({
      content: '🌍 First time here: add the `timezone` option (e.g. `Europe/Istanbul` or `UTC+3`) so your local times can be ' +
        'converted to UTC. It\'s saved, so you won\'t need it again unless you want to change it.',
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

  // One name per main account: a given main replaces the saved one, an empty main keeps it,
  // and only a member without a saved main falls back to their nickname on this server
  const displayName = memberDisplayName(interaction);
  const mainName = cleanNames([interaction.options.getString('main') || member?.mainName || displayName])[0];
  const alts = cleanNames(Array.from({ length: MAX_ALTS }, (_, i) => interaction.options.getString(`alt${i + 1}`)))
    .filter(name => name.toLowerCase() !== mainName.toLowerCase());
  const altsOnly = interaction.options.getBoolean('alts_only') === true;

  if (altsOnly && alts.length === 0) {
    return interaction.reply({ content: '❌ `alts_only` needs at least one alt name.', flags: 64 });
  }
  const names = altsOnly ? alts : [mainName, ...alts];

  // A renamed main carries its existing hours over to the new name
  const previousMain = member?.mainName;
  const renamed = previousMain && previousMain !== mainName
    ? await renameQSAccount(pool, guildId, interaction.user.id, previousMain, mainName)
    : 0;

  await saveQSMember(pool, guildId, interaction.user.id, { displayName, timeZone: typedZone, mainName });
  await addQSSlots(pool, guildId, interaction.user.id, hours, names);
  const slots = await getQSMemberSlots(pool, guildId, interaction.user.id);

  const lines = [`✅ Added **${describeHours(hours)}** for ${names.join(', ')}. Your other hours are unchanged.`];
  if (previousMain && previousMain !== mainName) {
    lines.push(`✏️ Main renamed from **${previousMain}** to **${mainName}**${renamed > 0 ? ` in ${renamed} hour(s)` : ''}.`);
  }
  if (typedZone && typedZone !== member?.timeZone) {
    lines.push(`🌍 Timezone saved: **${describeTimeZone(zone)}**`);
  }
  lines.push('', '**Your schedule**', describeSchedule(slots, zone, mainName));

  await interaction.reply({ content: lines.join('\n'), flags: 64 });
  queueQSBoardUpdate(client, pool, guildId);
}

async function handleRemove(interaction, client, pool) {
  const guildId = interaction.guildId;
  const target = interaction.options.getUser('member');
  const targetId = target?.id || interaction.user.id;

  if (targetId !== interaction.user.id && !isServerAdmin(interaction.member)) {
    return interaction.reply({
      content: '❌ Only server admins (Administrator permission) can remove another member\'s hours.',
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

  const account = interaction.options.getString('account')?.trim() || null;
  const removed = await removeQSSlots(pool, guildId, targetId, hours, account ? [account] : null);
  const who = targetId === interaction.user.id ? 'your' : `<@${targetId}>'s`;
  const scope = `${account ? ` for **${account}**` : ''}${hours ? ` in ${describeHours(hours)}` : ''}`;
  const lines = [removed > 0 ? `🗑️ Removed ${removed} hour(s) of ${who} schedule${scope}.` : `ℹ️ Nothing of ${who} schedule to remove${scope}.`];

  if (targetId === interaction.user.id) {
    const member = await getQSMember(pool, guildId, targetId);
    lines.push('', '**Your schedule**', describeSchedule(await getQSMemberSlots(pool, guildId, targetId), member?.timeZone, member?.mainName));
  }

  await interaction.reply({ content: lines.join('\n'), flags: 64, allowedMentions: { parse: [] } });
  if (removed > 0) queueQSBoardUpdate(client, pool, guildId);
}

// The event lasts 24 h, so its start and end share one time of day. Only that time is known, not the day.
function describeEventTime(minutes) {
  if (minutes === null || minutes === undefined) return '*Not set*';
  const now = Date.now();
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) + minutes * 60_000;
  const next = Math.floor((today > now ? today : today + 86_400_000) / 1000);
  return `${formatMinutes(minutes)} UTC (your time <t:${next}:t>)`;
}

// Discord form for the event time. A blank field keeps the current value, "-" clears it.
function buildEventModal(config, zone) {
  const offset = getOffsetMinutes(zone);
  const minutes = config.eventTimeMinutes;
  const current = minutes === null
    ? 'Not set'
    : `${formatMinutes(utcToLocalMinutes(minutes, offset))} local = ${formatMinutes(minutes)} UTC`;

  return new ModalBuilder()
    .setCustomId('quantum_cfg_event_modal')
    .setTitle('Event Time (start = end, 24 h event)')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('event_time')
        .setLabel('Local hh:mm or countdown e.g. 10h27m')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(20)
        .setPlaceholder(`Now: ${current}. Blank keeps, - clears`.slice(0, 100))),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('event_timezone')
        .setLabel('Your timezone (for hh:mm times)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(64)
        .setValue(zone)
        .setPlaceholder('e.g. Europe/Istanbul or UTC+3'))
    );
}

async function handleEventModal(interaction, client, pool) {
  const guildId = interaction.guildId;
  await interaction.deferUpdate();

  const config = await getQSConfig(pool, guildId);
  const member = await getQSMember(pool, guildId, interaction.user.id);
  const typedZone = interaction.fields.getTextInputValue('event_timezone').trim();
  const zone = typedZone ? normalizeTimeZone(typedZone) : (member?.timeZone || 'UTC');
  const notices = [];

  if (!zone) {
    notices.push(`❌ Unknown timezone \`${typedZone}\`. Nothing changed. Use e.g. \`Europe/Berlin\` or \`UTC+3\`.`);
  } else {
    const raw = interaction.fields.getTextInputValue('event_time').trim();
    const parsed = raw ? parseEventInput(raw, getOffsetMinutes(zone)) : undefined;
    if (parsed === null) {
      notices.push(`⚠️ Couldn't read \`${raw}\`, event time left unchanged. Use \`14:30\`, \`10h27m\` or \`-\` to clear.`);
    } else if (parsed?.clear) {
      config.eventTimeMinutes = null;
      notices.push('🗑️ Event time cleared.');
    } else if (parsed) {
      // A countdown or local time is kept only as its UTC time of day
      config.eventTimeMinutes = parsed.getUTCHours() * 60 + parsed.getUTCMinutes();
      notices.push(`✅ Event time: **${formatMinutes(config.eventTimeMinutes)} UTC**.`);
    }

    await saveQSConfig(pool, guildId, config);
    if (typedZone && zone !== member?.timeZone) {
      await saveQSMember(pool, guildId, interaction.user.id, { displayName: memberDisplayName(interaction), timeZone: zone, mainName: null });
    }
    if (notices.length > 0 && config.enabled && config.channelId) await queueQSBoardUpdate(client, pool, guildId);
  }

  return interaction.editReply(await buildQSConfigPayload(pool, guildId, config, notices.join('\n') || 'ℹ️ No event time given.'));
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
      {
        name: 'Average Members per Hour',
        value: `⌀ ${stats.avgPeoplePerHour.toFixed(1)} over 24 h\n⌀ ${stats.avgPeoplePerCoveredHour.toFixed(1)} over the ${stats.coveredHours} covered hour(s)`,
        inline: true
      },
      { name: 'Game Accounts', value: `🎮 ${stats.accounts} (${stats.peopleWithAlts} member(s) with alts)`, inline: true },
      { name: 'Average Hours per Member', value: `⏱ ${stats.avgSlots.toFixed(1)}`, inline: true },
      { name: 'Event Time (start/end)', value: describeEventTime(config.eventTimeMinutes), inline: true },
      {
        name: 'Command Channel',
        value: config.commandChannelId ? `<#${config.commandChannelId}> (and its threads)` : '*Any channel*',
        inline: true
      },
      {
        name: 'Set/Remove Roles',
        value: config.allowedRoleIds.length > 0 ? config.allowedRoleIds.map(id => `<@&${id}>`).join(', ') : '*Everyone*',
        inline: true
      },
      {
        name: 'Busiest Hours (UTC)',
        value: stats.busiest.length === 0
          ? '*None yet*'
          : stats.busiest.map((c, i) =>
            `${i + 1}. ${formatHour(c.hour)}–${formatHour((c.hour + 1) % 24)} · 👤 ${c.people} · 🎮 ${c.accounts}`).join('\n'),
        inline: false
      }
    )
    .setFooter({ text: 'Config and removing other members\' hours: server admins only. Admins bypass the channel and role limits. The board is re-rendered after every change and every 15 minutes.' });

  const textChannelTypes = [
    ChannelType.GuildText,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.GuildAnnouncement,
    ChannelType.AnnouncementThread
  ];

  const outputSelect = new ChannelSelectMenuBuilder()
    .setCustomId('quantum_cfg_channel')
    .setPlaceholder('Board output channel, thread or post')
    .setChannelTypes(...textChannelTypes);
  if (config.channelId) outputSelect.setDefaultChannels(config.channelId);

  // min 0 so emptying the selection clears the limit
  const commandChannelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('quantum_cfg_cmd_channel')
    .setPlaceholder('Command channel (empty = any channel)')
    .setChannelTypes(...textChannelTypes)
    .setMinValues(0)
    .setMaxValues(1);
  if (config.commandChannelId) commandChannelSelect.setDefaultChannels(config.commandChannelId);

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('quantum_cfg_roles')
    .setPlaceholder('Roles allowed to set/remove hours (empty = everyone)')
    .setMinValues(0)
    .setMaxValues(10);
  if (config.allowedRoleIds.length > 0) roleSelect.setDefaultRoles(...config.allowedRoleIds);

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
      .setCustomId('quantum_cfg_event')
      .setLabel('Set Event Time')
      .setStyle(ButtonStyle.Primary),
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
    components: [
      new ActionRowBuilder().addComponents(outputSelect),
      new ActionRowBuilder().addComponents(commandChannelSelect),
      new ActionRowBuilder().addComponents(roleSelect),
      actionButtons
    ],
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
    const config = await getQSConfig(pool, guildId);

    if (subcommand === 'config') {
      if (!isServerAdmin(interaction.member)) return interaction.reply({ content: ADMIN_ONLY, flags: 64 });
      const response = await interaction.reply(await buildQSConfigPayload(pool, guildId, config));
      attachAutoClose(interaction, response, 'Configuration menu');
      return;
    }

    if (!inCommandChannel(interaction, config)) {
      return interaction.reply({ content: `❌ Quantum Scheduler commands can only be used in <#${config.commandChannelId}>.`, flags: 64 });
    }

    if (subcommand === 'view') {
      await interaction.deferReply();
      return interaction.editReply(await buildQSBoardMessage(pool, interaction.guild));
    }

    if (!canSetSchedule(interaction.member, config)) {
      const roles = config.allowedRoleIds.map(id => `<@&${id}>`).join(', ');
      return interaction.reply({
        content: `❌ Setting and removing hours is limited to: ${roles}.`,
        flags: 64,
        allowedMentions: { parse: [] }
      });
    }

    if (subcommand === 'set') return handleSet(interaction, client, pool);
    if (subcommand === 'remove') return handleRemove(interaction, client, pool);
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

    if (!isServerAdmin(interaction.member)) return interaction.reply({ content: ADMIN_ONLY, flags: 64 });

    if (customId === 'quantum_cfg_event') {
      const [config, member] = await Promise.all([
        getQSConfig(pool, guildId),
        getQSMember(pool, guildId, interaction.user.id)
      ]);
      return interaction.showModal(buildEventModal(config, member?.timeZone || 'UTC'));
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
    } else if (customId === 'quantum_cfg_cmd_channel') {
      config.commandChannelId = interaction.values[0] || '';
      await saveQSConfig(pool, guildId, config);
      notice = config.commandChannelId
        ? `🔒 Commands now only work in <#${config.commandChannelId}> (and its threads). Admins can use them anywhere.`
        : '🔓 Commands work in any channel again.';
    } else if (customId === 'quantum_cfg_roles') {
      config.allowedRoleIds = [...interaction.values];
      await saveQSConfig(pool, guildId, config);
      notice = config.allowedRoleIds.length > 0
        ? `🔒 Set/remove limited to ${config.allowedRoleIds.map(id => `<@&${id}>`).join(', ')} (and admins).`
        : '🔓 Everyone can set and remove their own hours again.';
    }

    return interaction.editReply(await buildQSConfigPayload(pool, guildId, await getQSConfig(pool, guildId), notice));
  }

  if (interaction.isModalSubmit() && interaction.customId === 'quantum_cfg_event_modal') {
    if (!isServerAdmin(interaction.member)) return interaction.reply({ content: ADMIN_ONLY, flags: 64 });
    return handleEventModal(interaction, client, pool);
  }
}
