import { getRSScoreBoardConfig } from './rsScoreBoardConfig.js';
import { buildRSBoardMessage } from './rsScoreBoardCommands.js';

export { rsScoreBoardCommand, handleRSScoreBoardInteraction } from './rsScoreBoardCommands.js';
export { getRSScoreBoardConfig, saveRSScoreBoardConfig, ensureRSConfigTableExist } from './rsScoreBoardConfig.js';

// Runs further apart than this belong to different Corp RS Events (events last 48 h and recur every 28 days)
const EVENT_GAP_MS = 96 * 60 * 60 * 1000;
const MAX_JSON_ATTACHMENT_BYTES = 1024 * 1024;

// Serializes leaderboard message edits per guild so concurrent runs don't post duplicate boards
const boardUpdateQueues = new Map();

async function extractPayloads(message) {
  const texts = [];

  const jsonMatch = message.content?.match(/\{[\s\S]*\}/);
  if (jsonMatch) texts.push(jsonMatch[0]);

  for (const attachment of message.attachments.values()) {
    const isJson = attachment.name?.toLowerCase().endsWith('.json') ||
      attachment.contentType?.includes('json');
    if (!isJson || attachment.size > MAX_JSON_ATTACHMENT_BYTES) continue;

    try {
      const res = await fetch(attachment.url);
      if (res.ok) texts.push(await res.text());
    } catch (err) {
      console.error(`[RSScoreBoard] Failed to download attachment ${attachment.name}:`, err);
    }
  }

  const payloads = [];
  for (const text of texts) {
    try {
      const payload = JSON.parse(text.replace(/^﻿/, ''));
      if (payload && typeof payload === 'object') payloads.push(payload);
    } catch (_) {
      // Not JSON, ignore
    }
  }
  return payloads;
}

// Returns a normalized run, or null if the payload is not a scoring RedStarEnded export
export function parseRSRun(payload) {
  if (!payload || payload.EventType !== 'RedStarEnded') return null;

  // RSEventPoints is 0 outside an active Corp RS Event
  const points = parseInt(payload.RSEventPoints, 10);
  if (isNaN(points) || points <= 0) return null;

  const starSystemId = payload.StarSystemID;
  if (!starSystemId) return null;

  const players = (Array.isArray(payload.PlayersWhoContributed) ? payload.PlayersWhoContributed : [])
    .filter(p => p && p.PlayerID)
    .filter((p, i, arr) => arr.findIndex(q => q.PlayerID === p.PlayerID) === i)
    .map(p => ({ playerId: p.PlayerID, playerName: p.PlayerName || 'Unknown' }));
  if (players.length === 0) return null;

  const timestamp = payload.Timestamp ? new Date(payload.Timestamp) : new Date();

  return {
    starSystemId,
    starLevel: parseInt(payload.StarLevel, 10) || 0,
    darkRedStar: Boolean(payload.DarkRedStar),
    points,
    players,
    corpId: payload.Corporation?.CorporationID || null,
    corpName: payload.Corporation?.CorporationName || null,
    timestamp: isNaN(timestamp.getTime()) ? new Date() : timestamp
  };
}

// Stores a run and assigns it to its Corp RS Event. Returns { runId, eventId } or null for a duplicate.
// `pool` may be a pg Pool (a client is checked out for the transaction) or anything with .query().
export async function recordRSRun(pool, guildId, run, sourceMessageId = null) {
  const ownsClient = typeof pool.connect === 'function' && typeof pool.release !== 'function';
  const db = ownsClient ? await pool.connect() : pool;

  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rs_event:${guildId}`]);

    const eventRes = await db.query(
      `SELECT event_id FROM rs_events
       WHERE guild_id = $1
         AND started_at <= $2::timestamptz + $3 * INTERVAL '1 millisecond'
         AND last_run_at >= $2::timestamptz - $3 * INTERVAL '1 millisecond'
       ORDER BY started_at DESC
       LIMIT 1`,
      [guildId, run.timestamp, EVENT_GAP_MS]
    );

    let eventId;
    if (eventRes.rows.length > 0) {
      eventId = eventRes.rows[0].event_id;
      await db.query(
        `UPDATE rs_events
         SET started_at = LEAST(started_at, $2), last_run_at = GREATEST(last_run_at, $2)
         WHERE event_id = $1`,
        [eventId, run.timestamp]
      );
    } else {
      const newEvent = await db.query(
        `INSERT INTO rs_events (guild_id, started_at, last_run_at)
         VALUES ($1, $2, $2)
         RETURNING event_id`,
        [guildId, run.timestamp]
      );
      eventId = newEvent.rows[0].event_id;
    }

    const runRes = await db.query(
      `INSERT INTO rs_event_runs
         (event_id, guild_id, star_system_id, star_level, dark_red_star, rs_event_points,
          participant_count, corporation_id, corporation_name, timestamp, source_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (guild_id, star_system_id) DO NOTHING
       RETURNING run_id`,
      [eventId, guildId, run.starSystemId, run.starLevel, run.darkRedStar, run.points,
        run.players.length, run.corpId, run.corpName, run.timestamp, sourceMessageId]
    );

    if (runRes.rows.length === 0) {
      // Run already ingested (duplicate export ignored)
      await db.query('ROLLBACK');
      return null;
    }

    const runId = runRes.rows[0].run_id;

    for (const player of run.players) {
      await db.query(
        `INSERT INTO rs_event_participants (run_id, player_id, player_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (run_id, player_id) DO NOTHING`,
        [runId, player.playerId, player.playerName.substring(0, 64)]
      );
    }

    await db.query('COMMIT');
    return { runId, eventId };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => null);
    throw err;
  } finally {
    if (ownsClient) db.release();
  }
}

// Edits the event's leaderboard message in the display channel, or posts it if it doesn't exist yet
async function publishRSBoard(client, pool, guildId, eventId, displayChannelId) {
  const channel = client.channels.cache.get(displayChannelId) ||
    await client.channels.fetch(displayChannelId).catch(() => null);
  if (!channel) {
    console.error(`[RSScoreBoard] Display channel ${displayChannelId} not reachable in guild ${guildId}`);
    return;
  }

  const eventRes = await pool.query(
    `SELECT board_channel_id, board_message_id FROM rs_events WHERE event_id = $1`,
    [eventId]
  );
  const event = eventRes.rows[0];
  const payload = await buildRSBoardMessage(pool, guildId, eventId);

  if (event?.board_message_id && event.board_channel_id === displayChannelId) {
    const existing = await channel.messages.fetch(event.board_message_id).catch(() => null);
    if (existing) {
      await existing.edit({ ...payload, attachments: [] });
      return;
    }
  }

  const sent = await channel.send(payload);
  await pool.query(
    `UPDATE rs_events SET board_channel_id = $2, board_message_id = $3 WHERE event_id = $1`,
    [eventId, displayChannelId, sent.id]
  );
  console.log(`📢 [RSScoreBoard] Posted leaderboard for event #${eventId} to channel ${displayChannelId}`);
}

function queueBoardUpdate(guildId, task) {
  const previous = boardUpdateQueues.get(guildId) || Promise.resolve();
  const next = previous.then(task).catch(err => {
    console.error('Error publishing RS ScoreBoard image:', err);
  });
  boardUpdateQueues.set(guildId, next);
  return next;
}

export async function handleRSMessageCreate(message, client, pool) {
  if (!message || !message.guild) return;
  if (message.author?.id === client?.user?.id) return;

  const guildId = message.guild.id;
  const config = await getRSScoreBoardConfig(pool, guildId);

  if (!config.enabled || !config.channelId) return;
  if (message.channelId !== config.channelId) return;

  const payloads = await extractPayloads(message);
  const eventIds = new Set();

  for (const payload of payloads) {
    const run = parseRSRun(payload);
    if (!run) continue;

    try {
      const result = await recordRSRun(pool, guildId, run, message.id);
      if (!result) continue;

      eventIds.add(result.eventId);
      console.log(`⭐ [RSScoreBoard] Recorded ${run.points} pts split across ${run.players.length} player(s) in guild ${guildId} (Run #${result.runId}, Event #${result.eventId})`);
    } catch (err) {
      console.error('Error inserting RS ScoreBoard event run:', err);
    }
  }

  if (eventIds.size === 0) return;

  await message.react('✅').catch(() => null);

  if (config.displayChannelId && client) {
    for (const eventId of eventIds) {
      await queueBoardUpdate(guildId, () => publishRSBoard(client, pool, guildId, eventId, config.displayChannelId));
    }
  }
}
