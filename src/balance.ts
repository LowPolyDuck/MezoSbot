import { supabase } from "./db.js";
import { roundSats } from "./format.js";

export async function getOrCreateUser(discordId: string) {
  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("discord_id", discordId)
    .single();

  if (existing) return existing as { discord_id: string; wallet_address: string | null; balance_sats: number };

  await supabase.from("users").insert({ discord_id: discordId });

  const { data: created } = await supabase
    .from("users")
    .select("*")
    .eq("discord_id", discordId)
    .single();

  return created as { discord_id: string; wallet_address: string | null; balance_sats: number };
}

export async function getBalance(discordId: string): Promise<number> {
  const { data } = await supabase
    .from("users")
    .select("balance_sats")
    .eq("discord_id", discordId)
    .single();

  return data?.balance_sats ?? 0;
}

export async function addBalance(discordId: string, amountSats: number): Promise<void> {
  await getOrCreateUser(discordId);
  const rounded = roundSats(amountSats);
  await supabase.rpc("add_balance", { p_discord_id: discordId, p_amount: rounded });
}

export async function subtractBalance(discordId: string, amountSats: number): Promise<boolean> {
  const bal = await getBalance(discordId);
  const rounded = roundSats(amountSats);
  if (rounded <= 0 || bal < rounded) return false;
  await supabase.rpc("subtract_balance", { p_discord_id: discordId, p_amount: rounded });
  return true;
}

export async function linkWallet(discordId: string, walletAddress: string): Promise<{ ok: boolean; error?: string }> {
  const normalized = walletAddress.toLowerCase().trim();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return { ok: false, error: "Invalid EVM address" };

  try {
    await getOrCreateUser(discordId);

    // Check if wallet is already linked to someone else
    const { data: existing } = await supabase
      .from("links")
      .select("discord_id")
      .eq("wallet_address", normalized)
      .single();

    if (existing && existing.discord_id !== discordId) {
      return { ok: false, error: "Wallet already linked to another user" };
    }
    if (existing) return { ok: true }; // Already linked to this user

    await supabase
      .from("links")
      .upsert({ discord_id: discordId, wallet_address: normalized }, { onConflict: "discord_id,wallet_address" });

    await supabase
      .from("users")
      .update({ wallet_address: normalized })
      .eq("discord_id", discordId);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getWalletForUser(discordId: string): Promise<string | null> {
  const { data } = await supabase
    .from("links")
    .select("wallet_address")
    .eq("discord_id", discordId)
    .single();

  return data?.wallet_address ?? null;
}

export async function getDiscordForWallet(walletAddress: string): Promise<string | null> {
  const normalized = walletAddress.toLowerCase();
  const { data } = await supabase
    .from("links")
    .select("discord_id")
    .eq("wallet_address", normalized)
    .single();

  return data?.discord_id ?? null;
}
