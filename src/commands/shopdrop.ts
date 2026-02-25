/**
 * /shop-drop <listing_id> <count> — fund a seed drop using a creator's listing.
 *
 * Works exactly like /seed-drop but:
 *   - References a shop_listings template (creator earns royalties per claim)
 *   - creator_fee_share = 0.05: 5% of seed cost per claim → listing creator's pending
 *   - The funder (hoster) pays the standard seed cost; the listing creator pays nothing
 *   - The embed credits both the funder and the listing creator
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { subtractBalance } from "../balance.js";
import { addFarmPool, CROPS, FARM_FEE_RATE } from "../farming.js";
import { buildSeedDropEmbed, buildSeedDropClaimButton, type SeedDrop } from "../seeddrop.js";
import { supabase } from "../db.js";
import { formatSats } from "../format.js";
import { getListingById, SHOP_CREATOR_FEE_SHARE, SHOP_CLAIM_THRESHOLD } from "../shop.js";

export const data = new SlashCommandBuilder()
  .setName("shop-drop")
  .setDescription("Fund a drop from a creator's shop listing — they earn a 5% royalty per claim")
  .addIntegerOption((opt) =>
    opt
      .setName("listing")
      .setDescription("Listing ID from /shop")
      .setRequired(true)
      .setMinValue(1),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("count")
      .setDescription("Number of claimant slots to fund")
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(20),
  )
  .toJSON();

export async function execute(interaction: ChatInputCommandInteraction) {
  const listingId = interaction.options.getInteger("listing", true);
  const count = interaction.options.getInteger("count", true);

  await interaction.deferReply();

  // ── Validate listing ─────────────────────────────────────────────────────
  const listing = await getListingById(listingId);
  if (!listing || listing.status !== "active") {
    return interaction.editReply({ content: `❌ Listing **#${listingId}** not found or no longer active.` });
  }

  const crop = CROPS[listing.crop_id];
  const totalCost = crop.seedCostSats * count;
  const perYieldSats = crop.seedCostSats * (1 - FARM_FEE_RATE); // claimants get 90%
  const perCreatorEarned = crop.seedCostSats * SHOP_CREATOR_FEE_SHARE;

  // ── Charge the funder ────────────────────────────────────────────────────
  const charged = await subtractBalance(interaction.user.id, totalCost);
  if (!charged) {
    return interaction.editReply({
      content:
        `❌ Insufficient balance. Funding **${count}** ${crop.emoji} ${crop.name} slot${count > 1 ? "s" : ""} ` +
        `costs **${formatSats(totalCost)}**.`,
    });
  }

  // Full payment into pool (same as regular seed drop)
  await addFarmPool(totalCost);

  // ── Create the seed drop linked to the listing ───────────────────────────
  const { data: inserted } = await supabase
    .from("farm_seed_drops")
    .insert({
      channel_id: interaction.channelId!,
      creator_id: interaction.user.id,         // funder shown in embed
      crop_id: listing.crop_id,
      total_claims: count,
      per_yield_sats: perYieldSats,
      creator_fee_share: SHOP_CREATOR_FEE_SHARE,
      listing_id: listing.id,
      listing_creator_id: listing.creator_id,  // royalty recipient
    })
    .select("id")
    .single();

  if (!inserted) {
    return interaction.editReply({ content: "❌ Failed to create drop. Try again." });
  }

  const drop: SeedDrop = {
    id: inserted.id,
    channel_id: interaction.channelId!,
    creator_id: interaction.user.id,
    message_id: null,
    crop_id: listing.crop_id,
    total_claims: count,
    claims_count: 0,
    per_yield_sats: perYieldSats,
    status: "active",
  };

  const embed = buildSeedDropEmbed(drop, []);
  // Annotate the embed to show the listing creator
  embed.addFields({
    name: "🛒 Shop Listing",
    value:
      `**"${listing.name}"** by <@${listing.creator_id}> · ` +
      `Listing **#${listing.id}** · Creator earns **${formatSats(perCreatorEarned)}**/claim (collect via \`/shop-claim\` at ${formatSats(SHOP_CLAIM_THRESHOLD)})`,
  });

  const row = buildSeedDropClaimButton(inserted.id);
  const reply = await interaction.editReply({
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [] },
  });

  await supabase
    .from("farm_seed_drops")
    .update({ message_id: reply.id })
    .eq("id", inserted.id);
}
