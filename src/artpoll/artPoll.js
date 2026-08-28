import { ensureStatsTablesExist, checkAndSnapshotPreClosure, snapshotPollVotes } from './artPollStats.js';

export { getArtPollConfig, saveArtPollConfig, getAllArtPollConfigs } from './artPollConfig.js';
export { artPollCommand } from './artPollCommands.js';
export { checkAndSnapshotPreClosure } from './artPollStats.js';

export const ART_OPTIONS = [
  { text: 'Transport', emoji: { id: '1536709760378998834' } },
  { text: 'Miner', emoji: { id: '1536709782717734922' } },
  { text: 'Weapon', emoji: { id: '1536709802128969738' } },
  { text: 'Shield', emoji: { id: '1536709830004178975' } },
  { text: 'Combat', emoji: { id: '1536709847083388948' } },
  { text: 'Drone', emoji: { id: '1536709885532573788' } },
  { text: 'Fill Research', emoji: { id: '1536709868990369812' } }
];

export function getNextSundayClosure() {
  const now = new Date();
  const nextSunday = new Date(now);
  const day = nextSunday.getUTCDay();
  const diff = (7 - day) % 7;
  nextSunday.setUTCDate(nextSunday.getUTCDate() + diff);
  nextSunday.setUTCHours(2, 59, 0, 0);

  if (nextSunday <= now) {
    nextSunday.setUTCDate(nextSunday.getUTCDate() + 7);
  }
  return nextSunday;
}

export async function terminateActivePoll(client, pool, guildId = null) {
  const activeRes = guildId
    ? await pool.query(`SELECT * FROM artifact_polls WHERE guild_id = $1 AND is_closed = FALSE`, [guildId])
    : await pool.query(`SELECT * FROM artifact_polls WHERE is_closed = FALSE`);

  for (const poll of activeRes.rows) {
    try {
      const channel = client.channels.cache.get(poll.channel_id) || await client.channels.fetch(poll.channel_id).catch(() => null);
      if (channel) {
        const message = channel.messages.cache.get(poll.message_id) || await channel.messages.fetch(poll.message_id).catch(() => null);
        if (message && message.poll) {
          await message.poll.end().catch(() => null);
        }
      }
      await pool.query(`UPDATE artifact_polls SET is_closed = TRUE, is_manual = TRUE WHERE poll_id = $1`, [poll.poll_id]);
      console.log(`⏹️ Terminated poll #${poll.poll_id}`);
    } catch (err) {
      console.error(`Error terminating poll #${poll.poll_id}:`, err);
    }
  }
}

export async function deleteActivePoll(client, pool, guildId = null, isManual = false) {
  const activeRes = guildId
    ? await pool.query(`SELECT * FROM artifact_polls WHERE guild_id = $1 AND is_closed = FALSE`, [guildId])
    : await pool.query(`SELECT * FROM artifact_polls WHERE is_closed = FALSE`);

  for (const poll of activeRes.rows) {
    try {
      if (!poll.is_snapshotted) {
        await snapshotPollVotes(client, pool, poll);
      }

      const channel = client.channels.cache.get(poll.channel_id) || await client.channels.fetch(poll.channel_id).catch(() => null);
      if (channel) {
        const message = channel.messages.cache.get(poll.message_id) || await channel.messages.fetch(poll.message_id).catch(() => null);
        if (message) {
          if (message.poll) {
            await message.poll.end().catch(() => null);
            setTimeout(() => {
              message.delete().catch(() => null);
            }, 2500);
          } else {
            await message.delete().catch(() => null);
          }
        }
      }
      await pool.query(`UPDATE artifact_polls SET is_closed = TRUE, is_manual = $1 WHERE poll_id = $2`, [isManual, poll.poll_id]);
      console.log(`🗑️ Terminated poll #${poll.poll_id} (is_manual: ${isManual}, deletion scheduled in 2.5s)`);
    } catch (err) {
      console.error(`Error deleting poll #${poll.poll_id}:`, err);
    }
  }
}

export async function closeActivePolls(client, pool, guildId = null) {
  return deleteActivePoll(client, pool, guildId);
}

export async function createNewArtifactPoll(client, pool, channelId, guildId) {
  const config = getArtPollConfig(guildId);

  const targetChannelId = channelId || config.channelId;
  const channel = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId).catch(() => null);
  if (!channel) {
    console.error(`Poll channel ${targetChannelId} not found for guild ${guildId}.`);
    return false;
  }

  const mentionRoleId = config.roleMentionId;
  const roleMention = mentionRoleId ? `<@&${mentionRoleId}>` : '';

  const closesAt = getNextSundayClosure();

  const message = await channel.send({
    content: roleMention,
    poll: {
      question: { text: "What type of artifact are you researching this week?" },
      answers: ART_OPTIONS.map(opt => ({
        text: opt.text,
        emoji: opt.emoji
      })),
      duration: 168,
      allowMultiselect: true
    }
  });

  await pool.query(
    `INSERT INTO artifact_polls (guild_id, channel_id, message_id, closes_at) VALUES ($1, $2, $3, $4)`,
    [guildId || channel.guild.id, targetChannelId, message.id, closesAt]
  );

  config.pollStarted = true;
  saveArtPollConfig(guildId, config);

  console.log(`✅ Native artifact poll posted to target ${targetChannelId} in guild ${guildId}, closing at ${closesAt.toISOString()}.`);
  return true;
}

export async function ensureActivePoll(client, pool) {
  const configs = getAllArtPollConfigs();

  for (const [guildId, config] of Object.entries(configs)) {
    if (!config.enabled || !config.pollStarted) continue;

    if (config.statsEnabled) {
      await ensureStatsTablesExist(pool);
      await checkAndSnapshotPreClosure(client, pool);
    }

    const activeRes = await pool.query(
      `SELECT * FROM artifact_polls WHERE guild_id = $1 AND is_closed = FALSE`,
      [guildId]
    );

    if (activeRes.rows.length > 0) {
      const poll = activeRes.rows[0];
      const channel = client.channels.cache.get(poll.channel_id) || await client.channels.fetch(poll.channel_id).catch(() => null);
      if (channel) {
        const message = channel.messages.cache.get(poll.message_id) || await channel.messages.fetch(poll.message_id).catch(() => null);
        if (message) continue;
      }
      await pool.query(`UPDATE artifact_polls SET is_closed = TRUE WHERE poll_id = $1`, [poll.poll_id]);
    }

    if (config.channelId) {
      await createNewArtifactPoll(client, pool, config.channelId, guildId);
    }
  }
}

export async function handleArtPollInteraction(interaction, client, pool) {
  return executeInteraction(interaction, client, pool, { terminateActivePoll, deleteActivePoll, createNewArtifactPoll });
}