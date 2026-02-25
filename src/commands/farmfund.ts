import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { subtractBalance } from "../balance.js";
import { addFarmPool, getFarmPoolBalance } from "../farming.js";
import { formatSats } from "../format.js";

export const data = {
  name: "farm-fund",
  description: "Donate sats to the farm pool so other players can harvest their crops",
  options: [
    {
      name: "amount",
      type: 10 as const,
      description: "Sats to donate to the farm pool",
      required: true,
      minValue: 1,
    },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const amount = interaction.options.getNumber("amount", true);

  await interaction.deferReply();

  const charged = await subtractBalance(interaction.user.id, amount);
  if (!charged) {
    return interaction.editReply({ content: `❌ Insufficient balance.` });
  }

  await addFarmPool(amount);
  const newPool = await getFarmPoolBalance();

  const embed = new EmbedBuilder()
    .setColor(0x4caf50)
    .setTitle("🌱 Farm Pool Funded!")
    .setDescription(`<@${interaction.user.id}> donated **${formatSats(amount)}** to the farm pool!`)
    .addFields({ name: "Pool Balance", value: `**${formatSats(newPool)}**`, inline: true })
    .setFooter({ text: "Run /harvest to collect ready crops — yields are paid from this pool" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
