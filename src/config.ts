import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
}

function optional(key: string, def: string): string {
  return process.env[key] ?? def;
}

export const config = {
  discord: {
    token: required("DISCORD_TOKEN"),
    clientId: required("DISCORD_CLIENT_ID"),
    adminIds: (process.env.ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  },
  supabase: {
    url: required("SUPABASE_URL"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  },
  evm: {
    rpcUrl: required("RPC_URL"),
    chainId: parseInt(optional("CHAIN_ID", "31612"), 10),
    tokenContract: required("TOKEN_CONTRACT"),
    tokenDecimals: parseInt(optional("TOKEN_DECIMALS", "18"), 10),
    treasuryPrivateKey: required("TREASURY_PRIVATE_KEY"),
    explorerUrl: optional("EXPLORER_URL", "https://explorer.mezo.org"),
    skipWithdrawalMin: process.env.SKIP_WITHDRAWAL_MIN === "1" || process.env.SKIP_WITHDRAWAL_MIN === "true",
  },
  gameboy: {
    /** User account token for the streamer (Discord blocks video from bots) */
    streamToken: optional("STREAM_USER_TOKEN", ""),
    guildId: optional("GUILD_ID", ""),
    stageChannelId: optional("STAGE_CHANNEL_ID", ""),
    /** Text channel where users type button names to play */
    gameChannelId: optional("GB_CHANNEL_ID", ""),
    romPath: optional("ROM_PATH", ""),
    /** Minimum sats to bid per input */
    minBid: parseFloat(optional("GB_MIN_BID", "0.001")),
    /** Auction round duration in ms — bids collected during this window, highest wins */
    roundMs: parseInt(optional("GB_ROUND_MS", "150"), 10),
  },
};

/**
 * 1 BTC = 100,000,000 sats.
 * With 18-decimal BTC on EVM: 1 sat = 10^10 wei.
 * Preserves sub-sat precision (e.g. 0.5 sats, 0.0001 sats).
 */
export function tokenUnitsToSats(units: bigint): number {
  const decimals = BigInt(config.evm.tokenDecimals);
  if (decimals >= 8n) {
    const divisor = 10n ** (decimals - 8n); // 10^10 for 18 decimals
    const wholeSats = units / divisor;
    const remainder = units % divisor;
    return Number(wholeSats) + Number(remainder) / Number(divisor);
  }
  return Number(units * 10n ** (8n - decimals));
}

/**
 * Sats (number, supports floats like 0.5) to token units (bigint) for EVM transfers.
 * Uses string-based conversion to avoid floating-point drift at high precision.
 * With 18-decimal BTC: 1 sat = 10^10 wei.
 */
export function satsToTokenUnits(sats: number): bigint {
  if (sats <= 0) return 0n;
  // Convert to a fixed-point string with 10 decimal places (SATS_PRECISION)
  const satsFixed = sats.toFixed(10); // e.g. "0.5000000000"
  const [intStr, fracStr] = satsFixed.split(".");
  // Combine into a single scaled integer: sats * 10^10
  const scaledSats = BigInt(intStr + fracStr);
  // wei = sats * 10^(decimals - 8)
  // scaledSats = sats * 10^10
  // So: wei = scaledSats * 10^(decimals - 8 - 10) = scaledSats * 10^(decimals - 18)
  const exp = BigInt(config.evm.tokenDecimals) - 18n;
  if (exp >= 0n) return scaledSats * 10n ** exp;
  return scaledSats / 10n ** (-exp);
}
