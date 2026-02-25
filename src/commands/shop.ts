import { type ChatInputCommandInteraction } from "discord.js";
import { getActiveListings, buildShopEmbed } from "../shop.js";

export const data = {
  name: "shop",
  description: "Browse community seed shop listings — fund drops and support creators",
  options: [],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const listings = await getActiveListings();
  const embed = buildShopEmbed(listings);
  // No claim buttons here — shop shows templates; /shop-drop funds from them
  await interaction.reply({ embeds: [embed] });
}
