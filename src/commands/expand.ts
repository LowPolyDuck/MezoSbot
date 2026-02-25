import type { ChatInputCommandInteraction } from "discord.js";
import { expandFarm, PLOT_EXPANSION_COSTS, INITIAL_PLOTS, MAX_PLOTS } from "../farming.js";
import { formatSats } from "../format.js";

export const data = {
  name: "expand",
  description: "Purchase a new farm plot slot to grow more crops simultaneously",
  options: [],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const result = await expandFarm(interaction.user.id);

  if (!result.ok) {
    return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
  }

  const { newSlot, cost } = result;

  // Show cost of the next slot if there is one
  const nextSlot = newSlot! + 1;
  const nextCostIndex = nextSlot - INITIAL_PLOTS;
  const nextCost = PLOT_EXPANSION_COSTS[nextCostIndex];
  const nextInfo = nextSlot < MAX_PLOTS && nextCost !== undefined
    ? ` Next expansion (slot ${nextSlot}) costs ${formatSats(nextCost)}.`
    : " Your farm is now at maximum size!";

  await interaction.reply({
    content: [
      `🌱 New plot unlocked! Slot \`[${newSlot}]\` added to your farm.`,
      `Spent ${formatSats(cost!)} · Now at ${newSlot! + 1}/${MAX_PLOTS} plots.${nextInfo}`,
      `Run \`/plant\` to start growing.`,
    ].join("\n"),
    ephemeral: true,
  });
}
