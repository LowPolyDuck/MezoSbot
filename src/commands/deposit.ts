import { AttachmentBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import QRCode from "qrcode";
import { registerDepositAddress } from "../evm.js";
import { config } from "../config.js";

export const data = {
  name: "deposit",
  description: "Get your personal deposit address",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const address = await registerDepositAddress(interaction.user.id);
  const explorer = config.evm.explorerUrl;

  const qrBuffer = await QRCode.toBuffer(address, {
    width: 256,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });

  const attachment = new AttachmentBuilder(qrBuffer, { name: "deposit-qr.png" });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📍 Your Deposit Address")
    .setDescription(`\`${address}\``)
    .addFields(
      { name: "How It Works", value: "Send BTC to this address from any wallet. Your balance is credited **automatically** within ~15 seconds." },
      { name: "Network Fee", value: "A small gas fee (~3 sats) is deducted per deposit." },
      { name: "Explorer", value: `[View on Explorer](${explorer}/address/${address})` },
    )
    .setThumbnail("attachment://deposit-qr.png")
    .setFooter({ text: "This address is unique to you" })
    .setTimestamp();

  await interaction.editReply({
    embeds: [embed],
    files: [attachment],
  });
}
