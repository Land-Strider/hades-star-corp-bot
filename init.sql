CREATE TABLE IF NOT EXISTS rs_scoreboard_configs (
    guild_id VARCHAR(32) PRIMARY KEY,
    channel_id VARCHAR(32) DEFAULT '',
    display_channel_id VARCHAR(32) DEFAULT '',
    enabled BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rs_events (
    event_id SERIAL PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_run_at TIMESTAMP WITH TIME ZONE NOT NULL,
    board_channel_id VARCHAR(32) DEFAULT '',
    board_message_id VARCHAR(32) DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS rs_events_guild_started_idx ON rs_events (guild_id, started_at DESC);

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

CREATE TABLE IF NOT EXISTS rs_event_participants (
    run_id INT REFERENCES rs_event_runs(run_id) ON DELETE CASCADE,
    player_id VARCHAR(128) NOT NULL,
    player_name VARCHAR(64) NOT NULL,
    PRIMARY KEY (run_id, player_id)
);

CREATE TABLE IF NOT EXISTS artifact_polls (
    poll_id SERIAL PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL,
    channel_id VARCHAR(32) NOT NULL,
    message_id VARCHAR(32) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closes_at TIMESTAMP NOT NULL,
    is_closed BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS artifact_votes (
    poll_id INT REFERENCES artifact_polls(poll_id) ON DELETE CASCADE,
    user_id VARCHAR(32) NOT NULL,
    user_display_name VARCHAR(64) NOT NULL,
    option_key VARCHAR(32) NOT NULL,
    PRIMARY KEY (poll_id, user_id, option_key)
);

CREATE TABLE IF NOT EXISTS ws_events (
    event_id SERIAL PRIMARY KEY,
    host_guild_id VARCHAR(32) NOT NULL,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    start_time TIMESTAMP NOT NULL,
    min_host_participants INT DEFAULT 5,
    relay_visible BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ws_relay_messages (
    event_id INT REFERENCES ws_events(event_id) ON DELETE CASCADE,
    guild_id VARCHAR(32) NOT NULL,
    channel_id VARCHAR(32) NOT NULL,
    message_id VARCHAR(32) NOT NULL,
    PRIMARY KEY (event_id, guild_id)
);

CREATE TABLE IF NOT EXISTS ws_participants (
    event_id INT REFERENCES ws_events(event_id) ON DELETE CASCADE,
    user_id VARCHAR(32) NOT NULL,
    user_display_name VARCHAR(64) NOT NULL,
    home_guild_id VARCHAR(32) NOT NULL,
    role VARCHAR(32) NOT NULL,
    note VARCHAR(100),
    PRIMARY KEY (event_id, user_id)
);
