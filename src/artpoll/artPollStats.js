import { EmbedBuilder } from 'discord.js';

let tablesInitialized = false;

const ARTIFACT_EMOJIS = {
  'Transport': '<:Transport:1536709760378998834>',
  'Miner': '<:Miner:1536709782717734922>',
  'Weapon': '<:Weapon:1536709802128969738>',
  'Shield': '<:Shield:1536709830004178975>',
  'Combat': '<:Combat:1536709847083388948>',
  'Drone': '<:Drone:1536709885532573788>',
  'Fill Research': '<:FillResearch:1536709868990369812>'
};

const ORDERED_ARTIFACTS = [
  'Transport',
  'Miner',
  'Weapon',
  'Shield',
  'Combat',
  'Drone',
  'Fill Research'
];

export async function ensureStatsTablesExist(pool) {
  if (tablesInitialized) return;

  await pool.query(`
    ALTER TABLE artifact_polls 
    ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_snapshotted BOOLEAN DEFAULT FALSE;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS artifact_poll_user_votes (
      vote_id SERIAL PRIMARY KEY,
      poll_id INTEGER REFERENCES artifact_polls(poll_id) ON DELETE CASCADE,
      user_id VARCHAR(32) NOT NULL,
      option_text VARCHAR(50) NOT NULL,
      recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(poll_id, user_id, option_text)
    );
  `);

  tablesInitialized = true;
}

export async function snapshotPollVotes(client, pool, poll) {
  try {
    const channel = client.channels.cache.get(poll.channel_id) || await client.channels.fetch(poll.channel_id).catch(() => null);
    if (!channel) return false;

    const message = channel.messages.cache.get(poll.message_id) || await channel.messages.fetch(poll.message_id).catch(() => null);
    if (!message || !message.poll) return false;

    let totalVotesRecorded = 0;

    for (const answer of message.poll.answers.values()) {
      try {
        const users = await answer.voters.fetch();
        for (const [userId, user] of users) {
          if (user.bot) continue;

          await pool.query(
            `INSERT INTO artifact_poll_user_votes (poll_id, user_id, option_text)
             VALUES ($1, $2, $3)
             ON CONFLICT (poll_id, user_id, option_text) DO NOTHING`,
            [poll.poll_id, userId, answer.text]
          );
          totalVotesRecorded++;
        }
      } catch (answerErr) {
        console.error(`[Stats Snapshot] Failed to fetch voters for option "${answer.text}":`, answerErr);
      }
    }

    await pool.query(`UPDATE artifact_polls SET is_snapshotted = TRUE WHERE poll_id = $1`, [poll.poll_id]);
    console.log(`📊 Pre-closure snapshot complete for poll #${poll.poll_id}: ${totalVotesRecorded} vote(s) saved.`);
    return true;
  } catch (err) {
    console.error(`Error snapshotting poll #${poll.poll_id}:`, err);
    return false;
  }
}

export async function checkAndSnapshotPreClosure(client, pool) {
  const activeRes = await pool.query(
    `SELECT * FROM artifact_polls 
     WHERE is_closed = FALSE AND is_snapshotted = FALSE AND is_manual = FALSE`
  );

  const now = Date.now();
  const FIVE_MINUTES_MS = 5 * 60 * 1000;

  for (const poll of activeRes.rows) {
    const closesAtMs = new Date(poll.closes_at).getTime();
    if (closesAtMs - now <= FIVE_MINUTES_MS) {
      await snapshotPollVotes(client, pool, poll);
    }
  }
}

export async function getQuarterlyStats(pool, client, year, quarter, guildId) {
  const startMonth = (quarter - 1) * 3;
  const startDate = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, startMonth + 3, 1, 0, 0, 0));

  const optionSummaryRes = await pool.query(
    `SELECT v.option_text, COUNT(DISTINCT v.vote_id)::int AS total_votes, COUNT(DISTINCT v.user_id)::int AS unique_voters
     FROM artifact_poll_user_votes v
     JOIN artifact_polls p ON v.poll_id = p.poll_id
     WHERE p.is_manual = FALSE
       AND p.is_snapshotted = TRUE
       AND p.closes_at >= $1 AND p.closes_at < $2
       AND p.guild_id = $3
     GROUP BY v.option_text`,
    [startDate.toISOString(), endDate.toISOString(), guildId]
  );

  const generalMetricsRes = await pool.query(
    `SELECT COUNT(DISTINCT p.poll_id)::int AS total_polls, COUNT(DISTINCT v.user_id)::int AS total_unique_participants
     FROM artifact_polls p
     LEFT JOIN artifact_poll_user_votes v ON p.poll_id = v.poll_id
     WHERE p.is_manual = FALSE
       AND p.is_closed = TRUE
       AND p.is_snapshotted = TRUE
       AND p.closes_at >= $1 AND p.closes_at < $2
       AND p.guild_id = $3`,
    [startDate.toISOString(), endDate.toISOString(), guildId]
  );

  const userVotesRes = await pool.query(
    `SELECT v.user_id, v.option_text, COUNT(*)::int AS vote_count
     FROM artifact_poll_user_votes v
     JOIN artifact_polls p ON v.poll_id = p.poll_id
     WHERE p.is_manual = FALSE
       AND p.is_snapshotted = TRUE
       AND p.closes_at >= $1 AND p.closes_at < $2
       AND p.guild_id = $3
     GROUP BY v.user_id, v.option_text`,
    [startDate.toISOString(), endDate.toISOString(), guildId]
  );

  const optionsDbMap = new Map(optionSummaryRes.rows.map(row => [row.option_text, row]));
  const options = ORDERED_ARTIFACTS.map(artifactName => {
    const dbRow = optionsDbMap.get(artifactName);
    return {
      option_text: artifactName,
      total_votes: dbRow ? dbRow.total_votes : 0,
      unique_voters: dbRow ? dbRow.unique_voters : 0
    };
  });

  const userMap = new Map();
  for (const row of userVotesRes.rows) {
    if (!userMap.has(row.user_id)) {
      userMap.set(row.user_id, []);
    }
    userMap.get(row.user_id).push({ option: row.option_text, count: row.vote_count });
  }

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const userBreakdown = [];

  for (const [userId, choices] of userMap.entries()) {
    let username = `<@${userId}>`;
    try {
      if (guild) {
        const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
        if (member) {
          username = member.displayName || member.user.username;
        }
      }
      if (username === `<@${userId}>`) {
        const user = client.users.cache.get(userId) || await client.users.fetch(userId).catch(() => null);
        if (user) username = user.username;
      }
    } catch (_) {}

    userBreakdown.push({
      userId,
      username,
      choices
    });
  }

  return {
    year,
    quarter,
    totalPolls: generalMetricsRes.rows[0]?.total_polls || 0,
    totalParticipants: generalMetricsRes.rows[0]?.total_unique_participants || 0,
    options,
    userBreakdown
  };
}

export function buildQuarterlyReportEmbed(stats) {
  const embed = new EmbedBuilder()
    .setTitle(`📊 Artifact Research Quarterly Report — Q${stats.quarter} ${stats.year}`)
    .setColor(0x5865f2)
    .setDescription(
      `**Completed Cycles:** ${stats.totalPolls} weeks\n` +
      `**Unique Participants:** ${stats.totalParticipants} members`
    );

  const optionSummaryText = stats.options
    .map(opt => {
      const emoji = ARTIFACT_EMOJIS[opt.option_text] || '🔹';
      return `${emoji} **${opt.option_text}**: ${opt.total_votes} votes (${opt.unique_voters} members)`;
    })
    .join('\n');

  embed.addFields({ name: 'Artifact Breakdown', value: optionSummaryText });

  if (stats.userBreakdown.length > 0) {
    const userSummaryText = stats.userBreakdown
      .map(u => {
        const userChoicesMap = new Map(u.choices.map(c => [c.option, c.count]));

        const choicesText = ORDERED_ARTIFACTS
          .map(artifactName => {
            const count = userChoicesMap.get(artifactName) || 0;
            if (count === 0) return null;
            const emoji = ARTIFACT_EMOJIS[artifactName] || '';
            return `${emoji} (${count}x)`;
          })
          .filter(Boolean)
          .join(' ');

        return `• **${u.username}**: ${choicesText || '*No votes*'}`;
      })
      .join('\n');

    embed.addFields({ name: '👤 Member Activity', value: userSummaryText });
  }

  embed.setFooter({ text: 'Excludes manually terminated testing cycles • 13-week quarterly block' });
  return embed;
}