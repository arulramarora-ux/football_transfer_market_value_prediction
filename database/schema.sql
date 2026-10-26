-- Neon/PostgreSQL schema for Touchline.
-- Imported source data remains separate from derived prediction features.
CREATE TABLE IF NOT EXISTS players (
  player_id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  current_club_name TEXT,
  position TEXT,
  sub_position TEXT,
  domestic_competition_id TEXT,
  date_of_birth DATE,
  image_url TEXT,
  market_value_in_eur BIGINT,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS players_name_search_idx ON players (normalized_name text_pattern_ops);
CREATE INDEX IF NOT EXISTS players_club_idx ON players (lower(current_club_name));
CREATE INDEX IF NOT EXISTS players_position_idx ON players (lower(position));
CREATE INDEX IF NOT EXISTS players_value_idx ON players (market_value_in_eur DESC);

CREATE TABLE IF NOT EXISTS valuations (
  player_id BIGINT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  date DATE NOT NULL,
  market_value_in_eur BIGINT,
  data JSONB NOT NULL,
  PRIMARY KEY (player_id, date)
);
CREATE INDEX IF NOT EXISTS valuations_date_idx ON valuations (player_id, date DESC);

CREATE TABLE IF NOT EXISTS appearance_months (
  player_id BIGINT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  month_key INTEGER NOT NULL,
  appearances INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  minutes_played INTEGER NOT NULL DEFAULT 0,
  yellow_cards INTEGER NOT NULL DEFAULT 0,
  red_cards INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, month_key)
);

CREATE TABLE IF NOT EXISTS season_performance (
  player_id BIGINT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  season_end DATE NOT NULL,
  appearances INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  minutes_played INTEGER NOT NULL DEFAULT 0,
  clean_sheets INTEGER NOT NULL DEFAULT 0,
  goals_conceded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, season_end)
);

CREATE TABLE IF NOT EXISTS role_grades (
  player_id BIGINT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  season_end DATE NOT NULL,
  grade DOUBLE PRECISION NOT NULL,
  coverage DOUBLE PRECISION NOT NULL,
  minutes INTEGER NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (player_id, season_end)
);
CREATE TABLE IF NOT EXISTS competitions (
  competition_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domestic_league_code TEXT
);
CREATE TABLE IF NOT EXISTS transfer_monthly (
  group_key TEXT NOT NULL,
  month_key INTEGER NOT NULL,
  transfer_count INTEGER NOT NULL,
  log_ratio_sum DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (group_key, month_key)
);
CREATE TABLE IF NOT EXISTS player_transfer_monthly (
  player_id BIGINT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  month_key INTEGER NOT NULL,
  transfer_count INTEGER NOT NULL,
  log_ratio_sum DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (player_id, group_key, month_key)
);
