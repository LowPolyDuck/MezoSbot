import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type TextChannel,
  type Message,
} from "discord.js";
import { config } from "./config.js";
import { formatSats } from "./format.js";
import { initEVM, getTreasuryAddress, startDepositPoller, registerDepositAddress, recoverPendingWithdrawals } from "./evm.js";
import { commands, commandsData } from "./commands/index.js";
import {
  startEmulator,
  stopEmulator,
  submitBid,
  onRound,
  getButtonEmoji,
  BUTTONS,
  type GBButton,
  type RoundResult,
} from "./emulator.js";
import { startStream } from "./stream.js";
import { getBalance, subtractBalance } from "./balance.js";
import {
  processClaim,
  buildDropEmbed,
  buildClaimButton,
  getClaimants,
  type Drop,
} from "./drops.js";
import { supabase } from "./db.js";
import { extractProfile, updateUserProfile } from "./profile.js";

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", (err as Error)?.message ?? err);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commandMap = new Map(commands.map((c) => [c.data.name, c.execute]));

/* ── Valid text inputs for the game channel ─────────────────────── */

const TEXT_INPUT_MAP = new Map<string, GBButton>();
for (const btn of BUTTONS) {
  TEXT_INPUT_MAP.set(btn.toLowerCase(), btn);
}
TEXT_INPUT_MAP.set("u", "UP");
TEXT_INPUT_MAP.set("d", "DOWN");
TEXT_INPUT_MAP.set("l", "LEFT");
TEXT_INPUT_MAP.set("r", "RIGHT");

/* ── Events ─────────────────────────────────────────────────────── */

client.once(Events.ClientReady, async (c) => {
  console.log(`Ready as ${c.user.tag}`);

  const rest = new REST().setToken(config.discord.token);
  await rest.put(
    Routes.applicationCommands(config.discord.clientId),
    { body: commandsData },
  );
  console.log(`Slash commands registered (${commandsData.length} commands)`);

  // Pre-cache the game channel so we never fetch it during gameplay
  const gcId = config.gameboy.gameChannelId;
  if (gcId) {
    try {
      const ch = await client.channels.fetch(gcId);
      if (ch && "send" in ch) cachedGameChannel = ch as TextChannel;
    } catch { /* channel not found */ }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    const customId = interaction.customId;
    if (customId.startsWith("claim_drop_")) {
      await handleDropButton(interaction as ButtonInteraction);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const handler = commandMap.get(interaction.commandName);
  if (!handler) return;
  const { username, displayName, avatarUrl } = extractProfile(interaction as ChatInputCommandInteraction);
  updateUserProfile(interaction.user.id, username, displayName, avatarUrl).catch(() => {});
  try {
    await handler(interaction as ChatInputCommandInteraction);
  } catch (err) {
    // 10062 = Unknown Interaction: interaction token expired, typically from
    // pre-restart interactions re-delivered to the new instance. Not a real error.
    if ((err as { code?: number })?.code === 10062) return;
    console.error(`Command /${interaction.commandName} error:`, (err as Error)?.message ?? err);
    const msg = { content: "❌ Something went wrong.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

/* ────────────────────────────────────────────────────────────────── */
/*  Game Boy text input listener                                      */
/*  ZERO async. No awaits. No API calls. Instant.                     */
/* ────────────────────────────────────────────────────────────────── */

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  const gameChannelId = config.gameboy.gameChannelId;
  if (!gameChannelId || message.channelId !== gameChannelId) return;

  console.log(`[GB] Message in game channel: "${message.content}" from ${message.author.tag}`);

  const parts = message.content.trim().toLowerCase().split(/\s+/);
  const button = TEXT_INPUT_MAP.get(parts[0]);
  if (!button) return; // not a valid input — ignore, don't even delete

  // Parse optional tip amount
  const minBid = config.gameboy.minBid;
  let amount = minBid;
  if (parts[1]) {
    const p = parseFloat(parts[1]);
    if (!isNaN(p) && p > 0) amount = Math.max(p, minBid);
  }

  // Submit bid — synchronous, instant, no blocking
  submitBid(message.author.id, button, amount);

  // Ensure user has a deposit address (fire-and-forget, first time only)
  registerDepositAddress(message.author.id).catch(() => {});
});

/* ────────────────────────────────────────────────────────────────── */
/*  Democracy round resolution                                        */
/*  Charges are fire-and-forget. Feed updates throttled to 1/sec.     */
/*  NOTHING here blocks the emulator or event loop.                   */
/* ────────────────────────────────────────────────────────────────── */

let cachedGameChannel: TextChannel | null = null;
let feedMsg: Message | null = null;
let feedBusy = false;
let lastFeedTime = 0;
const FEED_THROTTLE_MS = 1000; // max 1 Discord message edit per second

function setupGameBoyCallbacks() {
  if (!config.gameboy.gameChannelId) return;

  onRound((result: RoundResult) => {
    const { winningButton, winners, winningSats, tally, totalBids } = result;

    // ── Charge all winning voters — fire and forget ──
    for (const bid of winners) {
      subtractBalance(bid.userId, bid.amount).catch(() => {});
    }

    // ── Update feed message — throttled, non-blocking ──
    const now = Date.now();
    if (feedBusy || now - lastFeedTime < FEED_THROTTLE_MS) return;
    feedBusy = true;
    lastFeedTime = now;

    updateFeed(winningButton, winningSats, tally, totalBids)
      .catch(() => {})
      .finally(() => { feedBusy = false; });
  });
}

async function updateFeed(
  button: GBButton,
  sats: number,
  tally: RoundResult["tally"],
  totalBids: number,
) {
  if (!cachedGameChannel) return;

  const emoji = getButtonEmoji(button);
  let content = `${emoji} **${button}** — **${formatSats(sats)}** from ${totalBids} vote${totalBids !== 1 ? "s" : ""}`;

  if (tally.length > 1) {
    const breakdown = tally
      .map((v) => `${getButtonEmoji(v.button)} ${formatSats(v.totalSats)} (${v.voters.length})`)
      .join("  ");
    content += `\n${breakdown}`;
  }

  try {
    if (feedMsg) {
      await feedMsg.edit({ content, allowedMentions: { parse: [] } });
    } else {
      feedMsg = await cachedGameChannel.send({ content, allowedMentions: { parse: [] } });
    }
  } catch {
    // Message was deleted or errored — will create a new one next update
    feedMsg = null;
  }
}

/* ── Drop claim button handler ────────────────────────────────── */

async function handleDropButton(interaction: ButtonInteraction) {
  const dropId = parseInt(interaction.customId.replace("claim_drop_", ""), 10);
  if (isNaN(dropId)) return;

  await interaction.deferReply({ ephemeral: true });

  const result = await processClaim(dropId, interaction.user.id);

  if (!result.ok) {
    await interaction.editReply({ content: `❌ ${result.error}` });
    return;
  }

  const { data: drop } = await supabase
    .from("drops")
    .select("*")
    .eq("id", dropId)
    .single();

  if (drop) {
    const claimEmbed = new EmbedBuilder()
      .setColor(0x00cc6a)
      .setTitle("🎉 Claimed!")
      .addFields(
        { name: "Amount", value: `**${formatSats(drop.per_claim_sats)}**`, inline: true },
        { name: "Remaining", value: `**${result.remaining}**`, inline: true },
      );

    await interaction.editReply({ embeds: [claimEmbed] });

    try {
      const claimedBy = await getClaimants(dropId);
      const embed = buildDropEmbed(drop as Drop, claimedBy);
      const row = buildClaimButton(dropId, result.completed);
      await interaction.message.edit({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    } catch (err) {
      console.error("Failed to update drop message:", (err as Error)?.message ?? err);
    }
  } else {
    const fallbackEmbed = new EmbedBuilder()
      .setColor(0x00cc6a)
      .setTitle("🎉 Claimed!")
      .setDescription(`${result.remaining} claim${result.remaining === 1 ? "" : "s"} left`);

    await interaction.editReply({ embeds: [fallbackEmbed] });
  }
}

/* ── Main ─────────────────────────────────────────────────────── */

async function main() {
  initEVM();
  console.log(`Treasury: ${getTreasuryAddress()}`);

  // Resolve any withdrawals left pending from a previous session
  recoverPendingWithdrawals().catch((err) =>
    console.error("[Recovery] Failed:", (err as Error)?.message ?? err)
  );

  startDepositPoller((discordId, amountSats, gasSats) => {
    console.log(`Auto-deposit: ${formatSats(amountSats)} (gas: ~${formatSats(gasSats)}) for ${discordId}`);
    client.users.fetch(discordId).then((u) => {
      const embed = new EmbedBuilder()
        .setColor(0x00cc6a)
        .setTitle("✅ Deposit Received!")
        .addFields(
          { name: "Credited", value: `**${formatSats(amountSats)}**`, inline: true },
        );

      if (gasSats > 0) {
        embed.addFields(
          { name: "Gas Deducted", value: `~${formatSats(gasSats)}`, inline: true },
        );
      }

      embed.setFooter({ text: "Use /balance to check your total" });
      embed.setTimestamp();

      u.send({ embeds: [embed] }).catch(() => {});
    }).catch(() => {});
  });

  await client.login(config.discord.token);

  // ── Game Boy emulator ──
  const { romPath } = config.gameboy;
  if (romPath) {
    try {
      startEmulator(romPath);
      setupGameBoyCallbacks();
    } catch (err) {
      console.error("[GameBoy] Failed to start:", (err as Error)?.message ?? err);
    }
  } else {
    console.log("[GameBoy] ROM_PATH not set — emulator disabled");
  }

  // ── Web canvas server (always starts — needed for Render health checks) ──
  await startStream();
}

// Graceful shutdown: save game state before exit
process.on("SIGINT", () => {
  console.log("\n[Shutdown] Received SIGINT, saving game state...");
  stopEmulator();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[Shutdown] Received SIGTERM, saving game state...");
  stopEmulator();
  process.exit(0);
});

main().catch(console.error);
