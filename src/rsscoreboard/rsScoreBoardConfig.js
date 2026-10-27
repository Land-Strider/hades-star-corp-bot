export const DEFAULT_RS_CONFIG = {
  channelId: '',
  displayChannelId: '',
  enabled: true,
  eventGoal: 0,
  // Required points per tier, keyed 'RS7'..'RS12' / 'DRS7'..'DRS12'. Missing or 0 = tier inactive.
  tierRequirements: {}
};

export const TIER_LEVELS = [7, 8, 9, 10, 11, 12];

export function tierKey(darkRedStar, starLevel) {
  return `${darkRedStar ? 'DRS' : 'RS'}${starLevel}`;
}

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

  await pool.query(`
    ALTER TABLE rs_scoreboard_configs
    ADD COLUMN IF NOT EXISTS event_goal BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tier_requirements JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS non_event_run_count INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_non_event_run_at TIMESTAMP WITH TIME ZONE;
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
  if (!guildId) return { ...DEFAULT_RS_CONFIG, nonEventRunCount: 0, lastNonEventRunAt: null };

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
    return { ...DEFAULT_RS_CONFIG, nonEventRunCount: 0, lastNonEventRunAt: null };
  }

  return {
    channelId: res.rows[0].channel_id || '',
    displayChannelId: res.rows[0].display_channel_id || '',
    enabled: res.rows[0].enabled ?? true,
    eventGoal: Number(res.rows[0].event_goal) || 0,
    tierRequirements: res.rows[0].tier_requirements || {},
    nonEventRunCount: res.rows[0].non_event_run_count || 0,
    lastNonEventRunAt: res.rows[0].last_non_event_run_at || null
  };
}

export async function saveRSScoreBoardConfig(pool, guildId, config) {
  if (!guildId) return;

  await ensureRSConfigTableExist(pool);

  const merged = { ...DEFAULT_RS_CONFIG, ...config };

  await pool.query(
    `INSERT INTO rs_scoreboard_configs
       (guild_id, channel_id, display_channel_id, enabled, event_goal, tier_requirements, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (guild_id) DO UPDATE SET
       channel_id         = EXCLUDED.channel_id,
       display_channel_id = EXCLUDED.display_channel_id,
       enabled            = EXCLUDED.enabled,
       event_goal         = EXCLUDED.event_goal,
       tier_requirements  = EXCLUDED.tier_requirements,
       updated_at         = NOW()`,
    [guildId, merged.channelId, merged.displayChannelId, merged.enabled, merged.eventGoal,
      JSON.stringify(merged.tierRequirements || {})]
  );
}

// Counts RedStarEnded exports outside Corp RS Events (RSEventPoints = 0), as a module health signal
export async function recordNonEventRun(pool, guildId, timestamp) {
  await ensureRSConfigTableExist(pool);

  const res = await pool.query(
    `UPDATE rs_scoreboard_configs
     SET non_event_run_count = COALESCE(non_event_run_count, 0) + 1,
         last_non_event_run_at = GREATEST(COALESCE(last_non_event_run_at, $2::timestamptz), $2::timestamptz)
     WHERE guild_id = $1
     RETURNING non_event_run_count`,
    [guildId, timestamp]
  );
  return res.rows[0]?.non_event_run_count || 0;
}
