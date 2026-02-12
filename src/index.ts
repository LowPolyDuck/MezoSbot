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
} from "discord.js";
import { config } from "./config.js";
import { formatSats } from "./format.js";
import { initEVM, getTreasuryAddress, startDepositPoller, registerDepositAddress } from "./evm.js";
import { commands, commandsData } from "./commands/index.js";
import {
  startEmulator,
  submitBid,
  onRound,
  getButtonEmoji,
  BUTTONS,
  type GBButton,
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
  TEXT_INPUT_MAP.set(btn.toLowerCase(), btn); // "a", "up", etc.
}
// Common aliases
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
});

client.on(Events.InteractionCreate, async (interaction) => {
  /* ---- Button interactions (drop claims) ---- */
  if (interaction.isButton()) {
    const customId = interaction.customId;
    if (customId.startsWith("claim_drop_")) {
      await handleDropButton(interaction as ButtonInteraction);
    }
    return;
  }

  /* ---- Slash commands ---- */
  if (!interaction.isChatInputCommand()) return;
  const handler = commandMap.get(interaction.commandName);
  if (!handler) return;
  try {
    await handler(interaction as ChatInputCommandInteraction);
  } catch (err) {
    console.error(`Command /${interaction.commandName} error:`, (err as Error)?.message ?? err);
    const msg = { content: "❌ Something went wrong.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

/* ── Game Boy text input listener ─────────────────────────────── */

/**
 * Format: <button> [amount]
 * Examples: "a", "up 5", "b 0.5", "left 100"
 * If no amount given, uses the minimum bid.
 */
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const gameChannelId = config.gameboy.gameChannelId;
  if (!gameChannelId || message.channelId !== gameChannelId) return;

  const parts = message.content.trim().toLowerCase().split(/\s+/);
  const btnStr = parts[0];
  const button = TEXT_INPUT_MAP.get(btnStr);

  if (!button) {
    // Not a valid input — silently delete
    message.delete().catch(() => {});
    return;
  }

  // Parse optional bid amount
  const minBid = config.gameboy.minBid;
  let amount = minBid;
  if (parts[1]) {
    const parsed = parseFloat(parts[1]);
    if (!isNaN(parsed) && parsed > 0) {
      amount = Math.max(parsed, minBid);
    }
  }

  // Delete the user's message to keep the channel clean
  message.delete().catch(() => {});

  // Check balance before accepting bid
  const balance = await getBalance(message.author.id);
  if (balance < amount) {
    // Silent rejection — don't spam the channel with error messages
    return;
  }

  // Ensure deposit address exists
  registerDepositAddress(message.author.id).catch(() => {});

  // Submit bid to the auction
  const result = submitBid(message.author.id, button, amount);
  if (!result.ok) {
    // Silent — emulator not running or below min bid
    return;
  }
});

/* ── Auction round resolution callback ────────────────────────── */

function setupGameBoyCallbacks() {
  const gameChannelId = config.gameboy.gameChannelId;
  if (!gameChannelId) return;

  onRound(async ({ winner, totalBids }) => {
    // Charge the winner
    const charged = await subtractBalance(winner.userId, winner.amount);
    if (!charged) {
      // Winner couldn't pay — rare (balance checked at bid time) but possible
      // No input applied is fine, round just had no winner
      return;
    }

    // Post the result to the game channel
    try {
      const channel = await client.channels.fetch(gameChannelId);
      if (!channel || !("send" in channel)) return;

      const emoji = getButtonEmoji(winner.button);
      const bidInfo = totalBids > 1
        ? ` — won over ${totalBids - 1} other bid${totalBids > 2 ? "s" : ""}`
        : "";

      await (channel as TextChannel).send({
        content: `${emoji} **${winner.button}** — <@${winner.userId}> tipped **${formatSats(winner.amount)}**${bidInfo}`,
        allowedMentions: { parse: [] },
      });
    } catch {
      // Channel send failed — not critical
    }
  });
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

  // Auto-detect deposits and DM the user
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

  // ── Game Boy emulator + video stream ──
  const { romPath, streamToken } = config.gameboy;
  if (romPath) {
    try {
      startEmulator(romPath);
      setupGameBoyCallbacks();
      if (streamToken) {
        await startStream();
      } else {
        console.log("[GameBoy] No STREAM_USER_TOKEN — emulator running but video stream disabled");
      }
    } catch (err) {
      console.error("[GameBoy] Failed to start:", (err as Error)?.message ?? err);
    }
  } else {
    console.log("[GameBoy] ROM_PATH not set — emulator disabled");
  }
}

main().catch(console.error);
