# MezoSbot

A Discord bot for depositing sats from an EVM network (Mezo), and tipping, distributing, and dropping them to other users.

## Features

- **Link wallet**: Link your EVM address so deposits are credited to your Discord account
- **Deposit**: Send tBTC (or configured token) from your linked wallet to the bot's treasury
- **Withdraw**: Withdraw sats to any EVM address
- **Tip**: Send sats to another user
- **Distribute**: Split sats among multiple users (e.g. `@user1 @user2 @user3`)
- **Drop**: Create a drop — first N users to `/claim` get sats (rain/airdrop style)

## Setup

### 1. Create a Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. New Application → Create a Bot
3. Copy the **Bot Token** and **Application ID**
4. Enable **MESSAGE CONTENT INTENT** if needed
5. Invite the bot with scopes: `bot`, `applications.commands`

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values
```

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from Developer Portal |
| `DISCORD_CLIENT_ID` | Application ID |
| `RPC_URL` | EVM RPC (e.g. `https://rpc.mezo.org`) |
| `CHAIN_ID` | Chain ID (Mezo mainnet: 31612) |
| `TOKEN_CONTRACT` | ERC20 token address (tBTC on Mezo: `0x18084fbA666a33d37592fA2633fD49a74DD93a88`) |
| `TOKEN_DECIMALS` | Token decimals (tBTC: 18) |
| `TREASURY_PRIVATE_KEY` | Private key of wallet that holds and sends funds |

### 3. Fund the Treasury

The bot's treasury wallet must hold the token for withdrawals. Users deposit to this same address; the bot credits their balance when it sees transfers from **linked** wallets.

### 4. Install and Run

```bash
npm install
npm run build
npm start
```

For development:

```bash
npm run dev
```

## Commands

| Command | Description |
|---------|-------------|
| `/link <address>` | Link your EVM wallet |
| `/deposit` | Get deposit address and instructions |
| `/balance` | Check your sats balance |
| `/withdraw <amount> <address>` | Withdraw sats to an address |
| `/tip <user> <amount>` | Tip another user |
| `/distribute <amount> <@users>` | Split sats among multiple users |
| `/drop <total> <per_claim> <max_claims>` | Create a claimable drop |
| `/claim <drop_id>` | Claim from an active drop |

**All amounts use sats** and support decimals (e.g. `100.5`, `0.25`) for easier denomination. Precision: 6 decimal places.

## How Deposits Work

1. User runs `/link 0xYourAddress` to link their wallet
2. User runs `/deposit` to get the treasury address
3. User sends tokens **from their linked wallet** to the treasury
4. The bot watches for `Transfer` events to the treasury from linked addresses
5. When detected, the user's balance is credited

**Important**: Only transfers from **linked** wallets are credited. Unlinked transfers are ignored.

## Network Configuration

Default config targets **Mezo mainnet** (tBTC). To use another EVM chain:

- Set `RPC_URL` and `CHAIN_ID` for your chain
- Set `TOKEN_CONTRACT` to the ERC20 address (or native ETH with minor code changes)
- Adjust `TOKEN_DECIMALS` (8 for WBTC-style, 18 for most ERC20s)

## License

MIT
