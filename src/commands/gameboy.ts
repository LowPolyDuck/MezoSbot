/**
 * Game Boy button slash commands (fallback — text input in the game channel is faster).
 * Each one submits a bid to the current auction round.
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getBalance, subtractBalance } from "../balance.js";
import { submitBid, getButtonEmoji, type GBButton } from "../emulator.js";
import { config } from "../config.js";
import { registerDepositAddress } from "../evm.js";
import { formatSats } from "../format.js";

/** Shared handler for all button commands */
async function handlePress(interaction: ChatInputCommandInteraction, button: GBButton) {
  const emoji = getButtonEmoji(button);
  const minBid = config.gameboy.minBid;
  const amount = interaction.options.getNumber("amount") ?? minBid;

  if (amount < minBid) {
    return interaction.reply({ content: `❌ Minimum bid is ${formatSats(minBid)}.`, ephemeral: true });
  }

  // Check balance
  const balance = await getBalance(interaction.user.id);
  if (balance < amount) {
    return interaction.reply({ content: "❌ Not enough sats.", ephemeral: true });
  }

  // Submit bid
  const result = submitBid(interaction.user.id, button, amount);
  if (!result.ok) {
    return interaction.reply({ content: `❌ ${result.reason}`, ephemeral: true });
  }

  await registerDepositAddress(interaction.user.id);

  // Bid accepted — winner will be charged when the round resolves
  await interaction.reply({
    content: `${emoji} Bid **${formatSats(amount)}** on **${button}** — good luck!`,
    ephemeral: true,
  });
}

/* ── Command definitions ──────────────────────────────────────────── */

function btn(name: string, button: GBButton, emoji: string) {
  const data = new SlashCommandBuilder()
    .setName(name)
    .setDescription(`${emoji} Bid to press ${button}`)
    .addNumberOption((opt) =>
      opt.setName("amount")
        .setDescription(`Sats to bid (min ${config.gameboy.minBid}, highest bid wins)`)
        .setRequired(false)
        .setMinValue(config.gameboy.minBid)
    );

  return {
    data: data.toJSON(),
    execute: (i: ChatInputCommandInteraction) => handlePress(i, button),
  };
}

export const a      = btn("a",      "A",      "🅰️");
export const b      = btn("b",      "B",      "🅱️");
export const up     = btn("up",     "UP",     "⬆️");
export const down   = btn("down",   "DOWN",   "⬇️");
export const left   = btn("left",   "LEFT",   "⬅️");
export const right  = btn("right",  "RIGHT",  "➡️");
export const start  = btn("start",  "START",  "▶️");
export const select = btn("select", "SELECT", "⏸️");

/** All GB button commands as an array for easy registration */
export const gameboyCommands = [a, b, up, down, left, right, start, select];
