/**
 * /shop-create — define a listing template in the community shop.
 *
 * No upfront cost. The listing is a named crop template that any user
 * can fund via /shop-drop. Each claim on a funded drop earns the listing
 * creator 5% of the seed cost as royalties (accumulated in shop_pending_sats).
 *
 * Balance gate: creator must hold ≥ 5000 sats per active listing
 * (acts as a credibility stake — not locked or charged).
 */
import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { supabase } from "../db.js";
import { CROPS, type CropId } from "../farming.js";
import { getBalance } from "../balance.js";
import { formatSats } from "../format.js";
import {
  countActiveListings,
  SHOP_CREATOR_FEE_SHARE,
  SHOP_CLAIM_THRESHOLD,
  SHOP_MIN_BALANCE,
  SHOP_SATS_PER_LISTING,
} from "../shop.js";

export const data = new SlashCommandBuilder()
  .setName("shop-create")
  .setDescription("Define a crop listing — others fund drops from it, you earn 5% of seed cost per claim")
  .addStringOption((opt) =>
    opt
      .setName("crop")
      .setDescription("Crop type for this listing")
      .setRequired(true)
      .addChoices(
        { name: `🌾 Wheat — 10 min lock · ${formatSats(CROPS.wheat.seedCostSats)}/slot · yields ${formatSats(CROPS.wheat.yieldSats)}`, value: "wheat" },
        { name: `🥔 Potato — 30 min lock · ${formatSats(CROPS.potato.seedCostSats)}/slot · yields ${formatSats(CROPS.potato.yieldSats)}`, value: "potato" },
        { name: `🍓 Strawberry — 2 hr lock · ${formatSats(CROPS.strawberry.seedCostSats)}/slot · yields ${formatSats(CROPS.strawberry.yieldSats)}`, value: "strawberry" },
        { name: `🌽 Corn — 8 hr lock · ${formatSats(CROPS.corn.seedCostSats)}/slot · yields ${formatSats(CROPS.corn.yieldSats)}`, value: "corn" },
      ),
  )
  .addStringOption((opt) =>
    opt
      .setName("name")
      .setDescription("A display name for your listing (shown to potential funders)")
      .setRequired(true)
      .setMaxLength(50),
  )
  .addStringOption((opt) =>
    opt
      .setName("description")
      .setDescription("Optional: short description of your listing")
      .setRequired(false)
      .setMaxLength(100),
  )
  .toJSON();

export async function execute(interaction: ChatInputCommandInteraction) {
  const cropId = interaction.options.getString("crop", true) as CropId;
  const name = interaction.options.getString("name", true);
  const description = interaction.options.getString("description") ?? null;
  const crop = CROPS[cropId];

  await interaction.deferReply({ ephemeral: true });

  // ── Balance gate ─────────────────────────────────────────────────────────
  const [balance, activeListings] = await Promise.all([
    getBalance(interaction.user.id),
    countActiveListings(interaction.user.id),
  ]);

  const maxListings = Math.floor((balance ?? 0) / SHOP_SATS_PER_LISTING);
  if (maxListings === 0 || activeListings >= maxListings) {
    const need = (activeListings + 1) * SHOP_SATS_PER_LISTING;
    return interaction.editReply({
      content:
        `❌ You need **${formatSats(need)}** in your balance to hold **${activeListings + 1}** active listing${activeListings + 1 !== 1 ? "s" : ""}.\n` +
        `Your balance: **${formatSats(balance ?? 0)}** · Active listings: **${activeListings}**\n` +
        `_(Your balance acts as a stake — not charged, just required to be held.)_`,
    });
  }

  // ── Create the listing ───────────────────────────────────────────────────
  const { data: inserted, error } = await supabase
    .from("shop_listings")
    .insert({
      creator_id: interaction.user.id,
      crop_id: cropId,
      name,
      description,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    return interaction.editReply({ content: "❌ Failed to create listing. Try again." });
  }

  const perClaimEarned = crop.seedCostSats * SHOP_CREATOR_FEE_SHARE;

  const embed = new EmbedBuilder()
    .setColor(0x4caf50)
    .setTitle("✅ Listing Created!")
    .setDescription(
      `Anyone can now fund drops from your listing with \`/shop-drop ${inserted.id} <count>\`.\n` +
      `You earn **${formatSats(perClaimEarned)}** per claim — automatically credited to your pending balance.`,
    )
    .addFields(
      { name: "Listing ID", value: `**#${inserted.id}**`, inline: true },
      { name: "Crop", value: `${crop.emoji} ${crop.name}`, inline: true },
      { name: "Name", value: name, inline: true },
      { name: "Seed cost/slot", value: formatSats(crop.seedCostSats), inline: true },
      { name: "Harvest yield", value: formatSats(crop.yieldSats), inline: true },
      { name: "You earn/claim", value: `**${formatSats(perClaimEarned)}** (${Math.round(SHOP_CREATOR_FEE_SHARE * 100)}%)`, inline: true },
    )
    .setFooter({
      text: `Collect earnings with /shop-claim (min ${formatSats(SHOP_CLAIM_THRESHOLD)}) · Track with /shop-mine`,
    });

  return interaction.editReply({ embeds: [embed] });
}
