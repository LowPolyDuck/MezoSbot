-- MezoSbot: Supabase Postgres Schema
-- Paste this into your Supabase SQL Editor and run it.

CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  wallet_address TEXT UNIQUE,
  balance_sats DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

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

CREATE OR REPLACE FUNCTION subtract_balance_if_sufficient(
  p_discord_id TEXT,
  p_amount     DOUBLE PRECISION
)
RETURNS boolean AS $func$
DECLARE
  rows_updated INTEGER;
BEGIN
  UPDATE users
  SET balance_sats = balance_sats - p_amount,
      updated_at   = now()
  WHERE discord_id  = p_discord_id
    AND balance_sats >= p_amount;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END;
$func$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS game_saves (
  rom_name   TEXT PRIMARY KEY,
  save_data  TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_links_discord ON links(discord_id);
CREATE INDEX IF NOT EXISTS idx_links_wallet ON links(wallet_address);
CREATE INDEX IF NOT EXISTS idx_deposits_tx ON deposits(tx_hash);
CREATE INDEX IF NOT EXISTS idx_deposits_discord ON deposits(discord_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_discord ON withdrawals(discord_id);
CREATE INDEX IF NOT EXISTS idx_drops_channel ON drops(channel_id);

-- Farmville-style farming game
CREATE TABLE IF NOT EXISTS farm_plots (
  discord_id  TEXT    NOT NULL,
  slot        INTEGER NOT NULL,
  crop_id     TEXT,            -- null = empty plot
  planted_at  TIMESTAMPTZ,     -- null = empty plot
  PRIMARY KEY (discord_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_farm_plots_discord ON farm_plots(discord_id);

-- yield_sats: overrides the crop's default yield for seed-drop claims.
-- NULL = use the standard CROPS[crop_id].yieldSats from code.
ALTER TABLE farm_plots ADD COLUMN IF NOT EXISTS yield_sats DOUBLE PRECISION;

-- Shared pool that pays harvest yields and receives seed costs.
-- Funded by: regular seed purchases, seed drops, and /farm-fund donations.
-- Drained by: successful harvest payouts.
-- Wither losses stay in the pool (no refund), acting as natural self-funding.
CREATE TABLE IF NOT EXISTS farm_pool (
  id           INTEGER PRIMARY KEY DEFAULT 1,
  balance_sats DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT farm_pool_single_row CHECK (id = 1)
);
INSERT INTO farm_pool (id, balance_sats) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- Seed drops: time-deferred sats drops. Creator funds N plantings; each claimant
-- plants and harvests after the crop's grow time to receive per_yield_sats.
-- The 10% fee stays in the pool as reserve (creator pays 100%, 90% distributed).
CREATE TABLE IF NOT EXISTS farm_seed_drops (
  id              BIGSERIAL PRIMARY KEY,
  channel_id      TEXT             NOT NULL,
  creator_id      TEXT             NOT NULL,
  message_id      TEXT,
  crop_id         TEXT             NOT NULL,
  total_claims    INTEGER          NOT NULL,
  claims_count    INTEGER          NOT NULL DEFAULT 0,
  per_yield_sats  DOUBLE PRECISION NOT NULL, -- sats each claimant receives on harvest
  status          TEXT             NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS farm_seed_claims (
  id           BIGSERIAL PRIMARY KEY,
  drop_id      BIGINT NOT NULL REFERENCES farm_seed_drops(id),
  claimant_id  TEXT   NOT NULL,
  slot_planted INTEGER,
  claimed_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(drop_id, claimant_id)
);

CREATE INDEX IF NOT EXISTS idx_seed_drops_channel ON farm_seed_drops(channel_id);

-- Atomic pool operations
CREATE OR REPLACE FUNCTION add_farm_pool(p_amount DOUBLE PRECISION)
RETURNS void AS $$
BEGIN
  UPDATE farm_pool SET balance_sats = balance_sats + p_amount WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION subtract_farm_pool_if_sufficient(p_amount DOUBLE PRECISION)
RETURNS boolean AS $func$
DECLARE
  rows_updated INTEGER;
BEGIN
  UPDATE farm_pool
  SET balance_sats = balance_sats - p_amount
  WHERE id = 1 AND balance_sats >= p_amount;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END;
$func$ LANGUAGE plpgsql;

-- ── Creator Economy: Community Shop ──────────────────────────────────────────
--
-- Creators define listing TEMPLATES (crop type + name/description).
-- Any user can then run /shop-drop <listing_id> <count> to SPONSOR a drop
-- using the creator's template — the hoster pays the normal seed cost.
-- When claimants harvest, the listing creator earns a royalty (5% of seed cost).
--
-- Fee split per claim on a shop drop:
--   90% → claimant harvest yield        (unchanged from regular seed drop)
--    5% → listing creator's pending     (SHOP_CREATOR_FEE_SHARE)
--    5% → pool reserve                  (SHOP_POOL_FEE_SHARE)
--
-- Balance gate: creators must hold ≥ 5000 sats per active listing.
-- Earnings accumulate in shop_pending_sats until /shop-claim threshold is reached.

-- Listing templates — created by creators, used by hosters
CREATE TABLE IF NOT EXISTS shop_listings (
  id          BIGSERIAL PRIMARY KEY,
  creator_id  TEXT NOT NULL,
  crop_id     TEXT NOT NULL,
  name        TEXT NOT NULL,       -- display name (max 50 chars)
  description TEXT,                -- optional (max 100 chars)
  status      TEXT NOT NULL DEFAULT 'active', -- active | removed
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_listings_creator ON shop_listings(creator_id);
CREATE INDEX IF NOT EXISTS idx_shop_listings_status  ON shop_listings(status);

-- creator_fee_share: fraction of seedCostSats paid to listing_creator_id on each claim.
-- 0.00 = regular /seed-drop (full 10% fee stays in pool)
-- 0.05 = /shop-drop using a template (5% to creator, 5% stays in pool)
ALTER TABLE farm_seed_drops ADD COLUMN IF NOT EXISTS creator_fee_share    DOUBLE PRECISION NOT NULL DEFAULT 0;
-- listing_id / listing_creator_id: set when this drop was created via /shop-drop
ALTER TABLE farm_seed_drops ADD COLUMN IF NOT EXISTS listing_id           BIGINT REFERENCES shop_listings(id);
ALTER TABLE farm_seed_drops ADD COLUMN IF NOT EXISTS listing_creator_id   TEXT;

-- Pending shop earnings on users table (separate from main balance — gated by threshold)
ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_pending_sats DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Atomic: add sats to a creator's pending shop earnings
CREATE OR REPLACE FUNCTION add_shop_pending(p_discord_id TEXT, p_amount DOUBLE PRECISION)
RETURNS void AS $$
BEGIN
  UPDATE users
  SET shop_pending_sats = shop_pending_sats + p_amount
  WHERE discord_id = p_discord_id;
END;
$$ LANGUAGE plpgsql;

-- Atomic: if pending >= threshold, move all pending → balance and return amount moved; else 0
CREATE OR REPLACE FUNCTION claim_shop_pending(p_discord_id TEXT, p_threshold DOUBLE PRECISION)
RETURNS DOUBLE PRECISION AS $$
DECLARE
  v_pending DOUBLE PRECISION;
BEGIN
  SELECT shop_pending_sats INTO v_pending FROM users WHERE discord_id = p_discord_id;
  IF v_pending IS NULL OR v_pending < p_threshold THEN
    RETURN 0;
  END IF;
  UPDATE users
  SET balance_sats      = balance_sats + v_pending,
      shop_pending_sats = 0,
      updated_at        = now()
  WHERE discord_id = p_discord_id;
  RETURN v_pending;
END;
$$ LANGUAGE plpgsql;
