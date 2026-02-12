import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { supabase } from "../db.js";
import { formatSats } from "../format.js";

export const data = {
  name: "leaderboard",
  description: "Top sats holders in the server",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const { data: rows } = await supabase
    .from("users")
    .select("discord_id, balance_sats")
    .gt("balance_sats", 0)
    .order("balance_sats", { ascending: false })
    .limit(10);

  if (!rows || rows.length === 0) {
    return interaction.editReply({ content: "No one has any sats yet!" });
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = rows.map((r, i) => {
    const rank = medals[i] ?? `**${i + 1}.**`;
    return `${rank} <@${r.discord_id}> — **${formatSats(r.balance_sats)}**`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xf0b232)
    .setTitle("🏆 Sats Leaderboard")
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Top ${rows.length} holder${rows.length === 1 ? "" : "s"}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
