import { type ChatInputCommandInteraction } from "discord.js";
import { claimShopEarnings, getPendingEarnings, SHOP_CLAIM_THRESHOLD } from "../shop.js";
import { formatSats } from "../format.js";

export const data = {
  name: "shop-claim",
  description: `Claim your pending shop earnings (minimum ${SHOP_CLAIM_THRESHOLD} sats)`,
  options: [],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const pending = await getPendingEarnings(interaction.user.id);
  if (pending < SHOP_CLAIM_THRESHOLD) {
    return interaction.editReply({
      content:
        `❌ You only have **${formatSats(pending)}** in pending shop earnings. ` +
        `You need at least **${formatSats(SHOP_CLAIM_THRESHOLD)}** to claim.\n` +
        `Run \`/shop-mine\` to see your listings.`,
    });
  }

  const claimed = await claimShopEarnings(interaction.user.id);
  if (claimed <= 0) {
    return interaction.editReply({ content: "❌ Nothing to claim right now." });
  }

  return interaction.editReply({
    content:
      `✅ Claimed **${formatSats(claimed)}** from your shop earnings!\n` +
      `It's now in your main balance — run \`/balance\` to check.`,
  });
}
