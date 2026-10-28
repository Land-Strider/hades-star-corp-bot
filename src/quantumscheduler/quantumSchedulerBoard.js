import { AttachmentBuilder } from 'discord.js';
import { getQSConfig, getAllQSConfigs, getQSScheduleData, saveQSBoardMessage } from './quantumSchedulerConfig.js';
import { renderQSTimeline } from './quantumSchedulerRenderer.js';

// Serializes board edits per guild so concurrent /set calls and the refresh cron never post duplicate boards
const boardUpdateQueues = new Map();

// The image alone, so Discord shows it at full message width (an embed would shrink it)
export async function buildQSBoardMessage(pool, guild) {
  const [data, config] = await Promise.all([getQSScheduleData(pool, guild.id), getQSConfig(pool, guild.id)]);
  const image = await renderQSTimeline({
    ...data,
    guildName: guild.name,
    eventTimeMinutes: config.eventTimeMinutes,
    now: new Date()
  });
  return { content: '', embeds: [], files: [new AttachmentBuilder(image, { name: 'quantum_schedule.png' })] };
}

async function fetchChannel(client, channelId) {
  return client.channels.cache.get(channelId) || client.channels.fetch(channelId).catch(() => null);
}

// Edits the guild's board message, or posts it (and removes the old one) when the output channel changed.
// Returns true when the board is up to date in the output channel.
async function publishQSBoard(client, pool, guildId) {
  const config = await getQSConfig(pool, guildId);
  if (!config.enabled || !config.channelId) return false;

  const guild = client.guilds.cache.get(guildId);
  const channel = await fetchChannel(client, config.channelId);
  if (!guild || !channel) {
    console.error(`[QuantumScheduler] Output channel ${config.channelId} not reachable in guild ${guildId}`);
    return false;
  }

  const payload = await buildQSBoardMessage(pool, guild);

  if (config.boardMessageId) {
    const boardChannel = config.boardChannelId === config.channelId ? channel : await fetchChannel(client, config.boardChannelId);
    const existing = boardChannel ? await boardChannel.messages.fetch(config.boardMessageId).catch(() => null) : null;

    if (existing && config.boardChannelId === config.channelId) {
      await existing.edit({ ...payload, attachments: [] });
      return true;
    }
    if (existing) await existing.delete().catch(() => null);
  }

  const sent = await channel.send(payload);
  await saveQSBoardMessage(pool, guildId, config.channelId, sent.id);
  console.log(`📢 [QuantumScheduler] Posted schedule board to channel ${config.channelId} in guild ${guildId}`);
  return true;
}

export function queueQSBoardUpdate(client, pool, guildId) {
  const previous = boardUpdateQueues.get(guildId) || Promise.resolve();
  const next = previous.then(() => publishQSBoard(client, pool, guildId)).catch(err => {
    console.error('Error publishing Quantum Scheduler board:', err);
    return false;
  });
  boardUpdateQueues.set(guildId, next);
  return next;
}

// Re-renders every enabled board so the current-hour highlight and now marker move along
export async function refreshAllQSBoards(client, pool) {
  const guildIds = await getAllQSConfigs(pool);
  await Promise.allSettled(
    guildIds
      .filter(id => id !== 'default' && client.guilds.cache.has(id))
      .map(id => queueQSBoardUpdate(client, pool, id))
  );
}
