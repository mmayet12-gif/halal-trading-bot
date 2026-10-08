/**
 * Halal Gold Trading Bot — Shariah-Compliant Spot Trading
 *
 * Algorithm : Gold Scalper v2 (PineScript → JavaScript)
 *             SuperTrend(3.0, 10) + RSI(2) timed at FVG / Pivot liquidity zones
 * Original  : Ryan Kalicharan — converted for spot / halal use
 *
 * Shariah compliance:
 *  1. Spot ONLY — no margin / futures / leverage (no riba)
 *  2. NO short selling — only BUY entries (selling what you don't own = haram)
 *  3. Halal asset whitelist enforced before any computation
 *  4. Zakat tracking built-in (node bot.js --zakat)
 *
 * Early-trigger note from Ryan: "triggers ~1–3 candles too soon."
 * Running on CLOSED Binance candles (not live ticks) already adds a natural
 * 1-candle delay vs TradingView, which partially corrects this.
 *
 * Commands:
 *   node bot.js               — run one check cycle
 *   node bot.js --tax-summary — print trade totals
 *   node bot.js --zakat       — print zakat estimate
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Shariah Asset Whitelist ──────────────────────────────────────────────────
// Gold tokens are the highest Shariah-preference asset: each token = 1 troy oz
// physical gold held in a vault. Bay' al-dhahab (gold trade) is explicitly
// permitted in Islamic finance. Always verify new symbols with your scholar.

const GOLD_SYMBOLS = new Set([
  "PAXGUSDT", "PAXGUSDC", "PAXGBTC",   // Pax Gold — Brink's London vault
  "XAUTUSDT", "XAUTUSDC", "XAUTBTC",   // Tether Gold — Swiss gold
]);

const HALAL_SYMBOLS = new Set([
  ...GOLD_SYMBOLS,
  "BTCUSDT",  "BTCUSDC",
  "ETHUSDT",  "ETHUSDC",
  "BNBUSDT",  "BNBUSDC",
  "ADAUSDT",  "ADAUSDC",
  "SOLUSDT",  "SOLUSDC",
  "DOTUSDT",  "LINKUSDT", "MATICUSDT",
  "AVAXUSDT", "ATOMUSDT", "XLMUSDT",
  "ALGOUSDT", "NEARUSDT", "INJUSDT",
  "SUIUSDT",  "APTUSDT",
]);

const HARAM_SYMBOLS = new Set([]); // add known gambling/adult tokens here

function checkShariahScreening(symbol) {
  const s = symbol.toUpperCase();
  console.log("\n── Shariah Screening ────────────────────────────────────\n");
  if (HARAM_SYMBOLS.has(s)) {
    console.log(`🚫 ${s} is on the haram blocked list.`); return false;
  }
  if (!HALAL_SYMBOLS.has(s)) {
    console.log(`⚠️  ${s} is not on the halal whitelist.`);
    console.log(`   Add it to HALAL_SYMBOLS in bot.js after scholar verification.`);
    return false;
  }
  if (GOLD_SYMBOLS.has(s)) {
    console.log(`✅ ${s} — tokenized physical gold (on the bot's whitelist)`);
    console.log(`   Gold trading must be spot, hand-to-hand (AAOIFI Standard 57). Whether a token`);
    console.log(`   satisfies possession (qabd) is disputed — confirm with your scholar.`);
  } else {
    console.log(`✅ ${s} is on the halal-approved list`);
  }
  return true;
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing  = required.filter(k => !process.env[k]);

  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file — creating it...\n");
    writeFileSync(".env", [
      "BITGET_API_KEY=",
      "BITGET_SECRET_KEY=",
      "BITGET_PASSPHRASE=",
      "BITGET_BASE_URL=https://api.bitget.com",
      "PORTFOLIO_VALUE_USD=1000",
      "MAX_TRADE_SIZE_USD=100",
      "MAX_TRADES_PER_DAY=3",
      "PAPER_TRADING=true",
      "SYMBOL=PAXGUSDT",
      "TIMEFRAME=4H",
      "ZAKAT_NISAB_USD=5000",
    ].join("\n") + "\n");
    try { execSync("notepad .env"); } catch {}
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing in .env: ${missing.join(", ")}`);
    try { execSync("notepad .env"); } catch {}
    process.exit(0);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}\n`);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol:        (process.env.SYMBOL || "PAXGUSDT").toUpperCase(),
  timeframe:     process.env.TIMEFRAME || "4H",
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD  || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY    || "3"),
  paperTrading:  process.env.PAPER_TRADING !== "false",
  tradeMode:     "spot", // hardcoded — futures = riba = haram
  zakatNisabUSD: parseFloat(process.env.ZAKAT_NISAB_USD || "5000"),
  bitget: {
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

// Gold Scalper algorithm parameters (mirrors PineScript defaults)
const SC = {
  atrLen:    10,    // SuperTrend ATR length
  factor:    3.0,   // SuperTrend factor
  stConfirm: 2,     // bars ST must hold direction before signalling
  rsiLen:    2,     // RSI length (very fast, intentional)
  rsiOB:     80,    // RSI overbought
  rsiOS:     20,    // RSI oversold
  fvgMinGap: 0.1,   // min FVG size = atr14 × 0.1
  pivLen:    10,    // pivot lookback
  confRange: 1.0,   // confluence proximity = atr14 × 1.0
  cooldown:  3,     // min bars between signals
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging helpers ──────────────────────────────────────────────────────────

function loadLog()     { return existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE, "utf8")) : { trades: [] }; }
function saveLog(log)  { writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

// ─── Market data (Binance public API) ─────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 500) {
  const map = { "1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1H":"1h","4H":"4h","1D":"1d","1W":"1w" };
  const iv  = map[interval] || "4h";
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${iv}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance error ${res.status}`);
  return (await res.json()).map(k => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Gold Scalper Indicators ──────────────────────────────────────────────────
// Converted from PineScript "Gold Scalper — Clean v2" by Ryan Kalicharan.
// All short-side logic removed for Shariah compliance.

/** Wilder's ATR series — result[i] is ATR at candle index i, null for warmup bars */
function calcWilderATRSeries(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;

  let atr = 0;
  for (let i = 1; i <= period; i++) {
    atr += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close),
    );
  }
  atr /= period;
  out[period] = atr;

  for (let i = period + 1; i < n; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close),
    );
    atr = (atr * (period - 1) + tr) / period;
    out[i] = atr;
  }
  return out;
}

/** SuperTrend series — dirs[i]: -1=bullish, 1=bearish, null=warmup */
function calcSuperTrendSeries(candles, factor, atrLen) {
  const n     = candles.length;
  const atrS  = calcWilderATRSeries(candles, atrLen);
  const dirs  = new Array(n).fill(null);
  const ubs   = new Array(n).fill(null);
  const lbs   = new Array(n).fill(null);

  for (let i = 1; i < n; i++) {
    const atr = atrS[i];
    if (!atr) continue;

    const hl2   = (candles[i].high + candles[i].low) / 2;
    const prevUB = ubs[i-1] ?? (hl2 + factor * atr);
    const prevLB = lbs[i-1] ?? (hl2 - factor * atr);
    const pc    = candles[i-1].close;

    let ub = hl2 + factor * atr;
    let lb = hl2 - factor * atr;

    // Bands only tighten — never widen (unless previous close broke through)
    lb = (lb > prevLB || pc < prevLB) ? lb : prevLB;
    ub = (ub < prevUB || pc > prevUB) ? ub : prevUB;

    ubs[i] = ub;
    lbs[i] = lb;

    const prevDir = dirs[i-1] ?? 1;
    if (prevDir === 1)       dirs[i] = candles[i].close > ub ? -1 : 1;  // was bearish → flip if close > upper
    else /* prevDir === -1 */ dirs[i] = candles[i].close < lb ?  1 : -1; // was bullish → flip if close < lower
  }
  return { dirs, ubs, lbs };
}

/** RSI series using Wilder's smoothing (matches ta.rsi in PineScript) */
function calcRSISeries(closes, period) {
  const n   = closes.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;

  let avgUp = 0, avgDown = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) avgUp += d; else avgDown -= d;
  }
  avgUp   /= period;
  avgDown /= period;
  out[period] = avgDown === 0 ? 100 : 100 - 100 / (1 + avgUp / avgDown);

  const alpha = 1 / period;
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i-1];
    avgUp   = alpha * (d > 0 ? d : 0) + (1 - alpha) * avgUp;
    avgDown = alpha * (d < 0 ? -d : 0) + (1 - alpha) * avgDown;
    out[i]  = avgDown === 0 ? 100 : 100 - 100 / (1 + avgUp / avgDown);
  }
  return out;
}

/** Most recent pivot high: high[i] is strictly greater than all highs ±len bars */
function findLastPivotHigh(candles, len) {
  const n = candles.length;
  for (let i = n - len - 1; i >= len; i--) {
    let ok = true;
    for (let j = i - len; j <= i + len && ok; j++) {
      if (j !== i && candles[j]?.high >= candles[i].high) ok = false;
    }
    if (ok) return candles[i].high;
  }
  return null;
}

/** Most recent pivot low */
function findLastPivotLow(candles, len) {
  const n = candles.length;
  for (let i = n - len - 1; i >= len; i--) {
    let ok = true;
    for (let j = i - len; j <= i + len && ok; j++) {
      if (j !== i && candles[j]?.low <= candles[i].low) ok = false;
    }
    if (ok) return candles[i].low;
  }
  return null;
}

/** Scan backward for the most recent active bullish FVG (gap up: low[i] > high[i-2]) */
function findActiveBullFVG(candles, minGapMult, atr14, confRange) {
  const n      = candles.length;
  const minGap = atr14 * minGapMult;
  const price  = candles[n-1].close;

  for (let i = n - 1; i >= 2; i--) {
    const gap = candles[i].low - candles[i-2].high;
    if (gap < minGap) continue;
    const top = candles[i].low;
    const bot = candles[i-2].high;
    if (price < bot - confRange) continue; // invalidated — price fell through
    return { top, bot, active: price >= bot - confRange && price <= top + confRange };
  }
  return { top: null, bot: null, active: false };
}

/** Timeframe → milliseconds (for cooldown check) */
function timeframeMs() {
  return { "1m":60e3,"3m":180e3,"5m":300e3,"15m":900e3,"30m":1800e3,"1H":3600e3,"4H":14400e3,"1D":86400e3 }[CONFIG.timeframe] ?? 14400e3;
}

// ─── Gold Scalper Safety Check (long / buy only) ──────────────────────────────

function runGoldScalperCheck(candles, log) {
  const n      = candles.length;
  const closes = candles.map(c => c.close);
  const price  = closes[n-1];
  const curr   = candles[n-1];
  const prev   = candles[n-2];

  // ── Indicators ──
  const { dirs } = calcSuperTrendSeries(candles, SC.factor, SC.atrLen);
  const rsiSeries = calcRSISeries(closes, SC.rsiLen);
  const atr14S    = calcWilderATRSeries(candles, 14);

  const atr14     = atr14S[n-1];
  const confRange = atr14 * SC.confRange;

  const dirNow   = dirs[n-1];
  const dirPrev  = dirs[n-2];
  const dirPrev2 = dirs[n-3] ?? dirs[n-2];
  const rsiNow   = rsiSeries[n-1];
  const rsiPrev  = rsiSeries[n-2];

  const results = [];
  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log(`\n── Gold Scalper Check (Long Only — Shariah) ─────────────\n`);

  if (!atr14 || dirNow === null || rsiNow === null) {
    console.log("  ⚠️  Insufficient candle data for indicators.");
    return { allPass: false, results: [{ label: "Data", pass: false }], exitSignal: false, indicators: {} };
  }

  // ── SuperTrend direction ──
  const bullRaw  = dirNow   === -1;
  const bullRaw1 = dirPrev  === -1;
  const bullRaw2 = dirPrev2 === -1;
  // Count consecutive bullish bars (for strong-trend bypass)
  let stBullCount = 0;
  for (let i = n - 1; i >= 0 && dirs[i] === -1; i--) stBullCount++;
  const strongBull = stBullCount >= 5;

  // Exit advisory: SuperTrend just flipped from bull to bear
  const exitSig = dirNow === 1 && dirPrev === -1;

  if (!bullRaw) {
    console.log("  Bias: BEARISH / NEUTRAL — SuperTrend is bearish");
    console.log("  ℹ️  No short selling under Shariah. Waiting for bullish setup.\n");
    if (exitSig) {
      console.log("  ⚠️  EXIT ADVISORY: SuperTrend just flipped bearish.");
      console.log("     If you hold PAXG, consider selling your position on BitGet.\n");
    }
    return {
      allPass: false,
      results: [{ label: "SuperTrend bullish", required: "dir = -1", actual: "dir = 1 (bearish)", pass: false }],
      exitSignal: exitSig,
      indicators: { atr14, rsiNow, dirNow, stBullCount },
    };
  }

  // ── SuperTrend confirmation (must hold ≥ stConfirm bars) ──
  const stConfirmed = bullRaw && bullRaw1 && (SC.stConfirm < 3 || bullRaw2);
  check(
    `SuperTrend bullish for ≥${SC.stConfirm} bars`,
    `${SC.stConfirm} bars`,
    `${stBullCount} bars`,
    stConfirmed,
  );

  // ── RSI(2) timing ──
  // Primary: RSI crosses back above oversold level (cross = confirmation)
  const rsiBullCross = rsiNow > SC.rsiOS && rsiPrev <= SC.rsiOS;
  // Secondary: RSI still at extreme but candle is bullish (green)
  const rsiBullLvl   = rsiNow <= SC.rsiOS && curr.close > curr.open;
  const rsiOk        = rsiBullCross || rsiBullLvl;
  check(
    `RSI(${SC.rsiLen}) cross above ${SC.rsiOS} OR at extreme with bullish candle`,
    `RSI cross >20 OR (RSI ≤20 + green candle)`,
    `RSI: ${rsiNow.toFixed(1)} | prev: ${rsiPrev?.toFixed(1)} | cross: ${rsiBullCross} | extreme+bull: ${rsiBullLvl}`,
    rsiOk,
  );

  // ── FVG + Pivot confluence ──
  const bullFVG  = findActiveBullFVG(candles, SC.fvgMinGap, atr14, confRange);
  const lastPH   = findLastPivotHigh(candles, SC.pivLen);
  const lastPL   = findLastPivotLow(candles, SC.pivLen);
  const nearPivHi = lastPH !== null && Math.abs(price - lastPH) <= confRange;
  const nearPivLo = lastPL !== null && Math.abs(price - lastPL) <= confRange;
  const sweptLow  = lastPL !== null && prev.low < lastPL && price > lastPL;
  const bullConf  = (bullFVG.active || nearPivLo || sweptLow) && !nearPivHi;

  if (strongBull) {
    console.log(`  ✅ Strong trend — ${stBullCount} consecutive bull bars — confluence waived`);
    results.push({ label: "Confluence (strong trend bypass)", required: "FVG/pivot or 5+ bull bars", actual: `${stBullCount} bull bars`, pass: true });
  } else {
    const confDetail = [
      `bullFVG: ${bullFVG.active}`,
      `nearPivLo: ${nearPivLo}`,
      `sweptLow: ${sweptLow}`,
      `NOT nearPivHi: ${!nearPivHi}`,
    ].join(" | ");
    check(
      "Confluence — in bull FVG / near pivot low / liquidity sweep",
      "Any one condition true",
      confDetail,
      bullConf,
    );
  }

  // ── Bar cooldown ──
  const cooldownMs = SC.cooldown * timeframeMs();
  const cutoff     = new Date(Date.now() - cooldownMs).toISOString();
  const recentTrade = log.trades.some(t => t.orderPlaced && t.timestamp > cutoff);
  check(
    `Cooldown — no trade in last ${SC.cooldown} bars`,
    `${SC.cooldown} bars clear`,
    recentTrade ? "too soon since last trade" : "clear",
    !recentTrade,
  );

  // ── Summary display ──
  console.log(`\n  Indicator values:`);
  console.log(`    ATR(14):       ${atr14.toFixed(2)}`);
  console.log(`    Conf range:    ±${confRange.toFixed(2)}`);
  console.log(`    RSI(${SC.rsiLen}):        ${rsiNow.toFixed(2)}`);
  if (lastPH) console.log(`    Pivot high:    ${lastPH.toFixed(2)}${nearPivHi ? " ← near" : ""}`);
  if (lastPL) console.log(`    Pivot low:     ${lastPL.toFixed(2)}${nearPivLo ? " ← near" : ""}${sweptLow ? " ← swept" : ""}`);
  if (bullFVG.top) console.log(`    Bull FVG:      ${bullFVG.bot?.toFixed(2)} – ${bullFVG.top?.toFixed(2)}${bullFVG.active ? " ← active" : ""}`);
  if (exitSig) {
    console.log(`\n  ⚠️  EXIT ADVISORY: SuperTrend just flipped bearish.`);
    console.log(`     If you hold PAXG, consider selling your position on BitGet.\n`);
  }

  const allPass = results.every(r => r.pass);
  return {
    allPass,
    results,
    exitSignal: exitSig,
    indicators: { atr14, confRange, rsiNow, dirNow, stBullCount, bullFVG, lastPH, lastPL },
  };
}

// ─── Trade Limits ─────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Daily cap reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay}`);
  console.log(`✅ Trade size:   $${tradeSize.toFixed(2)} (max $${CONFIG.maxTradeSizeUSD})`);
  return true;
}

// ─── BitGet Spot Execution ────────────────────────────────────────────────────

function signBitGet(ts, method, path, body = "") {
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey)
    .update(`${ts}${method}${path}${body}`).digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const qty       = (sizeUSD / price).toFixed(6);
  const ts        = Date.now().toString();
  const path      = "/api/v2/spot/trade/placeOrder";
  const body      = JSON.stringify({ symbol, side, orderType: "market", quantity: qty });
  const signature = signBitGet(ts, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type":       "application/json",
      "ACCESS-KEY":         CONFIG.bitget.apiKey,
      "ACCESS-SIGN":        signature,
      "ACCESS-TIMESTAMP":   ts,
      "ACCESS-PASSPHRASE":  CONFIG.bitget.passphrase,
    },
    body,
  });
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet: ${data.msg}`);
  return data.data;
}

// ─── Zakat Calculator ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

function calculateZakat() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv yet."); return; }
  const rows = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1).map(l => l.split(","));
  const live = rows.filter(r => r[11] === "LIVE");
  // Trade goods (urud al-tijara): zakat is 2.5% of the market value of what you
  // hold on your zakat date, not of profit or trading volume.
  const held = live.reduce((s, r) => s + (r[4] === "buy" ? 1 : -1) * parseFloat(r[5] || 0), 0);
  const last = live.length ? parseFloat(live[live.length - 1][6] || 0) : 0;
  const other = parseFloat(process.env.ZAKAT_OTHER_ASSETS_USD || "0");
  const holdingsUSD = Math.max(held, 0) * last;
  const base = holdingsUSD + other;
  const due  = base >= CONFIG.zakatNisabUSD ? base * 0.025 : 0;
  console.log("\n── Zakat Summary (estimate) ─────────────────────────────\n");
  console.log(`  Live trades:      ${live.length}`);
  console.log(`  Tokens held:      ${Math.max(held, 0).toFixed(6)} @ last trade price $${last.toFixed(2)}`);
  console.log(`  Holdings value:   $${holdingsUSD.toFixed(2)}  (re-value at today's price before paying)`);
  console.log(`  Other zakatable:  $${other.toFixed(2)}  (ZAKAT_OTHER_ASSETS_USD: cash, etc.)`);
  console.log(`  Nisab:            $${CONFIG.zakatNisabUSD}  (85g gold or 595g silver; scholars differ)`);
  console.log(base >= CONFIG.zakatNisabUSD
    ? `  ✅ Zakat due:      $${due.toFixed(2)} (2.5% of total) — if held a full lunar year (hawl)`
    : `  ℹ️  Below nisab — no zakat due yet`);
  console.log("\n  Consult your scholar for your exact situation.\n");
}

// ─── Tax CSV ──────────────────────────────────────────────────────────────────

const CSV_HEADERS = ["Date","Time (UTC)","Exchange","Symbol","Side","Quantity","Price","Total USD","Fee (est.)","Net Amount","Order ID","Mode","Notes"].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" +
      `,,,,,,,,,,,"NOTE","Halal Gold Bot — Spot only · No shorts · Shariah screened"\n`);
  }
}

function writeTradeCsv(entry) {
  const dt   = new Date(entry.timestamp);
  const date = dt.toISOString().slice(0, 10);
  const time = dt.toISOString().slice(11, 19);
  let side = "", qty = "", total = "", fee = "", net = "", oid = "", mode = "", notes = "";

  if (!entry.allPass) {
    const failed = entry.conditions.filter(c => !c.pass).map(c => c.label).join("; ");
    mode = "BLOCKED"; oid = "BLOCKED"; notes = `Failed: ${failed}`;
  } else {
    side  = "BUY";
    qty   = (entry.tradeSize / entry.price).toFixed(6);
    total = entry.tradeSize.toFixed(2);
    fee   = (entry.tradeSize * 0.001).toFixed(4);
    net   = (entry.tradeSize - parseFloat(fee)).toFixed(2);
    oid   = entry.orderId || "";
    mode  = entry.paperTrading ? "PAPER" : "LIVE";
    notes = entry.error ? `Error: ${entry.error}` : "Halal spot buy";
  }

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, [date,time,"BitGet",entry.symbol,side,qty,entry.price?.toFixed(2),total,fee,net,oid,mode,`"${notes}"`].join(",") + "\n");
  console.log(`📝 Tax record → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv yet."); return; }
  const rows    = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1).map(l => l.split(","));
  const live    = rows.filter(r => r[11] === "LIVE");
  const paper   = rows.filter(r => r[11] === "PAPER");
  const blocked = rows.filter(r => r[11] === "BLOCKED");
  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total logged:     ${rows.length}`);
  console.log(`  Live trades:      ${live.length}`);
  console.log(`  Paper trades:     ${paper.length}`);
  console.log(`  Blocked:          ${blocked.length}`);
  console.log(`  Volume (USD):     $${live.reduce((s,r) => s+parseFloat(r[7]||0),0).toFixed(2)}`);
  console.log(`  Fees (est.):      $${live.reduce((s,r) => s+parseFloat(r[8]||0),0).toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Halal Gold Trading Bot — Gold Scalper v2");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("  Algorithm: SuperTrend + RSI(2) + FVG + Pivot zones");
  console.log("  Rules: Spot only · No shorts · Halal assets only");
  console.log("═══════════════════════════════════════════════════════════");

  if (!checkShariahScreening(CONFIG.symbol)) {
    console.log("\nStopping — asset failed Shariah screening.");
    return;
  }

  const log = loadLog();
  if (!checkTradeLimits(log)) { console.log("\nStopping — daily trade limit reached."); return; }

  console.log(`\n── Fetching ${CONFIG.symbol} candles from Binance ──────────────\n`);
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const price   = candles[candles.length - 1].close;
  console.log(`  Symbol:    ${CONFIG.symbol}`);
  console.log(`  Timeframe: ${CONFIG.timeframe}`);
  console.log(`  Price:     $${price.toFixed(2)}`);
  console.log(`  Candles:   ${candles.length}`);

  const { allPass, results, exitSignal, indicators } = runGoldScalperCheck(candles, log);

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const entry = {
    timestamp:    new Date().toISOString(),
    symbol:       CONFIG.symbol,
    timeframe:    CONFIG.timeframe,
    price,
    indicators,
    conditions:   results,
    allPass,
    exitSignal,
    tradeSize,
    orderPlaced:  false,
    orderId:      null,
    paperTrading: CONFIG.paperTrading,
    shariah:      { spotOnly: true, noShorts: true, halalScreened: true },
    limits:       { maxTradeSizeUSD: CONFIG.maxTradeSizeUSD, maxTradesPerDay: CONFIG.maxTradesPerDay, tradesToday: countTodaysTrades(log) },
  };

  if (!allPass) {
    const failed = results.filter(r => !r.pass).map(r => r.label);
    console.log("🚫 TRADE BLOCKED");
    failed.forEach(f => console.log(`   — ${f}`));
  } else {
    console.log("✅ ALL CONDITIONS MET — Gold Scalper signal confirmed");

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — would buy ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      entry.orderPlaced = true;
      entry.orderId     = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIVE SPOT BUY — $${tradeSize.toFixed(2)} ${CONFIG.symbol}`);
      try {
        const order      = await placeBitGetOrder(CONFIG.symbol, "buy", tradeSize, price);
        entry.orderPlaced = true;
        entry.orderId     = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        entry.error = err.message;
      }
    }
  }

  log.trades.push(entry);
  saveLog(log);
  console.log(`\n📊 Decision log → ${LOG_FILE}`);
  writeTradeCsv(entry);
  console.log("═══════════════════════════════════════════════════════════\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if      (process.argv.includes("--tax-summary")) generateTaxSummary();
else if (process.argv.includes("--zakat"))        calculateZakat();
else run().catch(err => { console.error("Bot error:", err); process.exit(1); });
