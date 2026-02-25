import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { CROPS, FARM_FEE_RATE } from "../farming.js";
import { formatSats } from "../format.js";

export const data = {
  name: "seeds",
  description: "Browse crop types — grow times, yields, and seed-drop costs",
  options: [],
};

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const feePercent = Math.round(FARM_FEE_RATE * 100);

  const fields = Object.values(CROPS).map((crop) => {
    const perYield = crop.seedCostSats * (1 - FARM_FEE_RATE);
    return {
      name: `${crop.emoji} ${crop.name}`,
      value: [
        `Cost to drop: **${formatSats(crop.seedCostSats)}/slot** · Claimant earns: **${formatSats(perYield)}** after ${feePercent}% fee`,
        `Lock: **${formatDuration(crop.growMs)}** · Wither window: **${formatDuration(crop.witherMs)}** after ready`,
      ].join("\n"),
    };
  });

  const embed = new EmbedBuilder()
    .setColor(0xf0b232)
    .setTitle("🌱 Crop Reference")
    .setDescription(
      "Seeds only exist when someone funds them. Use `/seed-drop <crop> <count>` to sponsor free plantings for the community.\n" +
      "Claimants click the button to plant, then `/harvest` when the crop is ready.",
    )
    .addFields(fields)
    .setFooter({ text: `${feePercent}% of each seed-drop stays in the farm pool as reserve · Withered crops are cleared on /harvest (no refund)` });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
