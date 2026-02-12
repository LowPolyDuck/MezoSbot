import { GuildMember, type ChatInputCommandInteraction } from "discord.js";
import { supabase } from "./db.js";

export function extractProfile(interaction: ChatInputCommandInteraction) {
  const user = interaction.user;
  const member = interaction.member instanceof GuildMember ? interaction.member : null;

  const username = user.username;
  const displayName = member?.displayName ?? user.displayName;
  const avatarUrl = (member ?? user).displayAvatarURL({ size: 128, extension: "png", forceStatic: true });

  return { username, displayName, avatarUrl };
}

export async function updateUserProfile(
  discordId: string,
  username: string,
  displayName: string,
  avatarUrl: string,
): Promise<void> {
  await supabase
    .from("users")
    .update({
      username,
      display_name: displayName,
      avatar_url: avatarUrl,
    })
    .eq("discord_id", discordId);
}
