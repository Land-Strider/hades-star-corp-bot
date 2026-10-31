export const DEFAULT_QS_CONFIG = {
  channelId: '',
  enabled: true,
  eventTimeMinutes: null,
  // Where members may use the commands ('' = anywhere) and who may use set/remove ([] = everyone). Admins bypass both.
  commandChannelId: '',
  allowedRoleIds: []
};

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

  // Time of day (UTC minutes) the 24 h corp event starts and ends; the day itself isn't known
  await pool.query(`
    ALTER TABLE quantum_scheduler_configs
    ADD COLUMN IF NOT EXISTS event_time_minutes SMALLINT CHECK (event_time_minutes BETWEEN 0 AND 1439);
  `);

  await pool.query(`
    ALTER TABLE quantum_scheduler_configs
    ADD COLUMN IF NOT EXISTS command_channel_id VARCHAR(32) DEFAULT '',
    ADD COLUMN IF NOT EXISTS allowed_role_ids TEXT[] DEFAULT '{}';
  `);

  // One row per Discord member who used the scheduler
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quantum_scheduler_members (
      guild_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      time_zone VARCHAR(64),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id)
    );
  `);

  // main_name = the member's main game account (their server nickname unless given); created_at orders group colours
  await pool.query(`
    ALTER TABLE quantum_scheduler_members
    ADD COLUMN IF NOT EXISTS main_name VARCHAR(64),
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
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
    boardMessageId: row.board_message_id || '',
    eventTimeMinutes: row.event_time_minutes ?? null,
    commandChannelId: row.command_channel_id || '',
    allowedRoleIds: row.allowed_role_ids || []
  };
}

export async function saveQSConfig(pool, guildId, config) {
  if (!guildId) return;

  await ensureQSTablesExist(pool);

  const merged = { ...DEFAULT_QS_CONFIG, ...config };
  await pool.query(
    `INSERT INTO quantum_scheduler_configs
       (guild_id, channel_id, enabled, event_time_minutes, command_channel_id, allowed_role_ids, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (guild_id) DO UPDATE SET
       channel_id         = EXCLUDED.channel_id,
       enabled            = EXCLUDED.enabled,
       event_time_minutes = EXCLUDED.event_time_minutes,
       command_channel_id = EXCLUDED.command_channel_id,
       allowed_role_ids   = EXCLUDED.allowed_role_ids,
       updated_at         = NOW()`,
    [guildId, merged.channelId, merged.enabled, merged.eventTimeMinutes, merged.commandChannelId, merged.allowedRoleIds]
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
    `SELECT display_name, time_zone, main_name FROM quantum_scheduler_members WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );
  const row = res.rows[0];
  return row
    ? { displayName: row.display_name, timeZone: row.time_zone || null, mainName: row.main_name || null }
    : null;
}

export async function saveQSMember(pool, guildId, userId, { displayName, timeZone, mainName }) {
  await ensureQSTablesExist(pool);
  await pool.query(
    `INSERT INTO quantum_scheduler_members (guild_id, user_id, display_name, time_zone, main_name, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       time_zone    = COALESCE(EXCLUDED.time_zone, quantum_scheduler_members.time_zone),
       main_name    = COALESCE(EXCLUDED.main_name, quantum_scheduler_members.main_name),
       updated_at   = NOW()`,
    [guildId, userId, displayName, timeZone || null, mainName || null]
  );
}

// Adds the accounts to the hours, keeping every account already there (names compare case-insensitively)
export async function addQSSlots(pool, guildId, userId, hours, names) {
  await ensureQSTablesExist(pool);
  await pool.query(
    `INSERT INTO quantum_scheduler_slots AS s (guild_id, user_id, utc_hour, names, updated_at)
     SELECT $1, $2, h, $4, NOW() FROM unnest($3::smallint[]) AS h
     ON CONFLICT (guild_id, user_id, utc_hour) DO UPDATE SET
       names = ARRAY(
         SELECT n FROM (
           SELECT DISTINCT ON (lower(n)) n, i
           FROM unnest(s.names || EXCLUDED.names) WITH ORDINALITY AS t(n, i)
           ORDER BY lower(n), i
         ) d ORDER BY i
       ),
       updated_at = NOW()`,
    [guildId, userId, hours, names]
  );
}

// Renames one of the member's accounts in every hour (case-insensitive), merging it into the new name where both exist.
// Keeps a member's main under a single name when it changes.
export async function renameQSAccount(pool, guildId, userId, oldName, newName) {
  await ensureQSTablesExist(pool);
  const res = await pool.query(
    `UPDATE quantum_scheduler_slots
     SET names = ARRAY(
           SELECT n FROM (
             SELECT DISTINCT ON (lower(n)) n, i
             FROM unnest(ARRAY(
               SELECT CASE WHEN lower(x) = lower($3) THEN $4 ELSE x END
               FROM unnest(names) WITH ORDINALITY AS u(x, o) ORDER BY o
             )) WITH ORDINALITY AS t(n, i)
             ORDER BY lower(n), i
           ) d ORDER BY i
         ),
         updated_at = NOW()
     WHERE guild_id = $1 AND user_id = $2
       AND EXISTS (SELECT 1 FROM unnest(names) AS n WHERE lower(n) = lower($3))`,
    [guildId, userId, oldName, newName]
  );
  return res.rowCount;
}

// hours = null means every hour; accounts = null means every account.
// Returns the number of hours that lost at least one account.
export async function removeQSSlots(pool, guildId, userId, hours = null, accounts = null) {
  await ensureQSTablesExist(pool);

  if (!accounts) {
    const res = await pool.query(
      `DELETE FROM quantum_scheduler_slots
       WHERE guild_id = $1 AND user_id = $2 AND ($3::smallint[] IS NULL OR utc_hour = ANY($3::smallint[]))`,
      [guildId, userId, hours]
    );
    return res.rowCount;
  }

  const lowered = accounts.map(a => a.toLowerCase());
  const res = await pool.query(
    `UPDATE quantum_scheduler_slots
     SET names = ARRAY(SELECT n FROM unnest(names) AS n WHERE lower(n) <> ALL($4::text[])), updated_at = NOW()
     WHERE guild_id = $1 AND user_id = $2 AND ($3::smallint[] IS NULL OR utc_hour = ANY($3::smallint[]))
       AND EXISTS (SELECT 1 FROM unnest(names) AS n WHERE lower(n) = ANY($4::text[]))`,
    [guildId, userId, hours, lowered]
  );
  await pool.query(
    `DELETE FROM quantum_scheduler_slots WHERE guild_id = $1 AND user_id = $2 AND cardinality(names) = 0`,
    [guildId, userId]
  );
  return res.rowCount;
}

// Every account name the member has on the schedule, main first
export async function getQSMemberAccounts(pool, guildId, userId) {
  const [member, slots] = await Promise.all([
    getQSMember(pool, guildId, userId),
    getQSMemberSlots(pool, guildId, userId)
  ]);
  const names = [];
  for (const slot of slots) {
    for (const name of slot.names) if (!names.some(n => n.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  const main = member?.mainName?.toLowerCase();
  return names.sort((a, b) => (b.toLowerCase() === main) - (a.toLowerCase() === main));
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
    `SELECT s.user_id, s.utc_hour, s.names, m.display_name, m.main_name, m.created_at
     FROM quantum_scheduler_slots s
     JOIN quantum_scheduler_members m ON m.guild_id = s.guild_id AND m.user_id = s.user_id
     WHERE s.guild_id = $1
     ORDER BY s.utc_hour, lower(m.display_name), s.user_id`,
    [guildId]
  );

  // Every member's names in a stable order: main first, then alts in order of appearance
  const members = new Map();
  for (const row of res.rows) {
    let member = members.get(row.user_id);
    if (!member) {
      member = { userId: row.user_id, displayName: row.display_name, mainName: row.main_name, createdAt: row.created_at, names: [] };
      members.set(row.user_id, member);
    }
    for (const name of row.names) if (!member.names.includes(name)) member.names.push(name);
  }
  for (const member of members.values()) {
    const mainIndex = member.names.findIndex(n => n.toLowerCase() === member.mainName?.toLowerCase());
    if (mainIndex > 0) member.names.unshift(...member.names.splice(mainIndex, 1));
    member.main = mainIndex >= 0 ? member.names[0] : null;
    member.hasAlts = member.names.length > 1;
  }

  // Each member with alts gets its own box colours, in the order they joined the scheduler
  [...members.values()]
    .filter(m => m.hasAlts)
    .sort((a, b) => (new Date(a.createdAt) - new Date(b.createdAt)) || a.userId.localeCompare(b.userId))
    .forEach((member, i) => { member.colorIndex = i; });

  // Solo members (no alts) get their own name colour instead, so their hours are easy to follow across slots
  [...members.values()]
    .filter(m => !m.hasAlts)
    .sort((a, b) => (new Date(a.createdAt) - new Date(b.createdAt)) || a.userId.localeCompare(b.userId))
    .forEach((member, i) => { member.soloColorIndex = i; });

  const columns = Array.from({ length: 24 }, (_, hour) => ({ hour, entries: [], people: 0, accounts: 0 }));
  for (const row of res.rows) {
    const member = members.get(row.user_id);
    const names = member.names.filter(name => row.names.includes(name));
    const column = columns[row.utc_hour];
    column.entries.push({
      userId: member.userId,
      displayName: member.displayName,
      names,
      main: member.main,
      hasAlts: member.hasAlts,
      colorIndex: member.colorIndex ?? 0,
      soloColorIndex: member.soloColorIndex ?? 0
    });
    column.people++;
    column.accounts += names.length;
  }

  // Stacking order from the line up: members with several accounts in the slot, then members who have alts but
  // only one account in this slot (still boxed), then solo accounts. Sort is stable, so names stay alphabetical.
  const stackTier = entry => (!entry.hasAlts ? 2 : entry.names.length > 1 ? 0 : 1);
  for (const column of columns) column.entries.sort((a, b) => stackTier(a) - stackTier(b));

  const accountKeys = new Set();
  for (const member of members.values()) {
    for (const name of member.names) accountKeys.add(`${member.userId}:${name.toLowerCase()}`);
  }

  const people = members.size;
  const totalSlots = res.rows.length;
  const coveredHours = columns.filter(c => c.people > 0).length;
  const busiest = columns
    .filter(c => c.people > 0)
    .sort((a, b) => (b.people - a.people) || (b.accounts - a.accounts) || (a.hour - b.hour))
    .slice(0, 6)
    .map(c => ({ hour: c.hour, people: c.people, accounts: c.accounts }));

  return {
    columns,
    stats: {
      people,
      totalSlots,
      avgSlots: people > 0 ? totalSlots / people : 0,
      avgPeoplePerHour: totalSlots / 24,
      avgPeoplePerCoveredHour: coveredHours > 0 ? totalSlots / coveredHours : 0,
      coveredHours,
      accounts: accountKeys.size,
      peopleWithAlts: [...members.values()].filter(m => m.hasAlts).length,
      busiest
    }
  };
}
