/**
 * Claude + TradingView MCP — Halal Automated Trading Bot
 *
 * Shariah Compliance Principles:
 *  1. Spot trading ONLY — no margin, no futures, no leverage (no riba)
 *  2. No short selling — only buy/sell assets you own (no selling what you don't possess)
 *  3. Halal asset screening — only trade Shariah-permissible crypto pairs
 *  4. Zakat tracking — 2.5% due on net profits held above nisab for a lunar year
 *  5. No gharar — clear, transparent entry/exit conditions required before any trade
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet (spot only) if everything lines up.
 *
 * Local mode: node bot.js
 * Tax summary: node bot.js --tax-summary
 * Zakat summary: node bot.js --zakat
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Shariah-Approved Asset Whitelist ────────────────────────────────────────
// Gold tokens (PAXG, XAUT) are considered highly Shariah-compliant because
// each token is backed 1:1 by physical gold held in a vault — this is
// the digital equivalent of owning gold (dhahab), which has always been
// a permitted store of value and medium of trade in Islamic finance.
//
// Other crypto: permitted where the asset has utility and no interest mechanism.
// Always verify new assets with your own scholar.
const HALAL_SYMBOLS = new Set([
  // ── Gold-backed tokens (highest Shariah preference) ──
  "PAXGUSDT",  // Pax Gold — 1 token = 1 troy oz, held in Brink's London vault
  "PAXGUSDC",
  "PAXGBTC",
  "XAUTUSDT",  // Tether Gold — 1 token = 1 troy oz Swiss gold
  "XAUTUSDC",
  "XAUTBTC",
  // ── Major crypto (broadly accepted as halal) ──
  "BTCUSDT", "BTCUSDC",
  "ETHUSDT", "ETHUSDC",
  "BNBUSDT", "BNBUSDC",
  "ADAUSDT", "ADAUSDC",
  "SOLUSDT", "SOLUSDC",
  "DOTUSDT",
  "LINKUSDT",
  "MATICUSDT",
  "AVAXUSDT",
  "ATOMUSDT",
  "XLMUSDT",
  "ALGOUSDT",
  "NEARUSDT",
  "INJUSDT",
  "SUIUSDT",
  "APTUSDT",
]);

// Symbols explicitly blocked regardless of technical setup
const HARAM_SYMBOLS = new Set([
  // Add any tokens you know are tied to gambling, adult content, etc.
  // e.g. "CASINOTOKEN", "BETUSDT"
]);

const GOLD_SYMBOLS = new Set(["PAXGUSDT", "PAXGUSDC", "PAXGBTC", "XAUTUSDT", "XAUTUSDC", "XAUTBTC"]);

function checkShariahScreening(symbol) {
  const upper = symbol.toUpperCase();
  console.log("\n── Shariah Screening ────────────────────────────────────\n");

  if (HARAM_SYMBOLS.has(upper)) {
    console.log(`🚫 ${upper} is on the haram blocked list. Trade not permitted.`);
    return false;
  }
  if (!HALAL_SYMBOLS.has(upper)) {
    console.log(`⚠️  ${upper} is not on the halal whitelist.`);
    console.log(`   If your scholar has approved this asset, add it to HALAL_SYMBOLS in bot.js.`);
    console.log(`   Proceeding is blocked until explicitly whitelisted.`);
    return false;
  }
  if (GOLD_SYMBOLS.has(upper)) {
    console.log(`✅ ${upper} — tokenized physical gold (highest Shariah preference)`);
    console.log(`   Each token is backed 1:1 by a troy ounce of physical gold in a vault.`);
    console.log(`   Trading gold is explicitly permitted in Islamic finance (Bay' al-dhahab).`);
  } else {
    console.log(`✅ ${upper} is on the halal-approved asset list`);
  }
  return true;
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found — creating it for you...\n");
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config — SPOT ONLY (Shariah compliance)",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
        "",
        "# Zakat settings",
        "# Nisab threshold in USD (approx. value of 85g gold or 595g silver — update periodically)",
        "ZAKAT_NISAB_USD=5000",
      ].join("\n") + "\n",
    );
    try { execSync("notepad .env"); } catch {}
    console.log("Fill in your BitGet credentials in .env then re-run: node bot.js\n");
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    try { execSync("notepad .env"); } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(`   Open in Google Sheets or Excel — or ask Claude to move it.\n`);
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: (process.env.SYMBOL || "BTCUSDT").toUpperCase(),
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  // ALWAYS spot — futures/margin involve riba (interest), which is haram
  tradeMode: "spot",
  zakatNisabUSD: parseFloat(process.env.ZAKAT_NISAB_USD || "5000"),
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  const intervalMap = {
    "1m": "1m", "3m": "3m", "5m": "5m",
    "15m": "15m", "30m": "30m",
    "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1h";
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// MACD — used for additional trend confirmation
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast - emaSlow;

  // Approximate signal line from last `signal` MACD values
  const macdValues = [];
  for (let i = closes.length - signal - 1; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    if (slice.length < slow) continue;
    const f = calcEMA(slice, fast);
    const s = calcEMA(slice, slow);
    macdValues.push(f - s);
  }
  const signalLine = calcEMA(macdValues, signal);
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Shariah Safety Check (LONG / BUY only — no short selling) ──────────────
// Short selling is prohibited in Islamic finance because you are selling
// something you do not own. This bot only evaluates buy conditions.
//
// Gold-specific thresholds: PAXG/XAUT move more slowly than BTC.
// VWAP distance cap is widened to 1% (gold doesn't gap 2% intraday often).
// RSI threshold relaxed slightly to 35 for gold (less volatile asset).

function runSafetyCheck(price, ema8, vwap, rsi3, macd, rules) {
  const results = [];
  const isGold = GOLD_SYMBOLS.has(CONFIG.symbol);

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log(`\n── Safety Check (Halal — Long Entry Only${isGold ? " — Gold Mode" : ""}) ────\n`);

  const bullishBias = price > vwap && price > ema8;
  const macdBullish = macd ? macd.macdLine > macd.signalLine : null;

  // Gold moves slowly — use tighter VWAP distance (1%) and slightly relaxed RSI (35)
  const rsiThreshold = isGold ? 35 : 30;
  const vwapDistThreshold = isGold ? 1.0 : 2.0;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    check(
      `RSI(3) below ${rsiThreshold} (pullback entry in uptrend)`,
      `< ${rsiThreshold}`,
      rsi3.toFixed(2),
      rsi3 < rsiThreshold,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      `Price within ${vwapDistThreshold}% of VWAP (not overextended — reduces gharar)`,
      `< ${vwapDistThreshold}%`,
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < vwapDistThreshold,
    );

    if (macd !== null) {
      check(
        "MACD line above signal line (momentum confirmation)",
        "MACD > Signal",
        `MACD ${macd.macdLine.toFixed(4)} | Signal ${macd.signalLine.toFixed(4)}`,
        macdBullish,
      );
    }
  } else {
    console.log("  Bias: NEUTRAL / BEARISH\n");
    console.log("  ℹ️  Short selling is not permitted under Shariah principles.");
    console.log("  No trade will be placed. Waiting for a halal long setup.\n");
    results.push({
      label: "Halal long setup required",
      required: "Bullish bias (price above VWAP and EMA8)",
      actual: "Bias is neutral or bearish",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);
  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(`🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`);
    return false;
  }
  console.log(`✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`);
  return true;
}

// ─── BitGet Execution (Spot Only) ────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  // Hard-enforce spot — futures involve margin interest (riba)
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path = "/api/v2/spot/trade/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }
  return data.data;
}

// ─── Zakat Calculator ────────────────────────────────────────────────────────
// Zakat on trading profits: 2.5% is due on net profits that have been held
// above the nisab threshold for one lunar year (354 days).
// This is a simplified tracker — consult your scholar for your specific situation.

function calculateZakat() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));
  const live = rows.filter((r) => r[11] === "LIVE");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);
  const netProfit = totalVolume - totalFees; // simplified — assumes all closed at profit

  const zakatDue = netProfit >= CONFIG.zakatNisabUSD ? netProfit * 0.025 : 0;

  console.log("\n── Zakat Summary (Simplified) ───────────────────────────\n");
  console.log(`  Total live trades      : ${live.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`  Nisab threshold        : $${CONFIG.zakatNisabUSD.toFixed(2)}`);
  console.log(
    netProfit >= CONFIG.zakatNisabUSD
      ? `  ✅ Above nisab — Zakat due: $${zakatDue.toFixed(2)} (2.5% of net)`
      : `  ℹ️  Below nisab — No zakat due yet on these profits`,
  );
  console.log(`\n  NOTE: This is a simplified calculation based on gross trade volume.`);
  console.log(`  Consult your scholar for a ruling based on your actual net position.\n`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

const CSV_HEADERS = [
  "Date", "Time (UTC)", "Exchange", "Symbol", "Side",
  "Quantity", "Price", "Total USD", "Fee (est.)", "Net Amount",
  "Order ID", "Mode", "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const note = `,,,,,,,,,,,"NOTE","Halal trading bot — Spot only, no short selling, Shariah-screened assets."`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + note + "\n");
    console.log(`📄 Created ${CSV_FILE}`);
  }
}

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "", quantity = "", totalUSD = "", fee = "",
    netAmount = "", orderId = "", mode = "", notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met — Halal spot buy";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "Halal spot buy executed";
  }

  const row = [
    date, time, "BitGet", logEntry.symbol, side,
    quantity, logEntry.price.toFixed(2), totalUSD, fee, netAmount,
    orderId, mode, `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));
  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");
  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Halal Trading Bot — Shariah-Compliant Spot Trading");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("  Rules: Spot only | No shorts | Halal assets only");
  console.log("═══════════════════════════════════════════════════════════");

  // Shariah asset screening — block before any computation
  const halal = checkShariahScreening(CONFIG.symbol);
  if (!halal) {
    console.log("\nBot stopping — asset failed Shariah screening.");
    process.exit(0);
  }

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data
  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);
  const macd = calcMACD(closes);

  console.log(`  EMA(8):        $${ema8.toFixed(2)}`);
  console.log(`  VWAP:          $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):        ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);
  if (macd) {
    console.log(`  MACD:          ${macd.macdLine.toFixed(4)}`);
    console.log(`  MACD Signal:   ${macd.signalLine.toFixed(4)}`);
    console.log(`  MACD Histogram:${macd.histogram.toFixed(4)}`);
  }

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // Run safety check — long/buy entries only
  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, macd, rules);

  // Position size — max 1% of portfolio
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3, macd },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    shariah: { spotOnly: true, noShorts: true, halalScreened: true },
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — would buy ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market (spot, halal)`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIVE SPOT ORDER — $${tradeSize.toFixed(2)} BUY ${CONFIG.symbol}`);
      try {
        const order = await placeBitGetOrder(CONFIG.symbol, "buy", tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  writeTradeCsv(logEntry);
  console.log("═══════════════════════════════════════════════════════════\n");
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else if (process.argv.includes("--zakat")) {
  calculateZakat();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
