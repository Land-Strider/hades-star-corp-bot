import { PermissionFlagsBits } from 'discord.js';

export const DEFAULT_CONFIG = {
  enabled: true,
  channelId: '',
  allowedRoleIds: [],
  roleMentionId: '',
  pollStarted: false,
  statsEnabled: false
};

let tableInitialized = false;

// Seed data for existing active servers — applied once if DB table is empty
const INITIAL_SEEDS = [
  {
    guildId: '1536462463652995165',
    enabled: true,
    channelId: '1536756681566986354',
    allowedRoleIds: ['1536463807759781899'],
    roleMentionId: '1536463807759781899',
    pollStarted: true,
    statsEnabled: true
  },
  {
    guildId: '1536835786123776012',
    enabled: true,
    channelId: '1536835873486938142',
    allowedRoleIds: ['1536836235572678716'],
    roleMentionId: '1536836235572678716',
    pollStarted: true,
    statsEnabled: true
  },
  {
    guildId: '581734750834655243',
    enabled: true,
    channelId: '1279182022371315773',
    allowedRoleIds: ['1221454733966053376'],
    roleMentionId: '1217108421136875520',
    pollStarted: true,
    statsEnabled: true
  }
];

export async function ensureConfigTableExist(pool) {
  if (tableInitialized) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS art_poll_configs (
      guild_id VARCHAR(32) PRIMARY KEY,
      enabled BOOLEAN DEFAULT TRUE,
      channel_id VARCHAR(32) DEFAULT '',
      allowed_role_ids TEXT[] DEFAULT '{}',
      role_mention_id VARCHAR(32) DEFAULT '',
      poll_started BOOLEAN DEFAULT FALSE,
      stats_enabled BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed existing active server configs only if the table is empty
  const countRes = await pool.query(`SELECT COUNT(*)::int AS count FROM art_poll_configs`);
  if (countRes.rows[0].count === 0) {
    for (const seed of INITIAL_SEEDS) {
      await pool.query(
        `INSERT INTO art_poll_configs
         (guild_id, enabled, channel_id, allowed_role_ids, role_mention_id, poll_started, stats_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (guild_id) DO NOTHING`,
        [seed.guildId, seed.enabled, seed.channelId, seed.allowedRoleIds,
         seed.roleMentionId, seed.pollStarted, seed.statsEnabled]
      );
    }
    console.log('✅ art_poll_configs seeded with existing server configurations.');
  }

  tableInitialized = true;
}

function mapRowToConfig(row) {
  if (!row) return { ...DEFAULT_CONFIG };
  return {
    enabled: row.enabled ?? true,
    channelId: row.channel_id || '',
    allowedRoleIds: row.allowed_role_ids || [],
    roleMentionId: row.role_mention_id || '',
    pollStarted: row.poll_started ?? false,
    statsEnabled: row.stats_enabled ?? false
  };
}

export async function getArtPollConfig(pool, guildId) {
  if (!guildId) return { ...DEFAULT_CONFIG };

  await ensureConfigTableExist(pool);

  const res = await pool.query(
    `SELECT * FROM art_poll_configs WHERE guild_id = $1`,
    [guildId]
  );

  if (res.rows.length === 0) {
    // Auto-register new guilds with defaults on first access
    await pool.query(
      `INSERT INTO art_poll_configs
       (guild_id, enabled, channel_id, allowed_role_ids, role_mention_id, poll_started, stats_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (guild_id) DO NOTHING`,
      [guildId, DEFAULT_CONFIG.enabled, DEFAULT_CONFIG.channelId,
       DEFAULT_CONFIG.allowedRoleIds, DEFAULT_CONFIG.roleMentionId,
       DEFAULT_CONFIG.pollStarted, DEFAULT_CONFIG.statsEnabled]
    );
    return { ...DEFAULT_CONFIG };
  }

  return mapRowToConfig(res.rows[0]);
}

export async function saveArtPollConfig(pool, guildId, config) {
  if (!guildId) return;

  await ensureConfigTableExist(pool);

  const merged = { ...DEFAULT_CONFIG, ...config };

  await pool.query(
    `INSERT INTO art_poll_configs
     (guild_id, enabled, channel_id, allowed_role_ids, role_mention_id, poll_started, stats_enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (guild_id) DO UPDATE SET
       enabled       = EXCLUDED.enabled,
       channel_id    = EXCLUDED.channel_id,
       allowed_role_ids = EXCLUDED.allowed_role_ids,
       role_mention_id  = EXCLUDED.role_mention_id,
       poll_started  = EXCLUDED.poll_started,
       stats_enabled = EXCLUDED.stats_enabled,
       updated_at    = NOW()`,
    [guildId, merged.enabled, merged.channelId, merged.allowedRoleIds,
     merged.roleMentionId, merged.pollStarted, merged.statsEnabled]
  );
}

export async function getAllArtPollConfigs(pool) {
  await ensureConfigTableExist(pool);

  const res = await pool.query(`SELECT * FROM art_poll_configs`);
  const configs = {};
  for (const row of res.rows) {
    configs[row.guild_id] = mapRowToConfig(row);
  }
  return configs;
}

export function hasPollPermission(member, config) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (config.allowedRoleIds && config.allowedRoleIds.length > 0) {
    return config.allowedRoleIds.some(roleId => member.roles.cache.has(roleId));
  }
  return member.permissions.has(PermissionFlagsBits.ManageChannels);
}