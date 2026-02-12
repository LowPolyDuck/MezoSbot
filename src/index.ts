import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
} from "discord.js";
import { config } from "./config.js";
import { formatSats } from "./format.js";
import { initEVM, getTreasuryAddress, startDepositPoller } from "./evm.js";
import { commands, commandsData } from "./commands/index.js";
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
  ],
});

const commandMap = new Map(commands.map((c) => [c.data.name, c.execute]));

client.once(Events.ClientReady, async (c) => {
  console.log(`Ready as ${c.user.tag}`);

  const rest = new REST().setToken(config.discord.token);
  await rest.put(
    Routes.applicationCommands(config.discord.clientId),
    { body: commandsData }
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

/* ------------------------------------------------------------------ */
/*  Drop claim button handler                                         */
/* ------------------------------------------------------------------ */

async function handleDropButton(interaction: ButtonInteraction) {
  const dropId = parseInt(interaction.customId.replace("claim_drop_", ""), 10);
  if (isNaN(dropId)) return;

  await interaction.deferReply({ ephemeral: true });

  const result = await processClaim(dropId, interaction.user.id);

  if (!result.ok) {
    await interaction.editReply({ content: `❌ ${result.error}` });
    return;
  }

  // Fetch drop info for the reply
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

    // Update the original drop message
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

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

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
}

main().catch(console.error);
