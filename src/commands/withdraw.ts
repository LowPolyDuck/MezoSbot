import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { withdraw } from "../evm.js";
import { subtractBalance, addBalance, getWalletForUser } from "../balance.js";
import { supabase } from "../db.js";
import { config } from "../config.js";
import { formatSats } from "../format.js";

const MIN_WITHDRAWAL_SATS = 500;

export const data = {
  name: "withdraw",
  description: "Withdraw sats to an EVM address",
  options: [
    { name: "amount", type: 10 as const, description: "Amount in sats", required: true, minValue: 0.000001 },
    { name: "address", type: 3 as const, description: "Destination address (0x...) — defaults to linked wallet", required: false },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const amount = interaction.options.getNumber("amount", true);
  const addressOpt = interaction.options.getString("address");

  if (addressOpt && !/^0x[a-fA-F0-9]{40}$/i.test(addressOpt)) {
    return interaction.reply({ content: "❌ Invalid address.", ephemeral: true });
  }

  if (!config.evm.skipWithdrawalMin && amount < MIN_WITHDRAWAL_SATS) {
    return interaction.reply({ content: `❌ Minimum withdrawal is **${MIN_WITHDRAWAL_SATS.toLocaleString()} sats**.`, ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const address = addressOpt || (await getWalletForUser(interaction.user.id));
  if (!address) {
    return interaction.editReply({
      content: "❌ No address provided and no linked wallet. Either provide an address or `/link` one first.",
    });
  }

  if (!(await subtractBalance(interaction.user.id, amount))) {
    return interaction.editReply({ content: "❌ Insufficient balance." });
  }

  const result = await withdraw(address, amount);

  if (result.error) {
    await addBalance(interaction.user.id, amount);
    return interaction.editReply({ content: `❌ Withdrawal failed: ${result.error}` });
  }

  await supabase.from("withdrawals").insert({
    discord_id: interaction.user.id,
    tx_hash: result.txHash ?? null,
    amount_sats: amount,
    to_address: address.toLowerCase(),
    status: "completed",
  });

  const explorer = config.evm.explorerUrl;

  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("✅ Withdrawal Sent")
    .addFields(
      { name: "Amount", value: `**${formatSats(amount)}**`, inline: true },
      { name: "To", value: `\`${address.slice(0, 10)}...${address.slice(-8)}\``, inline: true },
    );

  if (result.gasSats) {
    embed.addFields(
      { name: "Network Fee", value: `~${formatSats(result.gasSats)}`, inline: true },
      { name: "Received", value: `~${formatSats(result.sentSats!)}`, inline: true },
    );
  }

  if (result.txHash) {
    embed.addFields({ name: "Transaction", value: `[View on Explorer](${explorer}/tx/${result.txHash})` });
  }

  embed.setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
