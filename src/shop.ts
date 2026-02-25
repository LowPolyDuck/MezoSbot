/**
 * Creator Economy — Listing templates + royalty drops.
 *
 * Flow:
 *   1. Creator runs /shop-create → defines a listing template (no upfront cost).
 *      Requires SHOP_MIN_BALANCE sats held per active listing.
 *   2. Any user runs /shop-drop <listing_id> <count> → sponsors a drop using
 *      the creator's template. Hoster pays standard seed cost into the pool.
 *   3. Claimants click the button, harvest normally.
 *   4. On each claim: SHOP_CREATOR_FEE_SHARE (5%) of seedCostSats goes to the
 *      listing creator's pending balance; SHOP_POOL_FEE_SHARE (5%) stays in pool.
 *      Claimants still receive 90% (per_yield_sats) — unchanged.
 *   5. Creator runs /shop-claim once pending ≥ SHOP_CLAIM_THRESHOLD.
 */
import { EmbedBuilder } from "discord.js";
import { supabase } from "./db.js";
import { CROPS, FARM_FEE_RATE, type CropId } from "./farming.js";
import { formatSats } from "./format.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Fraction of seedCostSats credited to the listing creator's pending per claim. */
export const SHOP_CREATOR_FEE_SHARE = FARM_FEE_RATE / 2; // 0.05
/** Fraction of seedCostSats that stays in the pool (other half of the normal fee). */
export const SHOP_POOL_FEE_SHARE = FARM_FEE_RATE / 2;    // 0.05
/** Minimum pending earnings before /shop-claim is allowed. */
export const SHOP_CLAIM_THRESHOLD = 100;
/** Sats a creator must hold per active listing slot. */
export const SHOP_MIN_BALANCE = 5000;
export const SHOP_SATS_PER_LISTING = SHOP_MIN_BALANCE;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ShopListing {
  id: number;
  creator_id: string;
  crop_id: CropId;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/*  Listing queries                                                    */
/* ------------------------------------------------------------------ */

export async function getActiveListings(): Promise<ShopListing[]> {
  const { data } = await supabase
    .from("shop_listings")
    .select("*")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(10);
  return (data ?? []) as ShopListing[];
}

export async function getListingById(id: number): Promise<ShopListing | null> {
  const { data } = await supabase
    .from("shop_listings")
    .select("*")
    .eq("id", id)
    .single();
  return (data ?? null) as ShopListing | null;
}

export async function getCreatorListings(creatorId: string): Promise<ShopListing[]> {
  const { data } = await supabase
    .from("shop_listings")
    .select("*")
    .eq("creator_id", creatorId)
    .order("created_at", { ascending: false })
    .limit(20);
  return (data ?? []) as ShopListing[];
}

export async function countActiveListings(creatorId: string): Promise<number> {
  const { count } = await supabase
    .from("shop_listings")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", creatorId)
    .eq("status", "active");
  return count ?? 0;
}

/* ------------------------------------------------------------------ */
/*  Earnings queries                                                   */
/* ------------------------------------------------------------------ */

export async function getPendingEarnings(discordId: string): Promise<number> {
  const { data } = await supabase
    .from("users")
    .select("shop_pending_sats")
    .eq("discord_id", discordId)
    .single();
  return (data as { shop_pending_sats?: number } | null)?.shop_pending_sats ?? 0;
}

/** Move pending earnings → main balance if ≥ threshold. Returns amount moved (0 = not enough). */
export async function claimShopEarnings(discordId: string): Promise<number> {
  const { data } = await supabase.rpc("claim_shop_pending", {
    p_discord_id: discordId,
    p_threshold: SHOP_CLAIM_THRESHOLD,
  });
  return (data as number | null) ?? 0;
}

/** Total claims ever made on drops tied to a creator's listings. */
export async function getTotalClaimsForCreator(creatorId: string): Promise<number> {
  const { data } = await supabase
    .from("farm_seed_drops")
    .select("claims_count")
    .eq("listing_creator_id", creatorId);
  return (data ?? []).reduce((sum, row: { claims_count: number }) => sum + (row.claims_count ?? 0), 0);
}

/* ------------------------------------------------------------------ */
/*  Embed builder                                                      */
/* ------------------------------------------------------------------ */

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

export function buildShopEmbed(listings: ShopListing[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xf0b232)
    .setTitle("🛒 Community Seed Shop")
    .setTimestamp();

  const creatorPct = Math.round(SHOP_CREATOR_FEE_SHARE * 100);

  if (listings.length === 0) {
    return embed
      .setDescription(
        "No listings yet.\n" +
        "Run `/shop-create` to define a crop listing — anyone can then fund drops from it " +
        "and you earn **" + creatorPct + "%** of seed cost per claim!",
      )
      .setFooter({ text: `Need ${formatSats(SHOP_MIN_BALANCE)} balance per listing slot` });
  }

  embed.setDescription(
    `**${listings.length}** listing${listings.length !== 1 ? "s" : ""} · ` +
    `Fund a drop with \`/shop-drop <id> <count>\` · ` +
    `Creator earns **${creatorPct}%** of seed cost per claim`,
  );

  for (const listing of listings) {
    const crop = CROPS[listing.crop_id];
    const perClaimEarned = crop.seedCostSats * SHOP_CREATOR_FEE_SHARE;
    embed.addFields({
      name: `#${listing.id} · ${crop.emoji} ${crop.name} · "${listing.name}"`,
      value: [
        listing.description ?? "No description.",
        `Grow time: **${formatDuration(crop.growMs)}** · Harvest yield: **${formatSats(crop.yieldSats)}** · Creator earns **${formatSats(perClaimEarned)}**/claim`,
        `Listed by <@${listing.creator_id}> · Fund it: \`/shop-drop ${listing.id} <count>\``,
      ].join("\n"),
    });
  }

  embed.setFooter({
    text: `Earn threshold: ${formatSats(SHOP_CLAIM_THRESHOLD)} · /shop-mine to track · /shop-claim to collect`,
  });
  return embed;
}
