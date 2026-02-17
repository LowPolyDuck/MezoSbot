import { GuildMember, type ChatInputCommandInteraction } from "discord.js";
import { supabase } from "./db.js";

// In-memory cache to avoid redundant DB updates
const profileCache = new Map<string, { username: string; displayName: string; avatarUrl: string }>();

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
  // Check cache to see if profile has changed
  const cached = profileCache.get(discordId);
  if (cached && cached.username === username && cached.displayName === displayName && cached.avatarUrl === avatarUrl) {
    return; // No changes, skip DB update
  }

  // Update cache
  profileCache.set(discordId, { username, displayName, avatarUrl });

  // Update database
  await supabase
    .from("users")
    .update({
      username,
      display_name: displayName,
      avatar_url: avatarUrl,
    })
    .eq("discord_id", discordId);
}
