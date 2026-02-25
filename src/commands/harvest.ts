import type { ChatInputCommandInteraction } from "discord.js";
import { harvestAll } from "../farming.js";
import { formatSats } from "../format.js";

export const data = {
  name: "harvest",
  description: "Harvest all ready crops and clear any withered plots",
  options: [],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const result = await harvestAll(interaction.user.id);

  if (!result.ok) {
    return interaction.reply({ content: "❌ Something went wrong — try again.", ephemeral: true });
  }

  const { earned, harvested, cleared, nextReadyMs } = result;

  if (harvested === 0 && cleared === 0) {
    // Nothing to do — give helpful feedback
    let msg = "🌱 Nothing to harvest yet.";
    if (nextReadyMs !== undefined && nextReadyMs > 0) {
      const minutes = Math.ceil(nextReadyMs / 60000);
      msg += ` Your next crop is ready in ~${minutes} min.`;
    }
    return interaction.reply({ content: msg, ephemeral: true });
  }

  const parts: string[] = [];

  if (harvested > 0) {
    parts.push(`✅ Harvested **${harvested}** crop${harvested > 1 ? "s" : ""} for **${formatSats(earned)}**!`);
  }
  if (cleared > 0) {
    parts.push(`☠️ Cleared **${cleared}** withered plot${cleared > 1 ? "s" : ""} (those seeds were lost).`);
  }

  parts.push("Run `/farm` to see your updated farm.");

  await interaction.reply({ content: parts.join("\n"), ephemeral: true });
}
