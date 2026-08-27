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
