# Halal Trading Bot — Shariah-Compliant Automated Spot Trading

Claude + TradingView MCP + BitGet Spot Exchange — adapted for Islamic finance principles.

---

## Shariah Compliance Summary

| Principle | Status | Implementation |
|-----------|--------|----------------|
| No Riba (interest) | ✅ Enforced | Spot trading only — futures/margin hardcoded off |
| No Short Selling | ✅ Enforced | Bot only evaluates long (buy) entries |
| Halal Asset Screening | ✅ Enforced | Whitelist of permissible crypto pairs in `bot.js` |
| No Gharar (excess uncertainty) | ✅ Guarded | Price must be within 2% of VWAP before entry |
| Zakat Tracking | ✅ Built-in | `node bot.js --zakat` calculates 2.5% of the value of what you hold |

> **Disclaimer:** This bot does not constitute a fatwa. Consult a qualified Islamic scholar for rulings specific to your situation. Cryptocurrency permissibility is accepted by many contemporary scholars but remains a matter of scholarly discussion.

---

## What This Does

Five things you get from this setup:

1. **Claude connected to your exchange** — reads TradingView charts and executes halal spot trades on BitGet automatically
2. **Shariah safety check** — every condition in your strategy AND all Islamic finance rules must pass before a single trade fires
3. **24/7 cloud execution** — deploy to a VPS and it runs on a schedule, even when your laptop is closed
4. **Automatic tax + zakat accounting** — every trade logged to `trades.csv`; run `--zakat` for your annual zakat estimate
5. **Free** — no email, no course, no upsell

---

## Shariah Principles Enforced

### 1. Spot Trading Only (No Riba)
Futures and margin trading involve interest (riba), which is prohibited. The bot is hardcoded to use BitGet's spot API only. The `TRADE_MODE` variable has been removed — it cannot be set to futures.

### 2. No Short Selling
Short selling means selling assets you do not yet own, which is prohibited in Islamic finance. The bot's safety check **only evaluates bullish/long (buy) conditions**. When the market is bearish or neutral, the bot waits — it never shorts.

### 3. Halal Asset Screening
The bot maintains a whitelist (`HALAL_SYMBOLS`) of assets broadly considered permissible by contemporary scholars. If you configure a symbol not on this list, the bot blocks execution and asks you to verify with your scholar before adding it.

**Default whitelist:** BTC, ETH, BNB, ADA, SOL, DOT, LINK, MATIC, AVAX, ATOM, XLM, ALGO, NEAR, FTM, INJ, SUI, APT (and their USDT/USDC pairs).

### 4. Reduced Gharar (Uncertainty)
The strategy requires price to be within 2% of VWAP before entry. This guards against entering highly volatile, overextended conditions where uncertainty is excessive.

### 5. Zakat on Trading Holdings
Run `node bot.js --zakat` at any time to calculate the estimated zakat due. For trade goods it is 2.5% of the market value of your holdings on your zakat date (not just profit), once above nisab and held a lunar year:
- 2.5% is due on net profits held above the nisab threshold for one lunar year
- Set your nisab threshold in `.env` as `ZAKAT_NISAB_USD` (85g gold or 595g silver; scholars differ). Add cash etc. via `ZAKAT_OTHER_ASSETS_USD`

---

## Getting Started

### Step 1 — Prerequisites
- Node.js 18+ (`node --version`)
- A BitGet account with **Spot Trading** API key (withdrawals OFF, IP whitelist ON)
- TradingView MCP set up (for local mode)

### Step 2 — Install

```
cd trading-bot
npm install
```

### Step 3 — Configure

```
Copy-Item .env.example .env
notepad .env
```

Fill in your BitGet credentials and settings:

```env
BITGET_API_KEY=your_key
BITGET_SECRET_KEY=your_secret
BITGET_PASSPHRASE=your_passphrase

PORTFOLIO_VALUE_USD=1000
MAX_TRADE_SIZE_USD=100
MAX_TRADES_PER_DAY=3

SYMBOL=BTCUSDT
TIMEFRAME=4H
PAPER_TRADING=true

ZAKAT_NISAB_USD=5000
```

### Step 4 — Run in Paper Trading Mode

```
node bot.js
```

Every run is logged to `safety-check-log.json` and `trades.csv`. No real orders are placed until you set `PAPER_TRADING=false`.

### Step 5 — Review the Safety Check Output

The bot prints each condition clearly:
```
── Shariah Screening ────────────────────────────────────
  ✅ BTCUSDT is on the halal-approved asset list

── Safety Check (Halal — Long Entry Only) ───────────────
  Bias: BULLISH — checking long entry conditions

  ✅ Price above VWAP (buyers in control)
  ✅ Price above EMA(8) (uptrend confirmed)
  🚫 RSI(3) below 30 (snap-back setup in uptrend)
     Required: < 30 | Actual: 45.23

── Decision ─────────────────────────────────────────────
  🚫 TRADE BLOCKED
     Failed conditions:
     - RSI(3) below 30 (snap-back setup in uptrend)
```

### Step 6 — Go Live (when ready)

After several days of paper trading that match your expectations, flip to live:

```
# In .env
PAPER_TRADING=false
```

---

## Strategy (Halal VWAP + RSI + EMA + MACD)

| Indicator | Role |
|-----------|------|
| EMA(8) | Trend direction — price above = uptrend |
| VWAP | Session bias — price above = buyers in control |
| RSI(3) | Entry timing — below 30 in uptrend = snap-back setup |
| MACD | Trend confirmation — MACD above signal = bullish momentum |

**All four must align for a buy signal. The bot never shorts.**

---

## Tax Accounting

Every trade is logged to `trades.csv`:

| Column | Description |
|--------|-------------|
| Date / Time (UTC) | When the decision was made |
| Exchange | BitGet |
| Symbol | e.g. BTCUSDT |
| Side | BUY only (no shorts) |
| Quantity | Units traded |
| Price | Market price at execution |
| Total USD | Gross trade value |
| Fee (est.) | 0.1% estimated exchange fee |
| Net Amount | Total USD minus fee |
| Order ID | Exchange reference |
| Mode | PAPER / LIVE / BLOCKED |
| Notes | Which conditions failed, or "Halal spot buy executed" |

```
node bot.js --tax-summary   # Print totals
node bot.js --zakat         # Print zakat estimate
```

---

## Cloud Deployment (24/7 on a VPS)

Cloud mode pulls candle data directly from Binance's free public API — no TradingView needed.

```bash
# On your VPS
apt update && apt install -y nodejs npm git
git clone <your-repo-url> bot && cd bot
npm install
cp .env.example .env && nano .env  # fill in credentials
```

Set a cron schedule (crontab -e):

| Timeframe | Cron line |
|-----------|-----------|
| 4H chart | `0 */4 * * * cd /root/bot && /usr/bin/node bot.js >> bot.log 2>&1` |
| 1D chart | `0 9 * * * cd /root/bot && /usr/bin/node bot.js >> bot.log 2>&1` |
| 1H chart | `0 * * * * cd /root/bot && /usr/bin/node bot.js >> bot.log 2>&1` |

---

## Halal Asset Whitelist

To add a new symbol, verify with your scholar and add it to `HALAL_SYMBOLS` in `bot.js`:

```js
const HALAL_SYMBOLS = new Set([
  "BTCUSDT", "ETHUSDT", // ... existing entries
  "YOURASSETUSDT",      // add here after scholarly verification
]);
```

---

## Files

| File | Purpose |
|------|---------|
| `bot.js` | Main bot — Shariah-compliant logic |
| `rules.json` | Strategy + Shariah compliance notes |
| `.env` | Your credentials (gitignored — never commits) |
| `trades.csv` | Tax + zakat record — auto-written every run |
| `safety-check-log.json` | Full audit trail of every decision |
| `prompts/01-extract-strategy.md` | Build rules.json from trader transcripts |
| `prompts/02-one-shot-trade.md` | Onboarding prompt for Claude Code |

---

## Safety Guardrails

- Spot trading hardcoded — futures API path removed entirely
- No short entry logic in the codebase — bearish bias = wait, never short
- Halal asset check runs before any market data is fetched
- Max trade size capped at `MAX_TRADE_SIZE_USD`
- Max daily trades capped at `MAX_TRADES_PER_DAY`
- Max 1% portfolio risk per trade
- Every decision logged to `safety-check-log.json` with exact indicator values

---

*This is not financial advice and does not constitute a fatwa. Trade responsibly. Never invest more than you can afford to lose.*
