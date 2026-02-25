import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { subtractBalance } from "../balance.js";
import { addFarmPool, CROPS, FARM_FEE_RATE, type CropId } from "../farming.js";
import { buildSeedDropEmbed, buildSeedDropClaimButton } from "../seeddrop.js";
import { supabase } from "../db.js";
import { formatSats } from "../format.js";

export const data = new SlashCommandBuilder()
  .setName("seed-drop")
  .setDescription("Time-deferred sats drop — fund N crop slots, claimants harvest their share after grow time")
  .addStringOption((opt) =>
    opt
      .setName("crop")
      .setDescription("Crop type (sets the grow-time lock period)")
      .setRequired(true)
      .addChoices(
        { name: `🌾 Wheat — 10 min lock (${formatSats(CROPS.wheat.seedCostSats)}/slot)`, value: "wheat" },
        { name: `🥔 Potato — 30 min lock (${formatSats(CROPS.potato.seedCostSats)}/slot)`, value: "potato" },
        { name: `🍓 Strawberry — 2 hr lock (${formatSats(CROPS.strawberry.seedCostSats)}/slot)`, value: "strawberry" },
        { name: `🌽 Corn — 8 hr lock (${formatSats(CROPS.corn.seedCostSats)}/slot)`, value: "corn" },
      ),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("count")
      .setDescription("Number of claimants (slots to fund)")
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(20),
  )
  .toJSON();

export async function execute(interaction: ChatInputCommandInteraction) {
  const cropId = interaction.options.getString("crop", true) as CropId;
  const count = interaction.options.getInteger("count", true);
  const crop = CROPS[cropId];

  // Creator pays: seed_cost × count — the full amount goes into the farm pool
  const totalCost = crop.seedCostSats * count;
  // 10% fee stays in pool as reserve; claimants receive 90% of each slot cost
  const perYieldSats = crop.seedCostSats * (1 - FARM_FEE_RATE);
  const totalDistributed = perYieldSats * count;
  const feeRetained = totalCost - totalDistributed;

  await interaction.deferReply();

  const charged = await subtractBalance(interaction.user.id, totalCost);
  if (!charged) {
    return interaction.editReply({
      content: `❌ Insufficient balance. Funding ${count} ${crop.emoji} ${crop.name} slot${count > 1 ? "s" : ""} costs **${formatSats(totalCost)}**.`,
    });
  }

  // Full creator payment goes into the pool.
  // Pool pays out totalDistributed to claimants; feeRetained stays as reserve.
  await addFarmPool(totalCost);

  const { data: inserted } = await supabase
    .from("farm_seed_drops")
    .insert({
      channel_id: interaction.channelId!,
      creator_id: interaction.user.id,
      crop_id: cropId,
      total_claims: count,
      per_yield_sats: perYieldSats,
    })
    .select("id")
    .single();

  if (!inserted) {
    return interaction.editReply({ content: "❌ Failed to create seed drop." });
  }

  const drop = {
    id: inserted.id,
    channel_id: interaction.channelId!,
    creator_id: interaction.user.id,
    message_id: null,
    crop_id: cropId,
    total_claims: count,
    claims_count: 0,
    per_yield_sats: perYieldSats,
    status: "active",
  };

  const embed = buildSeedDropEmbed(drop, []);
  embed.addFields({
    name: "Breakdown",
    value: `Funded: **${formatSats(totalCost)}** · Distributed: **${formatSats(totalDistributed)}** · Pool fee: **${formatSats(feeRetained)}** (${Math.round(FARM_FEE_RATE * 100)}%)`,
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
