import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { CROPS } from "../farming.js";
import { formatSats } from "../format.js";
import { getBalance } from "../balance.js";
import {
  getCreatorListings,
  getPendingEarnings,
  getTotalClaimsForCreator,
  SHOP_CLAIM_THRESHOLD,
  SHOP_CREATOR_FEE_SHARE,
  SHOP_MIN_BALANCE,
  SHOP_SATS_PER_LISTING,
  type ShopListing,
} from "../shop.js";

export const data = {
  name: "shop-mine",
  description: "View your shop listings, total claims, and pending royalty earnings",
  options: [],
};

const STATUS_ICON: Record<string, string> = {
  active: "🟢",
  removed: "🔴",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const [listings, pending, balance, totalClaims] = await Promise.all([
    getCreatorListings(interaction.user.id),
    getPendingEarnings(interaction.user.id),
    getBalance(interaction.user.id),
    getTotalClaimsForCreator(interaction.user.id),
  ]);

  const activeListings = listings.filter((l) => l.status === "active").length;
  const maxListings = Math.floor((balance ?? 0) / SHOP_SATS_PER_LISTING);
  const canClaim = pending >= SHOP_CLAIM_THRESHOLD;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🛒 Your Shop Listings")
    .setTimestamp();

  if (listings.length === 0) {
    embed.setDescription(
      "You have no listings yet.\n" +
      "Run `/shop-create` to define a crop listing. When others fund drops from it, " +
      `you earn **${Math.round(SHOP_CREATOR_FEE_SHARE * 100)}%** of seed cost per claim!`,
    );
  } else {
    const lines = listings.map((l: ShopListing) => {
      const crop = CROPS[l.crop_id];
      const icon = STATUS_ICON[l.status] ?? "⚪";
      const perClaim = crop.seedCostSats * SHOP_CREATOR_FEE_SHARE;
      return `${icon} **#${l.id}** ${crop.emoji} "${l.name}" · ${formatSats(perClaim)}/claim`;
    });
    embed.setDescription(lines.join("\n"));
  }

  embed.addFields(
    {
      name: "Royalty Earnings",
      value: canClaim
        ? `**${formatSats(pending)}** · ✅ Ready! Run \`/shop-claim\``
        : `**${formatSats(pending)}** · Need **${formatSats(SHOP_CLAIM_THRESHOLD - pending)}** more`,
    },
    {
      name: "Total Claims",
      value: `**${totalClaims}** claims across all your listings`,
      inline: true,
    },
    {
      name: "Listing Slots",
      value: `**${activeListings}** active · **${maxListings}** max · (1 per ${formatSats(SHOP_SATS_PER_LISTING)} held)`,
      inline: true,
    },
  );

  embed.setFooter({
    text: `You earn ${Math.round(SHOP_CREATOR_FEE_SHARE * 100)}% of seed cost per claim · min ${formatSats(SHOP_MIN_BALANCE)} balance to list`,
  });

  await interaction.editReply({ embeds: [embed] });
}
