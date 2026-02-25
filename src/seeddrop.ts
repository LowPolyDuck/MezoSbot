/**
 * Seed drop logic — lets users sponsor free crop plantings for others.
 *
 * Flow:
 *   1. Creator runs /seed-drop <crop> <count>
 *   2. Seed cost (crop.seedCostSats × count) is deducted from creator and deposited into the farm pool.
 *   3. An embed with a claim button is posted in the channel.
 *   4. Users click "Claim Seeds" → crop is planted in their first empty plot (no charge to them).
 *   5. When they /harvest, the yield is drawn from the farm pool as normal.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type TextChannel,
} from "discord.js";
import { supabase } from "./db.js";
import { plantFromSeedDrop, addFarmPool, CROPS, type CropId } from "./farming.js";
import { formatSats } from "./format.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SeedDrop {
  id: number;
  channel_id: string;
  creator_id: string;
  message_id: string | null;
  crop_id: CropId;
  total_claims: number;
  claims_count: number;
  per_yield_sats: number;
  status: string;
}

export interface SeedDropClaimResult {
  ok: boolean;
  error?: string;
  slot?: number;
  remaining?: number;
  completed?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Embed + button builders                                            */
/* ------------------------------------------------------------------ */

export function buildSeedDropEmbed(drop: SeedDrop, claimedBy: string[]): EmbedBuilder {
  const crop = CROPS[drop.crop_id];
  const remaining = drop.total_claims - drop.claims_count;
  const completed = drop.status === "completed";

  const embed = new EmbedBuilder()
    .setColor(completed ? 0x95a5a6 : 0x4caf50)
    .setTitle("🌱 Seed Drop!")
    .setDescription(
      `<@${drop.creator_id}> is sponsoring **${drop.total_claims}** free ${crop.emoji} **${crop.name}** planting${drop.total_claims > 1 ? "s" : ""}!`,
    )
    .addFields(
      { name: "Crop", value: `${crop.emoji} ${crop.name}`, inline: true },
      { name: "Claimed", value: `**${drop.claims_count}/${drop.total_claims}**`, inline: true },
      { name: "Remaining", value: completed ? "✅ All claimed!" : `**${remaining}**`, inline: true },
    )
    .setTimestamp();

  if (!completed) {
    embed.addFields({
      name: "How it works",
      value: `Claim to plant ${crop.emoji} ${crop.name} for free — \`/harvest\` after **${formatDuration(crop.growMs)}** to earn **${formatSats(drop.per_yield_sats)}**!`,
    });
  }

  if (claimedBy.length > 0) {
    embed.addFields({
      name: "Claimed By",
      value: claimedBy.map((id) => `<@${id}>`).join(", "),
    });
  }

  if (completed) {
    embed.setFooter({ text: "This seed drop has ended" });
  }

  return embed;
}

export function buildSeedDropClaimButton(dropId: number, disabled = false) {
  const button = new ButtonBuilder()
    .setCustomId(`claim_seed_drop_${dropId}`)
    .setLabel("🌱 Claim Seeds")
    .setStyle(ButtonStyle.Success)
    .setDisabled(disabled);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/* ------------------------------------------------------------------ */
/*  Claimants query                                                    */
/* ------------------------------------------------------------------ */

export async function getSeedDropClaimants(dropId: number): Promise<string[]> {
  const { data } = await supabase
    .from("farm_seed_claims")
    .select("claimant_id")
    .eq("drop_id", dropId)
    .order("claimed_at", { ascending: true });
  return (data ?? []).map((r) => r.claimant_id);
}

/* ------------------------------------------------------------------ */
/*  Claim processing                                                   */
/* ------------------------------------------------------------------ */

export async function processSeedDropClaim(
  dropId: number,
  claimantId: string,
): Promise<SeedDropClaimResult> {
  // Fetch the latest drop state
  const { data: drop } = await supabase
    .from("farm_seed_drops")
    .select("*")
    .eq("id", dropId)
    .single();

  if (!drop || drop.status !== "active" || drop.claims_count >= drop.total_claims) {
    return { ok: false, error: "This seed drop is no longer active." };
  }

  if (drop.creator_id === claimantId) {
    return { ok: false, error: "You can't claim your own seed drop." };
  }

  // Check for duplicate claim
  const { data: existing } = await supabase
    .from("farm_seed_claims")
    .select("id")
    .eq("drop_id", dropId)
    .eq("claimant_id", claimantId)
    .single();

  if (existing) {
    return { ok: false, error: "You've already claimed from this seed drop." };
  }

  // Plant the crop with the drop's specific yield (free — pool was funded by creator)
  const plantResult = await plantFromSeedDrop(claimantId, drop.crop_id as CropId, drop.per_yield_sats);
  if (!plantResult.ok) {
    return { ok: false, error: plantResult.error };
  }

  // Record the claim
  const { error: claimError } = await supabase.from("farm_seed_claims").insert({
    drop_id: dropId,
    claimant_id: claimantId,
    slot_planted: plantResult.slot,
  });

  if (claimError) {
    // Race condition: duplicate claim
    return { ok: false, error: "You've already claimed from this seed drop." };
  }

  // Update drop state
  const newCount = drop.claims_count + 1;
  const completed = newCount >= drop.total_claims;
  await supabase
    .from("farm_seed_drops")
    .update({ claims_count: newCount, status: completed ? "completed" : "active" })
    .eq("id", dropId);

  // Creator economy: if this drop was created via /shop-drop, credit the listing
  // creator's pending earnings. listing_creator_id is the template author;
  // creator_id is the user who funded this specific drop (may differ).
  if (drop.creator_fee_share > 0 && drop.listing_creator_id) {
    const crop = CROPS[drop.crop_id as CropId];
    const creatorFee = crop.seedCostSats * drop.creator_fee_share;
    // Draw the creator's share out of the pool (pool got 100% of seedCost at funding;
    // only pool_fee_share belongs to it — the rest is the creator's royalty).
    await addFarmPool(-creatorFee);
    // Credit listing creator's pending balance (gated by /shop-claim threshold)
    await supabase.rpc("add_shop_pending", {
      p_discord_id: drop.listing_creator_id,
      p_amount: creatorFee,
    });
  }

  return {
    ok: true,
    slot: plantResult.slot,
    remaining: drop.total_claims - newCount,
    completed,
  };
}

/* ------------------------------------------------------------------ */
/*  Update the original seed drop message                             */
/* ------------------------------------------------------------------ */

export async function updateSeedDropMessage(
  client: Client,
  drop: SeedDrop,
): Promise<void> {
  if (!drop.message_id || !drop.channel_id) return;

  try {
    const channel = await client.channels.fetch(drop.channel_id);
    if (!channel || !("messages" in channel)) return;

    const msg = await (channel as TextChannel).messages.fetch(drop.message_id);
    if (!msg) return;

    const { data: freshDrop } = await supabase
      .from("farm_seed_drops")
      .select("*")
      .eq("id", drop.id)
      .single();

    if (!freshDrop) return;

    const claimedBy = await getSeedDropClaimants(drop.id);
    const embed = buildSeedDropEmbed(freshDrop as SeedDrop, claimedBy);
    const row = buildSeedDropClaimButton(drop.id, freshDrop.status === "completed");

    await msg.edit({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(
      `Failed to update seed drop message ${drop.message_id}:`,
      (err as Error)?.message ?? err,
    );
  }
}
