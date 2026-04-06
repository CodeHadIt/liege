# Liège

A professional-grade crypto research and on-chain analysis platform built for traders who need signal, not noise. Liège aggregates real-time market data, on-chain metrics, and wallet intelligence across Solana, Base, and BSC — all in one interface.

**Live:** [liege.up.railway.app](https://liege.up.railway.app)

---

## Features

### Token Analyzer

Deep-dive into any token across supported chains. Paste a contract address and get an instant breakdown of everything that matters — price action, liquidity depth, holder distribution, contract safety flags, deployer history, and recent on-chain transactions.

Each token receives an automated **Due Diligence (DD) Score** graded A–F, calculated across five weighted factors: liquidity health, holder concentration, contract safety, deployer track record, and token age relative to volume. The score gives you a fast, objective signal on token quality before you commit capital.

The analyzer also surfaces:
- Interactive candlestick charts across five timeframes (5m, 15m, 1h, 4h, 1d)
- Top 20 holders with whale concentration visualization
- Active liquidity pools and their depth
- Full recent transaction feed with categorized activity

---

### Trending & Market Overview

A live pulse on what's moving across the market. Three tabs keep you oriented at all times:

- **Trending** — tokens currently receiving the most market attention, ranked by momentum signals
- **New Launches** — recently deployed tokens gaining early traction
- **Volume Movers** — tokens leading in 24h trading volume

Filter by chain, sort by any column, and navigate directly to the Token Analyzer from any row.

---

### Wallet Tracker & Deployer Analysis

Look up any wallet on Solana, Base, or BSC. The tracker gives you a complete picture of a wallet's activity:

- Full token and native asset portfolio with current valuations
- Transaction history with type classification (swaps, transfers, contract deploys, approvals)
- List of tokens deployed from the wallet, with live status on each

For wallets that have deployed tokens, Liège calculates a **Deployer Score** — a reputation grade (A–F) based on the ratio of rugged or abandoned projects in their history. Risk levels are classified as low, medium, high, or critical. This makes it fast to answer the question: *should I trust who made this token?*

---

### Common Top Traders

Find the wallets that consistently appear across multiple high-performing tokens. Select 2–10 tokens and Liège identifies wallets that have traded all of them — surfacing the smart money that keeps showing up.

Results include:
- Each wallet's position across the selected tokens
- Individual and total realized/unrealized PnL per wallet
- Trade counts and stablecoin balances
- Detailed trade history per wallet-token pair

Results persist locally so you can revisit your research without re-running the query.

---

### DEX Orders / Paid Profiles Detector

Identify pump.fun tokens that have invested in their own visibility — specifically those that have paid for a DexScreener profile ("DEX PAID") or undergone a community takeover ("CTO"). These signals often indicate a project past the initial launch phase and worth a closer look.

Browse by time window (30m to 8h), filter by FDV range and bonded status, and sort by when the order was placed or when the token launched. Infinite scroll loads results continuously without pagination friction.

---

### Pump.fun Token Tracker

A dedicated feed for newly launched pump.fun tokens. Filter by time period (Latest, 1h, 4h, 6h, 24h, 1w) and scroll through the full list with live FDV, liquidity, price, and age data. A stats bar at the top shows aggregate context: total tokens launched in the period, the highest FDV token, and the most recent launch.

Prices are formatted with subscript zero notation (e.g. $0.000₄23) so micro-cap prices are always legible at a glance.

---

### Global Token Search

Search any token by name, symbol, or contract address from anywhere in the app. Paste a valid address and you're taken directly to the Token Analyzer — no round-trip needed. For text queries, results appear in a dropdown within 300ms with logos, prices, and chain labels. A full results page is also available for deeper browsing.

---

### Favorites & Portfolio Management

Save wallets you care about and organize them into labeled folders with custom emojis. For each saved wallet, Liège surfaces a live portfolio snapshot — top holdings by value, 24h performance, and aggregated PnL insights.

Favorites are tied to your account and sync across sessions. Folder and label management gives you a clean way to track wallets by category — whether that's smart money you're watching, your own wallets, or specific projects you're monitoring.

---

### Authentication

Liège uses Web3-native authentication. Connect your wallet to log in — no email or password required. Your account is linked to your wallet address, and your favorites, folders, and settings persist across sessions.

---

## Supported Chains

| Chain | Status |
|---|---|
| Solana | Supported |
| Base | Supported |
| BSC (BNB Chain) | Supported |

---

## Tech Stack

Built with **Next.js** (App Router), **TypeScript**, **Tailwind CSS**, and **shadcn/ui**. Server state is managed with **TanStack Query**. Authentication is handled via **Privy**. Persistent data is stored in **Supabase** (PostgreSQL). Charts are rendered with **lightweight-charts** and **recharts**.

---

## Local Development

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local
# Fill in your API keys

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Deployment

The app is containerized and deployed on Railway. A `Dockerfile` is included at the root for self-hosting. The production environment uses system Chromium for browser automation tasks.

```bash
# Build Docker image
docker build -t liege .

# Run container
docker run -p 3000:3000 --env-file .env.local liege
```
