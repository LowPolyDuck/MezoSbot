import { ethers } from "ethers";
import { config, satsToTokenUnits, tokenUnitsToSats } from "./config.js";
import { supabase } from "./db.js";
import { addBalance } from "./balance.js";

let provider: ethers.JsonRpcProvider;
let wallet: ethers.Wallet;

export function getProvider() {
  return provider;
}

export function getTreasuryAddress(): string {
  return wallet.address;
}

export function initEVM() {
  const network = { chainId: config.evm.chainId, name: "mezo" };
  provider = new ethers.JsonRpcProvider(config.evm.rpcUrl, network, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  wallet = new ethers.Wallet(config.evm.treasuryPrivateKey, provider);

  provider.on("error", () => {});

  return { provider, wallet };
}

/**
 * Derive a unique deposit wallet for a Discord user.
 * Deterministic: same user always gets the same address.
 */
export function getUserDepositWallet(discordId: string): ethers.Wallet {
  const seed = `mezosbot-deposit-v1:${config.evm.treasuryPrivateKey}:${discordId}`;
  const derivedKey = ethers.keccak256(ethers.toUtf8Bytes(seed));
  return new ethers.Wallet(derivedKey, provider);
}

/** Get the unique deposit address for a user */
export function getUserDepositAddress(discordId: string): string {
  return getUserDepositWallet(discordId).address;
}

/** Register a user's deposit address for polling */
export async function registerDepositAddress(discordId: string): Promise<string> {
  const address = getUserDepositAddress(discordId);
  await supabase
    .from("deposit_addresses")
    .upsert(
      { discord_id: discordId, address: address.toLowerCase() },
      { onConflict: "discord_id", ignoreDuplicates: true }
    );
  return address;
}

/**
 * Get a reliable gas price with multiple fallbacks.
 * The Mezo RPC sometimes returns null from getFeeData(), so we
 * try several approaches before falling back to a safe default.
 */
async function getGasPrice(): Promise<bigint> {
  // 1) Standard ethers fee data
  try {
    const feeData = await provider.getFeeData();
    if (feeData.gasPrice && feeData.gasPrice > 0n) return feeData.gasPrice;
    if (feeData.maxFeePerGas && feeData.maxFeePerGas > 0n) return feeData.maxFeePerGas;
  } catch {}

  // 2) Direct eth_gasPrice RPC call
  try {
    const raw = await provider.send("eth_gasPrice", []);
    const price = BigInt(raw);
    if (price > 0n) return price;
  } catch {}

  // 3) Conservative fallback based on observed Mezo gas (~1.3M wei/gas)
  return 2_000_000n;
}

/**
 * Sweep funds from a user's deposit address to the treasury.
 * Gas price is pinned on the tx, so cost = exactly gasLimit * gasPrice.
 * value = balance - gasCost → wallet is drained to 0 with no dust.
 */
export async function sweepToTreasury(discordId: string): Promise<string | null> {
  const userWallet = getUserDepositWallet(discordId);
  const balance = await provider.getBalance(userWallet.address);
  if (balance === 0n) return null;

  const gasPrice = await getGasPrice();
  const gasLimit = 21000n;
  const gasCost = gasLimit * gasPrice;

  // No buffer needed: we pin gasPrice on the tx, so actual cost is
  // exactly gasLimit * gasPrice.  value + gasCost = balance → 0 dust.
  const sendAmount = balance - gasCost;
  if (sendAmount <= 0n) {
    console.log(
      `Sweep skipped for ${discordId}: balance ${balance} wei < gas ${gasCost} wei`
    );
    return null;
  }

  const tx = await userWallet.sendTransaction({
    to: wallet.address,
    value: sendAmount,
    gasLimit,
    gasPrice,
  });
  return tx.hash;
}

/**
 * Fund gas from treasury to a user's deposit wallet, wait for it to arrive,
 * then sweep the deposit wallet to treasury.
 * Used by the admin /sweep command for wallets where balance < gas cost.
 */
export async function fundGasAndSweep(discordId: string): Promise<string | null> {
  const userWallet = getUserDepositWallet(discordId);
  const balance = await provider.getBalance(userWallet.address);
  if (balance === 0n) return null;

  const gasPrice = await getGasPrice();
  const gasLimit = 21000n;
  const gasCost = gasLimit * gasPrice;

  // Send exactly enough gas for the sweep tx
  const gasFunding = gasCost;

  console.log(`Funding gas for ${discordId}: sending ${gasFunding} wei from treasury`);
  const fundTx = await wallet.sendTransaction({
    to: userWallet.address,
    value: gasFunding,
    gasLimit,
    gasPrice,
  });
  console.log(`Gas funding tx: ${fundTx.hash}`);

  // Wait for the funding tx to be mined (poll manually since tx.wait() is broken)
  let funded = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const newBal = await provider.getBalance(userWallet.address);
    if (newBal > balance) {
      funded = true;
      break;
    }
  }

  if (!funded) {
    console.error(`Gas funding for ${discordId} did not confirm in time`);
    return null;
  }

  // Now sweep — deposit wallet has enough for gas
  return sweepToTreasury(discordId);
}

type DepositAddressRow = { discord_id: string; address: string; last_checked_balance: string };

/**
 * Poll all registered deposit addresses for new funds.
 * Auto-credits users and immediately sweeps funds to treasury.
 *
 * KEY INVARIANT: `last_checked_balance` is ALWAYS set to the real on-chain
 * balance.  We never manually reset it to "0" — that caused the old
 * double-credit bug where the poller would re-credit deposits whose sweep
 * hadn't mined yet.
 */
export function startDepositPoller(
  onDeposit?: (discordId: string, amountSats: number, gasSats: number) => void
) {
  const poll = async () => {
    const { data: rows } = await supabase
      .from("deposit_addresses")
      .select("*");

    if (!rows) return;

    for (const row of rows as DepositAddressRow[]) {
      try {
        const bal = await provider.getBalance(row.address);
        const prev = BigInt(row.last_checked_balance || "0");

        // ── Credit only when balance INCREASES (new deposit arrived) ──
        if (bal > prev) {
          const diff = bal - prev;

          // Exact gas cost — matches the pinned gasPrice on the sweep tx
          const gasPrice = await getGasPrice();
          const gasCost = 21000n * gasPrice;
          const netDeposit = diff - gasCost;

          if (netDeposit > 0n) {
            const netSats = tokenUnitsToSats(netDeposit);
            const gasSats = tokenUnitsToSats(gasCost);

            if (netSats > 0) {
              const txId = `auto-${Date.now()}-${row.discord_id}`;
              await supabase.from("deposits").insert({
                discord_id: row.discord_id,
                tx_hash: txId,
                amount_sats: netSats,
                block_number: 0,
              });
              await addBalance(row.discord_id, netSats);
              onDeposit?.(row.discord_id, netSats, gasSats);
            }
          } else {
            console.log(
              `Deposit too small to cover gas for ${row.discord_id}: ${diff} wei < gas ${gasCost} wei`
            );
          }

          // ── Sweep immediately after crediting a new deposit ──
          sweepToTreasury(row.discord_id).catch((err) => {
            console.error(
              `Sweep failed for ${row.discord_id}:`,
              (err as Error)?.message ?? err
            );
          });
        }

        // ── ALWAYS sync tracked balance to the real chain value ──
        await supabase
          .from("deposit_addresses")
          .update({ last_checked_balance: bal.toString() })
          .eq("discord_id", row.discord_id);
      } catch {
        // Skip this address on error
      }
    }
  };

  // Poll every 15 seconds
  setInterval(poll, 15_000);
  // Initial poll after 5s (let bot finish starting)
  setTimeout(poll, 5_000);
}

/** Withdraw sats from treasury to an address (native send).
 *  Gas fee is deducted from the send amount so the treasury stays solvent.
 *  User's balance is debited `amountSats`, they receive `amountSats - gas`. */
export async function withdraw(
  toAddress: string,
  amountSats: number
): Promise<{ txHash?: string; error?: string; gasSats?: number; sentSats?: number }> {
  const normalized = toAddress.toLowerCase().trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) return { error: "Invalid address" };

  const value = satsToTokenUnits(amountSats);
  if (value <= 0n) return { error: "Amount too small" };

  const gasPrice = await getGasPrice();
  const gasLimit = 21000n;
  const gasCost = gasLimit * gasPrice;
  // 50% buffer on withdrawals — treasury keeps the surplus
  const chargedGas = gasCost + gasCost / 2n;
  const gasSats = tokenUnitsToSats(chargedGas);

  const sendValue = value - chargedGas;
  if (sendValue <= 0n) {
    return { error: `Amount too small to cover network gas (~${gasSats} sats)` };
  }

  const sentSats = tokenUnitsToSats(sendValue);

  try {
    const tx = await wallet.sendTransaction({
      to: normalized,
      value: sendValue,
      gasLimit,
      gasPrice,
    });
    return { txHash: tx.hash, gasSats, sentSats };
  } catch (e: unknown) {
    const err = e as { message?: string; reason?: string };
    return { error: err?.reason ?? err?.message ?? String(e) };
  }
}

/** Get treasury native balance in sats */
export async function getTreasuryBalanceSats(): Promise<number> {
  const bal = await provider.getBalance(wallet.address);
  return tokenUnitsToSats(bal);
}
