-- MezoSbot: Supabase Postgres Schema
-- Paste this into your Supabase SQL Editor and run it.

CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  wallet_address TEXT UNIQUE,
  balance_sats DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS links (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL UNIQUE,
  linked_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(discord_id, wallet_address)
);

CREATE TABLE IF NOT EXISTS deposits (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  amount_sats DOUBLE PRECISION NOT NULL,
  block_number INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  tx_hash TEXT,
  amount_sats DOUBLE PRECISION NOT NULL,
  to_address TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS drops (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  message_id TEXT,
  total_sats DOUBLE PRECISION NOT NULL,
  per_claim_sats DOUBLE PRECISION NOT NULL,
  max_claims INTEGER NOT NULL,
  claims_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drop_claims (
  id BIGSERIAL PRIMARY KEY,
  drop_id BIGINT NOT NULL REFERENCES drops(id),
  claimant_id TEXT NOT NULL,
  amount_sats DOUBLE PRECISION NOT NULL,
  claimed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(drop_id, claimant_id)
);

CREATE TABLE IF NOT EXISTS deposit_addresses (
  discord_id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  last_checked_balance TEXT DEFAULT '0'
);

-- RPC functions for atomic balance updates
CREATE OR REPLACE FUNCTION add_balance(p_discord_id TEXT, p_amount DOUBLE PRECISION)
RETURNS void AS $$
BEGIN
  UPDATE users
  SET balance_sats = balance_sats + p_amount, updated_at = now()
  WHERE discord_id = p_discord_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION subtract_balance(p_discord_id TEXT, p_amount DOUBLE PRECISION)
RETURNS void AS $$
BEGIN
  UPDATE users
  SET balance_sats = balance_sats - p_amount, updated_at = now()
  WHERE discord_id = p_discord_id;
END;
$$ LANGUAGE plpgsql;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_links_discord ON links(discord_id);
CREATE INDEX IF NOT EXISTS idx_links_wallet ON links(wallet_address);
CREATE INDEX IF NOT EXISTS idx_deposits_tx ON deposits(tx_hash);
CREATE INDEX IF NOT EXISTS idx_deposits_discord ON deposits(discord_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_discord ON withdrawals(discord_id);
CREATE INDEX IF NOT EXISTS idx_drops_channel ON drops(channel_id);
