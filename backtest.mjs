#!/usr/bin/env node
// Backtest the bot's own Gold Scalper signal on historical candles.
//
//   node backtest.mjs                      # 365 days of SYMBOL/TIMEFRAME from Binance
//   node backtest.mjs --days 730 --symbol PAXGUSDT --timeframe 4H
//   node backtest.mjs --csv candles.csv    # offline: time,open,high,low,close,volume
//
// The signal code is read from bot.js at run time and executed unchanged, so
// this tests exactly what the bot trades on, not a re-implementation. Two
// exit policies are compared against buying and holding the same amount:
//   A. As built: the bot only buys. It prints an "exit advisory" when
//      SuperTrend flips bearish but never sells, so positions accumulate.
//   B. Follow the advisory: sell everything at the close of each flip bar.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const DAYS = Number(opt("days", 365));
const SYMBOL = (opt("symbol", process.env.SYMBOL || "PAXGUSDT")).toUpperCase();
const TIMEFRAME = opt("timeframe", process.env.TIMEFRAME || "4H");
const FEE = Number(opt("fee", 0.001)); // per side; BitGet spot taker is ~0.1%
const PORTFOLIO = Number(process.env.PORTFOLIO_VALUE_USD || 1000);
const MAX_TRADE = Number(process.env.MAX_TRADE_SIZE_USD || 100);
const MAX_PER_DAY = Number(process.env.MAX_TRADES_PER_DAY || 3);
const TRADE_SIZE = Math.min(PORTFOLIO * 0.01, MAX_TRADE); // same formula as bot.js
const CSV = opt("csv", null);

// ── Load the bot's signal functions unchanged ──
const here = path.dirname(fileURLToPath(import.meta.url));
const botSrc = readFileSync(path.join(here, "bot.js"), "utf8");
const start = botSrc.indexOf("function calcWilderATRSeries");
const end = botSrc.indexOf("// ─── Trade Limits");
if (start < 0 || end < 0) throw new Error("bot.js layout changed: couldn't find the signal functions to backtest");
const SC_SRC = botSrc.match(/const SC = \{[\s\S]*?\n\};/)[0];
let simNow = 0;
const SimDate = class extends Date { static now() { return simNow; } };
const quiet = { log() {}, warn() {}, error() {} };
const lib = new Function("CONFIG", "console", "Date",
  `${SC_SRC}\n${botSrc.slice(start, end)}\nreturn { runGoldScalperCheck, calcSuperTrendSeries };`,
)({ timeframe: TIMEFRAME }, quiet, SimDate);

// ── Candles ──
const IV = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1h", "4H": "4h", "1D": "1d" }[TIMEFRAME] || "4h";
const BAR_MS = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1H": 3600e3, "4H": 14400e3, "1D": 86400e3 }[TIMEFRAME] ?? 14400e3;

async function fetchHistory() {
  const out = [];
  let from = Date.now() - DAYS * 86400e3;
  while (true) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${IV}&startTime=${from}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance error ${res.status} for ${url}`);
    const rows = await res.json();
    for (const k of rows) out.push({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    if (rows.length < 1000) break;
    from = rows[rows.length - 1][0] + 1;
  }
  return out.filter((c) => c.time + BAR_MS <= Date.now()); // closed bars only
}

function loadCsv(file) {
  return readFileSync(file, "utf8").trim().split("\n").filter((l) => /^\d/.test(l)).map((l) => {
    const [time, open, high, low, close, volume] = l.split(",").map(Number);
    return { time, open, high, low, close, volume };
  });
}

const candles = CSV ? loadCsv(CSV) : await fetchHistory();
const WARMUP = 100;
if (candles.length < WARMUP + 10) throw new Error(`only ${candles.length} candles; need at least ${WARMUP + 10}`);

// ── Simulate ──
const log = { trades: [] };
const A = { qty: 0, invested: 0, buys: 0 };
const B = { qty: 0, invested: 0, realized: 0, cost: 0, buys: 0, roundTrips: 0, wins: 0 };
const dayCount = new Map();

for (let i = WARMUP; i < candles.length; i++) {
  const bar = candles[i];
  simNow = bar.time + BAR_MS; // the bot runs just after a bar closes
  const window = candles.slice(Math.max(0, i - 499), i + 1); // the bot fetches the last 500
  const { allPass, exitSignal } = lib.runGoldScalperCheck(window, log);
  const day = new Date(simNow).toISOString().slice(0, 10);

  if (exitSignal && B.qty > 0) {
    const proceeds = B.qty * bar.close * (1 - FEE);
    B.realized += proceeds - B.cost;
    B.roundTrips++;
    if (proceeds > B.cost) B.wins++;
    B.qty = 0; B.cost = 0;
  }
  if (allPass && (dayCount.get(day) || 0) < MAX_PER_DAY) {
    const qty = (TRADE_SIZE * (1 - FEE)) / bar.close;
    A.qty += qty; A.invested += TRADE_SIZE; A.buys++;
    B.qty += qty; B.cost += TRADE_SIZE; B.invested += TRADE_SIZE; B.buys++;
    dayCount.set(day, (dayCount.get(day) || 0) + 1);
    log.trades.push({ orderPlaced: true, timestamp: new Date(simNow).toISOString() });
  }
}

// ── Report ──
const first = candles[WARMUP], last = candles[candles.length - 1];
const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const usd = (x) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;
const aValue = A.qty * last.close;
const bOpen = B.qty * last.close;
const bPnl = B.realized + (bOpen - B.cost);
const holdReturn = (last.close / first.close) * (1 - FEE) ** 2 - 1;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

console.log(`\nGold Scalper backtest — ${SYMBOL} ${TIMEFRAME}, ${iso(first.time)} to ${iso(last.time)} (${candles.length - WARMUP} bars${CSV ? `, from ${CSV}` : ", Binance"})`);
console.log(`Trade size ${usd(TRADE_SIZE)} (bot.js formula), max ${MAX_PER_DAY}/day, fee ${(FEE * 100).toFixed(2)}% per side, no slippage.\n`);
console.log(`Signals that would have bought: ${A.buys}`);
if (A.buys === 0) { console.log("No buy signals in this window. Try a longer --days."); process.exit(0); }
console.log(`\nA. As built (buys only, never sells)`);
console.log(`   Invested ${usd(A.invested)} -> worth ${usd(aValue)} now: ${pct(aValue / A.invested - 1)}`);
console.log(`\nB. Following every exit advisory`);
console.log(`   ${B.roundTrips} round trips, ${B.wins} profitable (${B.roundTrips ? ((B.wins / B.roundTrips) * 100).toFixed(0) : 0}%)`);
console.log(`   Total P&L ${usd(bPnl)} on ${usd(B.invested)} bought: ${pct(bPnl / B.invested)}${B.qty > 0 ? ` (includes an open position worth ${usd(bOpen)})` : ""}`);
console.log(`\nBenchmark: buy at the first bar and hold: ${pct(holdReturn)}`);
console.log(`\nRead this as a sanity check, not a forecast: one symbol, one window, closed-bar signals (the live bot runs every 4 hours and may see a bar before it closes), no slippage, and no PAXG premium or discount to spot gold.\n`);
