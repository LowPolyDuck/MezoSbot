import type { ChatInputCommandInteraction } from "discord.js";
import { getBalance } from "../balance.js";
import { getOrInitPlots, buildFarmEmbed, getFarmPoolBalance } from "../farming.js";

export const data = {
  name: "farm",
  description: "View your farm — plots, growing crops, pool balance, and what's ready to harvest",
  options: [],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const userId = interaction.user.id;
  const [plots, balance, poolBalance] = await Promise.all([
    getOrInitPlots(userId),
    getBalance(userId),
    getFarmPoolBalance(),
  ]);

  const displayName = interaction.user.displayName ?? interaction.user.username;
  const embed = buildFarmEmbed(displayName, balance, plots, poolBalance);

  await interaction.editReply({ embeds: [embed] });
}
