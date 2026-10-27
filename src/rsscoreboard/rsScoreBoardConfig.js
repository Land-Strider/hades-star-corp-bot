export const DEFAULT_RS_CONFIG = {
  channelId: '',
  displayChannelId: '',
  enabled: true
};

let tableInitialized = false;

export async function ensureRSConfigTableExist(pool) {
  if (tableInitialized) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rs_scoreboard_configs (
      guild_id VARCHAR(32) PRIMARY KEY,
      channel_id VARCHAR(32) DEFAULT '',
      display_channel_id VARCHAR(32) DEFAULT '',
      enabled BOOLEAN DEFAULT TRUE,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE rs_scoreboard_configs
    ADD COLUMN IF NOT EXISTS display_channel_id VARCHAR(32) DEFAULT '';
  `);

  // One row per Corp RS Event (a cluster of runs with RSEventPoints > 0)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rs_events (
      event_id SERIAL PRIMARY KEY,
      guild_id VARCHAR(32) NOT NULL,
      started_at TIMESTAMP WITH TIME ZONE NOT NULL,
      last_run_at TIMESTAMP WITH TIME ZONE NOT NULL,
      board_channel_id VARCHAR(32) DEFAULT '',
      board_message_id VARCHAR(32) DEFAULT '',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS rs_events_guild_started_idx ON rs_events (guild_id, started_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rs_event_runs (
      run_id SERIAL PRIMARY KEY,
      event_id INT NOT NULL REFERENCES rs_events(event_id) ON DELETE CASCADE,
      guild_id VARCHAR(32) NOT NULL,
      star_system_id VARCHAR(128) NOT NULL,
      star_level INT NOT NULL,
      dark_red_star BOOLEAN DEFAULT FALSE,
      rs_event_points INT NOT NULL,
      participant_count INT NOT NULL,
      corporation_id VARCHAR(128),
      corporation_name VARCHAR(64),
      timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
      source_message_id VARCHAR(32),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (guild_id, star_system_id)
    );
  `);

  // Each contributor's share is rs_event_points / participant_count, computed at query time
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rs_event_participants (
      run_id INT REFERENCES rs_event_runs(run_id) ON DELETE CASCADE,
      player_id VARCHAR(128) NOT NULL,
      player_name VARCHAR(64) NOT NULL,
      PRIMARY KEY (run_id, player_id)
    );
  `);

  tableInitialized = true;
}

export async function getRSScoreBoardConfig(pool, guildId) {
  if (!guildId) return { ...DEFAULT_RS_CONFIG };

  await ensureRSConfigTableExist(pool);

  const res = await pool.query(
    `SELECT * FROM rs_scoreboard_configs WHERE guild_id = $1`,
    [guildId]
  );

  if (res.rows.length === 0) {
    await pool.query(
      `INSERT INTO rs_scoreboard_configs (guild_id, channel_id, display_channel_id, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id) DO NOTHING`,
      [guildId, DEFAULT_RS_CONFIG.channelId, DEFAULT_RS_CONFIG.displayChannelId, DEFAULT_RS_CONFIG.enabled]
    );
    return { ...DEFAULT_RS_CONFIG };
  }

  return {
    channelId: res.rows[0].channel_id || '',
    displayChannelId: res.rows[0].display_channel_id || '',
    enabled: res.rows[0].enabled ?? true
  };
}

export async function saveRSScoreBoardConfig(pool, guildId, config) {
  if (!guildId) return;

  await ensureRSConfigTableExist(pool);

  const merged = { ...DEFAULT_RS_CONFIG, ...config };

  await pool.query(
    `INSERT INTO rs_scoreboard_configs (guild_id, channel_id, display_channel_id, enabled, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (guild_id) DO UPDATE SET
       channel_id         = EXCLUDED.channel_id,
       display_channel_id = EXCLUDED.display_channel_id,
       enabled            = EXCLUDED.enabled,
       updated_at         = NOW()`,
    [guildId, merged.channelId, merged.displayChannelId, merged.enabled]
  );
}
