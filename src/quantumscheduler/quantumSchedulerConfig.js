export const DEFAULT_QS_CONFIG = {
  channelId: '',
  enabled: true
};

export const MAX_NAMES_PER_SLOT = 6;

let tableInitialized = false;

export async function ensureQSTablesExist(pool) {
  if (tableInitialized) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quantum_scheduler_configs (
      guild_id VARCHAR(32) PRIMARY KEY,
      channel_id VARCHAR(32) DEFAULT '',
      enabled BOOLEAN DEFAULT TRUE,
      board_channel_id VARCHAR(32) DEFAULT '',
      board_message_id VARCHAR(32) DEFAULT '',
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // One row per Discord member who used the scheduler. default_names are reused when /set gets no names.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quantum_scheduler_members (
      guild_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      time_zone VARCHAR(64),
      default_names TEXT[] DEFAULT '{}',
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id)
    );
  `);

  // One row per member per UTC hour. names = the game accounts (main and alts) that member brings to that hour.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quantum_scheduler_slots (
      guild_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      utc_hour SMALLINT NOT NULL CHECK (utc_hour BETWEEN 0 AND 23),
      names TEXT[] NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id, utc_hour)
    );
  `);

  tableInitialized = true;
}

export async function getQSConfig(pool, guildId) {
  if (!guildId) return { ...DEFAULT_QS_CONFIG, boardChannelId: '', boardMessageId: '' };

  await ensureQSTablesExist(pool);

  const res = await pool.query(`SELECT * FROM quantum_scheduler_configs WHERE guild_id = $1`, [guildId]);
  const row = res.rows[0];
  if (!row) return { ...DEFAULT_QS_CONFIG, boardChannelId: '', boardMessageId: '' };

  return {
    channelId: row.channel_id || '',
    enabled: row.enabled ?? true,
    boardChannelId: row.board_channel_id || '',
    boardMessageId: row.board_message_id || ''
  };
}

export async function saveQSConfig(pool, guildId, config) {
  if (!guildId) return;

  await ensureQSTablesExist(pool);

  const merged = { ...DEFAULT_QS_CONFIG, ...config };
  await pool.query(
    `INSERT INTO quantum_scheduler_configs (guild_id, channel_id, enabled, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (guild_id) DO UPDATE SET
       channel_id = EXCLUDED.channel_id,
       enabled    = EXCLUDED.enabled,
       updated_at = NOW()`,
    [guildId, merged.channelId, merged.enabled]
  );
}

export async function saveQSBoardMessage(pool, guildId, channelId, messageId) {
  await pool.query(
    `UPDATE quantum_scheduler_configs SET board_channel_id = $2, board_message_id = $3 WHERE guild_id = $1`,
    [guildId, channelId, messageId]
  );
}

export async function getAllQSConfigs(pool) {
  await ensureQSTablesExist(pool);
  const res = await pool.query(
    `SELECT guild_id FROM quantum_scheduler_configs WHERE enabled AND channel_id <> ''`
  );
  return res.rows.map(r => r.guild_id);
}

export async function getQSMember(pool, guildId, userId) {
  await ensureQSTablesExist(pool);
  const res = await pool.query(
    `SELECT display_name, time_zone, default_names FROM quantum_scheduler_members WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );
  const row = res.rows[0];
  return row
    ? { displayName: row.display_name, timeZone: row.time_zone || null, defaultNames: row.default_names || [] }
    : null;
}

export async function saveQSMember(pool, guildId, userId, { displayName, timeZone, defaultNames }) {
  await ensureQSTablesExist(pool);
  await pool.query(
    `INSERT INTO quantum_scheduler_members (guild_id, user_id, display_name, time_zone, default_names, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       display_name  = EXCLUDED.display_name,
       time_zone     = COALESCE(EXCLUDED.time_zone, quantum_scheduler_members.time_zone),
       default_names = CASE WHEN cardinality(EXCLUDED.default_names) > 0
                            THEN EXCLUDED.default_names ELSE quantum_scheduler_members.default_names END,
       updated_at    = NOW()`,
    [guildId, userId, displayName, timeZone || null, defaultNames || []]
  );
}

export async function setQSSlots(pool, guildId, userId, hours, names) {
  await ensureQSTablesExist(pool);
  await pool.query(
    `INSERT INTO quantum_scheduler_slots (guild_id, user_id, utc_hour, names, updated_at)
     SELECT $1, $2, h, $4, NOW() FROM unnest($3::smallint[]) AS h
     ON CONFLICT (guild_id, user_id, utc_hour) DO UPDATE SET
       names = EXCLUDED.names,
       updated_at = NOW()`,
    [guildId, userId, hours, names]
  );
}

// hours = null removes every slot of the member. Returns the number of slots removed.
export async function removeQSSlots(pool, guildId, userId, hours = null) {
  await ensureQSTablesExist(pool);
  const res = await pool.query(
    `DELETE FROM quantum_scheduler_slots
     WHERE guild_id = $1 AND user_id = $2 AND ($3::smallint[] IS NULL OR utc_hour = ANY($3::smallint[]))`,
    [guildId, userId, hours]
  );
  return res.rowCount;
}

export async function getQSMemberSlots(pool, guildId, userId) {
  await ensureQSTablesExist(pool);
  const res = await pool.query(
    `SELECT utc_hour, names FROM quantum_scheduler_slots WHERE guild_id = $1 AND user_id = $2 ORDER BY utc_hour`,
    [guildId, userId]
  );
  return res.rows.map(r => ({ hour: r.utc_hour, names: r.names }));
}

// The whole guild schedule: 24 UTC hour columns of members, each with the game accounts they bring,
// plus the summary numbers shown on the board and in /quantum scheduler config.
export async function getQSScheduleData(pool, guildId) {
  await ensureQSTablesExist(pool);

  const res = await pool.query(
    `SELECT s.user_id, s.utc_hour, s.names, m.display_name, m.default_names
     FROM quantum_scheduler_slots s
     JOIN quantum_scheduler_members m ON m.guild_id = s.guild_id AND m.user_id = s.user_id
     WHERE s.guild_id = $1
     ORDER BY s.utc_hour, lower(m.display_name), s.user_id`,
    [guildId]
  );

  // Every member's names in a stable order: their default names first (the first one is the main), then others
  const members = new Map();
  for (const row of res.rows) {
    let member = members.get(row.user_id);
    if (!member) {
      member = { userId: row.user_id, displayName: row.display_name, names: [...(row.default_names || [])], used: new Set() };
      members.set(row.user_id, member);
    }
    for (const name of row.names) {
      member.used.add(name);
      if (!member.names.includes(name)) member.names.push(name);
    }
  }
  for (const member of members.values()) {
    member.names = member.names.filter(name => member.used.has(name));
    member.main = member.names[0];
    member.hasAlts = member.names.length > 1;
  }

  const columns = Array.from({ length: 24 }, (_, hour) => ({ hour, entries: [], people: 0, accounts: 0 }));
  for (const row of res.rows) {
    const member = members.get(row.user_id);
    const names = member.names.filter(name => row.names.includes(name));
    const column = columns[row.utc_hour];
    column.entries.push({ userId: member.userId, displayName: member.displayName, names, main: member.main, hasAlts: member.hasAlts });
    column.people++;
    column.accounts += names.length;
  }

  const accountKeys = new Set();
  for (const member of members.values()) {
    for (const name of member.names) accountKeys.add(`${member.userId}:${name.toLowerCase()}`);
  }

  const people = members.size;
  const totalSlots = res.rows.length;
  const busiest = columns.reduce((best, c) => (c.people > best.people ? c : best), columns[0]);

  return {
    columns,
    stats: {
      people,
      totalSlots,
      avgSlots: people > 0 ? totalSlots / people : 0,
      accounts: accountKeys.size,
      peopleWithAlts: [...members.values()].filter(m => m.hasAlts).length,
      busiestHour: busiest.people > 0 ? busiest.hour : null,
      busiestPeople: busiest.people
    }
  };
}
