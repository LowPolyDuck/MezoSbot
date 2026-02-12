import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const supabase: SupabaseClient = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey
);

// Type exports for convenience
export type UserRow = { discord_id: string; wallet_address: string | null; balance_sats: number; created_at: string; updated_at: string };
export type LinkRow = { id: number; discord_id: string; wallet_address: string; linked_at: string };
export type DepositRow = { id: number; discord_id: string; tx_hash: string; amount_sats: number; block_number: number; created_at: string };
export type WithdrawalRow = { id: number; discord_id: string; tx_hash: string | null; amount_sats: number; to_address: string; status: string; created_at: string };
export type DropRow = { id: number; channel_id: string; creator_id: string; total_sats: number; per_claim_sats: number; max_claims: number; claims_count: number; status: string; created_at: string };
export type DropClaimRow = { id: number; drop_id: number; claimant_id: string; amount_sats: number; claimed_at: string };
export type DepositAddressRow = { discord_id: string; address: string; last_checked_balance: string };
