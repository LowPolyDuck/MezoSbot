import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { supabase } from "../db.js";
import { processClaim, updateDropMessage, type Drop } from "../drops.js";
import { formatSats } from "../format.js";

export const data = {
  name: "claim",
  description: "Claim sats from the active drop in this channel",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const { data: drop } = await supabase
    .from("drops")
    .select("*")
    .eq("channel_id", interaction.channelId!)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!drop) {
    return interaction.editReply({ content: "❌ No active drop in this channel." });
  }

  const result = await processClaim(drop.id, interaction.user.id);

  if (!result.ok) {
    return interaction.editReply({ content: `❌ ${result.error}` });
  }

  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("🎉 Claimed!")
    .addFields(
      { name: "Amount", value: `**${formatSats(drop.per_claim_sats)}**`, inline: true },
      { name: "Remaining", value: `**${result.remaining}**`, inline: true },
    );

  await interaction.editReply({ embeds: [embed] });

  if (interaction.client) {
    updateDropMessage(interaction.client, drop as Drop).catch(() => {});
  }
}
