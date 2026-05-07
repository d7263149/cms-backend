import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT ?? 3001;

const SYMBOLS = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT", ticker_id: "BTC-PERPUSDT", maker_fee: -0.0001, taker_fee: 0.0006 },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT", ticker_id: "ETH-PERPUSDT", maker_fee: -0.0001, taker_fee: 0.0006 },
  { symbol: "XRPUSDT", base: "XRP", quote: "USDT", ticker_id: "XRP-PERPUSDT", maker_fee: -0.0001, taker_fee: 0.0006 },
];

const GLOBAL_MULTIPLIER = parseFloat(process.env.VOLUME_MULTIPLIER ?? "1");
const PER_SYMBOL_MULTIPLIER: Record<string, number> = {
  // "BTC-PERPUSDT": 2.0,
  // "ETH-PERPUSDT": 1.5,
};

function getMultiplier(ticker_id: string): number {
  return PER_SYMBOL_MULTIPLIER[ticker_id] ?? GLOBAL_MULTIPLIER;
}

interface B2Ticker {
  ticker_id: string;
  base_currency: string;
  quote_currency: string;
  last_price: number | null;
  base_volume: number | null;
  USD_volume: number | null;
  quote_volume: number | null;
  bid: number | null;
  ask: number | null;
  high: number | null;
  low: number | null;
  product_type: "Perpetual" | "Futures" | "Options";
  open_interest: number | null;
  open_interest_usd: number | null;
  index_price: number | null;
  creation_timestamp: number | null;
  expiry_timestamp: number | null;
  funding_rate: number | null;
  next_funding_rate: number | null;
  next_funding_rate_timestamp: number | null;
  maker_fee: number | null;
  taker_fee: number | null;
  price_change_24h: number | null;
  _provider: string;
  _updated_at: number;
}

function sf(v: any): number | null {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function si(v: any): number | null {
  if (v == null || v === "") return null;
  const n = parseInt(v);
  return isNaN(n) ? null : n;
}

function applyMultiplier(t: B2Ticker): B2Ticker {
  const m = getMultiplier(t.ticker_id);
  if (m === 1) return t;
  return {
    ...t,
    base_volume:  t.base_volume  != null ? t.base_volume  * m : null,
    USD_volume:   t.USD_volume   != null ? t.USD_volume   * m : null,
    quote_volume: t.quote_volume != null ? t.quote_volume * m : null,
  };
}

// ── STORE ─────────────────────────────────────────────────
const store = new Map<string, B2Ticker>();

SYMBOLS.forEach((cfg) => {
  store.set(cfg.ticker_id, {
    ticker_id:                   cfg.ticker_id,
    base_currency:               cfg.base,
    quote_currency:              cfg.quote,
    last_price:                  null,
    base_volume:                 null,
    USD_volume:                  null,
    quote_volume:                null,
    bid:                         null,
    ask:                         null,
    high:                        null,
    low:                         null,
    product_type:                "Perpetual",
    open_interest:               null,
    open_interest_usd:           null,
    index_price:                 null,
    creation_timestamp:          null,
    expiry_timestamp:            null,
    funding_rate:                null,
    next_funding_rate:           null,
    next_funding_rate_timestamp: null,
    maker_fee:                   cfg.maker_fee,
    taker_fee:                   cfg.taker_fee,
    price_change_24h:            null,
    _provider:                   "binance",
    _updated_at:                 Date.now(),
  });
});

// ── FUNDING RATE — REST se fetch (har 30s) ────────────────
const FUNDING_URL = "https://fapi.binance.com/fapi/v1/premiumIndex";

async function fetchFundingRates() {
  for (const cfg of SYMBOLS) {
    try {
      // Premium index — funding rate + index price
      const premRes = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${cfg.symbol}`);
      const prem: any = premRes.ok ? await premRes.json() : {};

      // Open Interest
      const oiRes = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${cfg.symbol}`);
      const oi: any = oiRes.ok ? await oiRes.json() : {};

      const existing = store.get(cfg.ticker_id);
      if (!existing) continue;

      // OI in USD = OI contracts * last price
      const oiContracts = sf(oi.openInterest);
      const lastPrice = existing.last_price;
      const oiUsd = oiContracts != null && lastPrice != null ? oiContracts * lastPrice : null;

      const updated: B2Ticker = {
        ...existing,
        index_price:                 sf(prem.indexPrice),
        funding_rate:                sf(prem.lastFundingRate),
        next_funding_rate:           sf(prem.lastFundingRate),
        next_funding_rate_timestamp: si(prem.nextFundingTime),
        open_interest:               oiContracts,
        open_interest_usd:           oiUsd,
        _updated_at:                 Date.now(),
      };

      store.set(cfg.ticker_id, updated);
      broadcast(updated);
      console.log(`[Funding] ${cfg.symbol} — OI: ${oi.openInterest}, index: ${prem.indexPrice}`);
    } catch (e) {
      console.error(`[Funding] ${cfg.symbol} error:`, e);
    }
  }
}
// ── BINANCE WS ────────────────────────────────────────────
const BINANCE_STREAMS = SYMBOLS.map((s) => `${s.symbol.toLowerCase()}@ticker`).join("/");
const BINANCE_WS_URL = `wss://stream.binance.com:9443/stream?streams=${BINANCE_STREAMS}`;

const SYMBOL_MAP = new Map(SYMBOLS.map((s) => [s.symbol, s]));

let binanceWs: WebSocket | null = null;
let binanceReconnect: ReturnType<typeof setTimeout> | null = null;
let binancePing: ReturnType<typeof setInterval> | null = null;
let fundingTimer: ReturnType<typeof setInterval> | null = null;
let binanceStatus: "connecting" | "connected" | "disconnected" = "disconnected";

function connectBinance() {
  binanceStatus = "connecting";
  console.log("[Binance] Connecting to:", BINANCE_WS_URL);

  binanceWs = new WebSocket(BINANCE_WS_URL);

  binanceWs.on("open", () => {
    binanceStatus = "connected";
    console.log("[Binance] Connected ✓");

    // Ping every 20s
    binancePing = setInterval(() => {
      if (binanceWs?.readyState === WebSocket.OPEN) binanceWs.ping();
    }, 20000);

    // Fetch funding rates immediately then every 30s
    fetchFundingRates();
    fundingTimer = setInterval(fetchFundingRates, 30000);
  });

  binanceWs.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      const stream: string = msg.stream ?? "";
      const data = msg.data;
      if (!stream || !data) return;

      const symbolKey = stream.split("@")[0].toUpperCase();
      const cfg = SYMBOL_MAP.get(symbolKey);
      if (!cfg) return;

      const existing = store.get(cfg.ticker_id)!;

      if (stream.includes("@ticker")) {
        const updated: B2Ticker = {
          ...existing,
          last_price:       sf(data.c),
          base_volume:      sf(data.v),
          USD_volume:       sf(data.q),
          quote_volume:     sf(data.q),
          bid:              sf(data.b),
          ask:              sf(data.a),
          high:             sf(data.h),
          low:              sf(data.l),
          price_change_24h: sf(data.P), // direct percent from Binance
          _updated_at:      Date.now(),
        };

        store.set(cfg.ticker_id, updated);
        broadcast(updated);
      }
    } catch (e) {
      console.error("[Binance] Parse error:", e);
    }
  });

  binanceWs.on("error", (err) => {
    console.error("[Binance] Error:", err.message);
  });

  binanceWs.on("close", (code) => {
    binanceStatus = "disconnected";
    binanceWs = null;
    if (binancePing) clearInterval(binancePing);
    if (fundingTimer) clearInterval(fundingTimer);
    console.log(`[Binance] Closed (${code}) — reconnecting in 3s`);
    binanceReconnect = setTimeout(connectBinance, 3000);
  });
}

// ── WS SERVER ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[WSS] Client connected — total: ${clients.size}`);

  const snapshot = Array.from(store.values()).map(applyMultiplier);
  ws.send(JSON.stringify({ type: "snapshot", data: snapshot, timestamp: Date.now() }));

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[WSS] Client disconnected — total: ${clients.size}`);
  });

  ws.on("error", (err) => {
    console.error("[WSS] Client error:", err.message);
    clients.delete(ws);
  });
});

function broadcast(ticker: B2Ticker) {
  if (clients.size === 0) return;
  const msg = JSON.stringify({ type: "update", data: [applyMultiplier(ticker)], timestamp: Date.now() });
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ── REST ──────────────────────────────────────────────────
app.get("/api/tickers", (_req, res) => {
  const data = Array.from(store.values()).map(applyMultiplier);
  res.json({ success: true, count: data.length, data, timestamp: Date.now() });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", binance: binanceStatus, clients: clients.size, symbols: store.size, timestamp: Date.now() });
});

// ── START ─────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║  DerivData Node Server               ║
║  WS   → ws://localhost:${PORT}/ws      ║
║  REST → http://localhost:${PORT}/api   ║
║  Multiplier: ${GLOBAL_MULTIPLIER}x                    ║
╚══════════════════════════════════════╝
  `);
  connectBinance();
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  if (binanceReconnect) clearTimeout(binanceReconnect);
  if (binancePing) clearInterval(binancePing);
  if (fundingTimer) clearInterval(fundingTimer);
  binanceWs?.terminate();
  server.close();
  process.exit(0);
});