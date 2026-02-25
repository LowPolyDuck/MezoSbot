/**
 * Farmville-style farming game — core logic.
 *
 * Economic model (solvency):
 *   - Every seed purchase (regular planting OR seed drop claim) sends the seed cost into
 *     the shared farm pool.
 *   - Every successful harvest draws the yield FROM the farm pool.
 *   - Withered crops are cleared with no refund — their seed cost stays in the pool.
 *   - The pool must be topped up via /farm-fund donations or /seed-drop sponsorships
 *     to cover the yield spread (yield − seed_cost) of each successful harvest.
 *
 * Net pool change per crop:
 *   Successful harvest : seed_cost − yield  (negative — pool drain)
 *   Wither            : +seed_cost           (positive — natural buffer)
 *   Seed drop created : +seed_cost per seed  (sponsor funds the pool)
 *   /farm-fund        : +amount              (direct donation)
 */
import { EmbedBuilder } from "discord.js";
import { supabase } from "./db.js";
import { addBalance, subtractBalance } from "./balance.js";
import { formatSats } from "./format.js";

/* ------------------------------------------------------------------ */
/*  Crop definitions                                                   */
/* ------------------------------------------------------------------ */

export const CROPS = {
  wheat: {
    id: "wheat",
    name: "Wheat",
    emoji: "🌾",
    seedCostSats: 5,
    growMs: 10 * 60 * 1000,    // 10 min
    witherMs: 20 * 60 * 1000,  // 20 min after ready
    yieldSats: 8,
  },
  potato: {
    id: "potato",
    name: "Potato",
    emoji: "🥔",
    seedCostSats: 20,
    growMs: 30 * 60 * 1000,    // 30 min
    witherMs: 60 * 60 * 1000,  // 1 hr after ready
    yieldSats: 35,
  },
  strawberry: {
    id: "strawberry",
    name: "Strawberry",
    emoji: "🍓",
    seedCostSats: 50,
    growMs: 2 * 60 * 60 * 1000,   // 2 hr
    witherMs: 4 * 60 * 60 * 1000, // 4 hr after ready
    yieldSats: 100,
  },
  corn: {
    id: "corn",
    name: "Corn",
    emoji: "🌽",
    seedCostSats: 200,
    growMs: 8 * 60 * 60 * 1000,    // 8 hr
    witherMs: 16 * 60 * 60 * 1000, // 16 hr after ready
    yieldSats: 500,
  },
} as const;

export type CropId = keyof typeof CROPS;

/* ------------------------------------------------------------------ */
/*  Plot expansion                                                     */
/* ------------------------------------------------------------------ */

export const INITIAL_PLOTS = 3;
export const MAX_PLOTS = 6;
/** Cost to unlock each extra slot (index 0 = slot 3, index 1 = slot 4, …) */
export const PLOT_EXPANSION_COSTS = [500, 2000, 5000];

/**
 * Fee taken from seed drops. Creator pays 100% of seed costs; only
 * (1 - FARM_FEE_RATE) is distributed as per-claim yield. The rest stays
 * in the pool as reserve, making seed drops net-positive for pool solvency.
 */
export const FARM_FEE_RATE = 0.10;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type PlotStatus = "empty" | "growing" | "ready" | "withered";

export interface FarmPlot {
  slot: number;
  crop_id: CropId | null;
  planted_at: string | null;
  /** When set, overrides the crop's default yieldSats. Used for seed-drop claims. */
  yield_sats: number | null;
}

/* ------------------------------------------------------------------ */
/*  Status helpers                                                     */
/* ------------------------------------------------------------------ */

export function getPlotStatus(plot: FarmPlot): PlotStatus {
  if (!plot.crop_id || !plot.planted_at) return "empty";
  const crop = CROPS[plot.crop_id];
  const now = Date.now();
  const plantedAt = new Date(plot.planted_at).getTime();
  if (now < plantedAt + crop.growMs) return "growing";
  if (now < plantedAt + crop.growMs + crop.witherMs) return "ready";
  return "withered";
}

export function getTimeRemaining(plot: FarmPlot): number {
  if (!plot.crop_id || !plot.planted_at) return 0;
  const crop = CROPS[plot.crop_id];
  const plantedAt = new Date(plot.planted_at).getTime();
  return Math.max(0, plantedAt + crop.growMs - Date.now());
}

function formatMs(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/* ------------------------------------------------------------------ */
/*  Farm pool                                                          */
/* ------------------------------------------------------------------ */

export async function getFarmPoolBalance(): Promise<number> {
  const { data } = await supabase
    .from("farm_pool")
    .select("balance_sats")
    .eq("id", 1)
    .single();
  return data?.balance_sats ?? 0;
}

export async function addFarmPool(amount: number): Promise<void> {
  await supabase.rpc("add_farm_pool", { p_amount: amount });
}

async function subtractFarmPoolIfSufficient(amount: number): Promise<boolean> {
  const { data } = await supabase.rpc("subtract_farm_pool_if_sufficient", { p_amount: amount });
  return data === true;
}

/* ------------------------------------------------------------------ */
/*  Plot initialization                                                */
/* ------------------------------------------------------------------ */

export async function getOrInitPlots(discordId: string): Promise<FarmPlot[]> {
  const { data: existing } = await supabase
    .from("farm_plots")
    .select("slot, crop_id, planted_at, yield_sats")
    .eq("discord_id", discordId)
    .order("slot", { ascending: true });

  if (existing && existing.length > 0) {
    return existing as FarmPlot[];
  }

  const starters = Array.from({ length: INITIAL_PLOTS }, (_, i) => ({
    discord_id: discordId,
    slot: i,
    crop_id: null as string | null,
    planted_at: null as string | null,
    yield_sats: null as number | null,
  }));
  await supabase.from("farm_plots").insert(starters);

  return starters.map((p) => ({ slot: p.slot, crop_id: null, planted_at: null, yield_sats: null }));
}

/* ------------------------------------------------------------------ */
/*  Planting                                                           */
/* ------------------------------------------------------------------ */

/**
 * Plant a crop without charging the user (used for seed drop claims).
 * yieldSats overrides the crop's default yield — it's the drop's per-claim
 * payout (seed cost × 90% after fee), escrowed in the pool by the creator.
 */
export async function plantFromSeedDrop(
  discordId: string,
  cropId: CropId,
  yieldSats: number,
): Promise<{ ok: boolean; slot?: number; error?: string }> {
  const plots = await getOrInitPlots(discordId);

  const emptyPlot = plots.find((p) => getPlotStatus(p) === "empty");
  if (!emptyPlot) {
    return { ok: false, error: "Your farm has no empty plots. Run `/harvest` first or `/expand` to add a slot." };
  }

  await supabase
    .from("farm_plots")
    .update({ crop_id: cropId, planted_at: new Date().toISOString(), yield_sats: yieldSats })
    .eq("discord_id", discordId)
    .eq("slot", emptyPlot.slot);

  return { ok: true, slot: emptyPlot.slot };
}

/* ------------------------------------------------------------------ */
/*  Harvesting                                                         */
/* ------------------------------------------------------------------ */

/**
 * Harvest all ready crops from the pool and clear all withered plots.
 * Harvest yields are drawn from the farm pool atomically — if the pool
 * cannot cover the total yield, no harvest occurs and an error is returned.
 */
export async function harvestAll(discordId: string): Promise<{
  ok: boolean;
  earned: number;
  harvested: number;
  cleared: number;
  nextReadyMs?: number;
  error?: string;
}> {
  const plots = await getOrInitPlots(discordId);

  const readySlots: number[] = [];
  const witheredSlots: number[] = [];
  let earned = 0;
  let nextReadyMs: number | undefined;

  for (const plot of plots) {
    const status = getPlotStatus(plot);
    if (status === "ready") {
      // Seed-drop claims store a custom yield; regular plots use the crop default
      earned += plot.yield_sats !== null ? plot.yield_sats : CROPS[plot.crop_id!].yieldSats;
      readySlots.push(plot.slot);
    } else if (status === "withered") {
      witheredSlots.push(plot.slot);
    } else if (status === "growing") {
      const remaining = getTimeRemaining(plot);
      if (nextReadyMs === undefined || remaining < nextReadyMs) {
        nextReadyMs = remaining;
      }
    }
  }

  const slotsToClean = [...readySlots, ...witheredSlots];
  if (slotsToClean.length === 0) {
    return { ok: true, earned: 0, harvested: 0, cleared: 0, nextReadyMs };
  }

  // Draw yield from the pool atomically before touching any user balances
  if (earned > 0) {
    const poolOk = await subtractFarmPoolIfSufficient(earned);
    if (!poolOk) {
      const poolBalance = await getFarmPoolBalance();
      return {
        ok: false,
        earned: 0,
        harvested: 0,
        cleared: 0,
        error: `The farm pool only has ${formatSats(poolBalance)} but needs ${formatSats(earned)} to pay your harvest. Someone needs to run \`/farm-fund\` or \`/seed-drop\` to top it up!`,
      };
    }
  }

  // Clear plots and credit the user
  await supabase
    .from("farm_plots")
    .update({ crop_id: null, planted_at: null, yield_sats: null })
    .eq("discord_id", discordId)
    .in("slot", slotsToClean);

  if (earned > 0) {
    await addBalance(discordId, earned);
  }

  return { ok: true, earned, harvested: readySlots.length, cleared: witheredSlots.length, nextReadyMs };
}

/* ------------------------------------------------------------------ */
/*  Plot expansion                                                     */
/* ------------------------------------------------------------------ */

/** Purchase one more plot slot. Expansion cost goes to the user's balance (not the pool). */
export async function expandFarm(discordId: string): Promise<{
  ok: boolean;
  newSlot?: number;
  cost?: number;
  error?: string;
}> {
  const plots = await getOrInitPlots(discordId);
  const currentCount = plots.length;

  if (currentCount >= MAX_PLOTS) {
    return { ok: false, error: `Your farm is already at maximum size (${MAX_PLOTS} plots).` };
  }

  const newSlot = currentCount;
  const costIndex = newSlot - INITIAL_PLOTS;
  const cost = PLOT_EXPANSION_COSTS[costIndex];

  if (cost === undefined) {
    return { ok: false, error: "Farm is at maximum size." };
  }

  const charged = await subtractBalance(discordId, cost);
  if (!charged) {
    return { ok: false, error: `Insufficient balance. Unlocking slot ${newSlot} costs ${formatSats(cost)}.` };
  }

  await supabase.from("farm_plots").insert({
    discord_id: discordId,
    slot: newSlot,
    crop_id: null,
    planted_at: null,
  });

  return { ok: true, newSlot, cost };
}

/* ------------------------------------------------------------------ */
/*  Embed builder                                                      */
/* ------------------------------------------------------------------ */

export function buildFarmEmbed(
  authorName: string,
  balance: number,
  plots: FarmPlot[],
  poolBalance: number,
): EmbedBuilder {
  const lines = plots.map((plot) => {
    const slotLabel = `\`[${plot.slot}]\``;
    const status = getPlotStatus(plot);

    if (status === "empty") return `${slotLabel} 🟫 Empty`;

    const crop = CROPS[plot.crop_id!];
    const yieldAmt = plot.yield_sats !== null ? plot.yield_sats : crop.yieldSats;
    const seededTag = plot.yield_sats !== null ? " 🎁" : "";

    if (status === "growing") {
      const remaining = getTimeRemaining(plot);
      return `${slotLabel} ${crop.emoji} **${crop.name}**${seededTag} · ⏳ ${formatMs(remaining)} left · earns ${formatSats(yieldAmt)}`;
    }
    if (status === "ready") {
      return `${slotLabel} ${crop.emoji} **${crop.name}**${seededTag} · ✅ Ready! Earns ${formatSats(yieldAmt)} — run \`/harvest\``;
    }
    return `${slotLabel} ☠️ **${crop.name}** withered — run \`/harvest\` to clear`;
  });

  const hasReady = plots.some((p) => getPlotStatus(p) === "ready");
  const color = hasReady ? 0x4caf50 : 0x8d6e63;

  const nextSlot = plots.length < MAX_PLOTS ? plots.length : null;
  const nextCost = nextSlot !== null ? PLOT_EXPANSION_COSTS[nextSlot - INITIAL_PLOTS] : null;
  const expandHint = nextCost !== null
    ? ` · /expand for slot ${nextSlot} (${formatSats(nextCost!)})`
    : " · Max plots reached";

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`🌱 ${authorName}'s Farm`)
    .setDescription(lines.join("\n"))
    .setFooter({
      text: [
        `Balance: ${formatSats(balance)}`,
        `Farm pool: ${formatSats(poolBalance)}`,
        `${plots.length}/${MAX_PLOTS} plots${expandHint}`,
      ].join("  ·  "),
    })
    .setTimestamp();
}
