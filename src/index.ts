import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT ?? 3001;

const SYMBOLS = [
  { symbol: "btcusdt", base: "BTC", quote: "USDT", ticker_id: "BTC-PERPUSDT", maker_fee: -0.0001, taker_fee: 0.0006 },
  { symbol: "ethusdt", base: "ETH", quote: "USDT", ticker_id: "ETH-PERPUSDT", maker_fee: -0.0001, taker_fee: 0.0006 },
  { symbol: "xrpusdt", base: "XRP", quote: "USDT", ticker_id: "XRP-PERPUSDT", maker_fee: -0.0001, taker_fee: 0.0006 },
];

const GLOBAL_MULTIPLIER = parseFloat(process.env.VOLUME_MULTIPLIER ?? "1");
const PER_SYMBOL_MULTIPLIER: Record<string, number> = {};

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
    ticker_id: cfg.ticker_id, base_currency: cfg.base, quote_currency: cfg.quote,
    last_price: null, base_volume: null, USD_volume: null, quote_volume: null,
    bid: null, ask: null, high: null, low: null, product_type: "Perpetual",
    open_interest: null, open_interest_usd: null, index_price: null,
    creation_timestamp: null, expiry_timestamp: null,
    funding_rate: null, next_funding_rate: null, next_funding_rate_timestamp: null,
    maker_fee: cfg.maker_fee, taker_fee: cfg.taker_fee, price_change_24h: null,
    _provider: "binance_futures", _updated_at: Date.now(),
  });
});

// ── FUNDING + OI — REST se har 30s ────────────────────────
async function fetchFundingRates() {
  for (const cfg of SYMBOLS) {
    try {
      const premRes = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${cfg.symbol.toUpperCase()}`);
      const prem: any = premRes.ok ? await premRes.json() : {};
      const oiRes = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${cfg.symbol.toUpperCase()}`);
      const oi: any = oiRes.ok ? await oiRes.json() : {};
      const existing = store.get(cfg.ticker_id);
      if (!existing) continue;
      const oiContracts = sf(oi.openInterest);
      const oiUsd = oiContracts != null && existing.last_price != null ? oiContracts * existing.last_price : null;
      const updated: B2Ticker = {
        ...existing,
        index_price: sf(prem.indexPrice),
        funding_rate: sf(prem.lastFundingRate),
        next_funding_rate: sf(prem.lastFundingRate),
        next_funding_rate_timestamp: si(prem.nextFundingTime),
        open_interest: oiContracts,
        open_interest_usd: oiUsd,
        _updated_at: Date.now(),
      };
      store.set(cfg.ticker_id, updated);
      broadcast(updated);
      console.log(`[Funding] ${cfg.symbol.toUpperCase()} — OI: ${oi.openInterest}, index: ${prem.indexPrice}`);
    } catch (e) {
      console.error(`[Funding] ${cfg.symbol} error:`, e);
    }
  }
}

// ── BINANCE FUTURES WS — per symbol ───────────────────────
// Using routed paths that work: /market/ws and /public/ws
function connectSymbol(cfg: typeof SYMBOLS[0]) {
  const sym = cfg.symbol;
  const tickerId = cfg.ticker_id;

  // Ticker stream — price, volume, high, low, change
  const tickerUrl = `wss://fstream.binance.com/market/ws/${sym}@ticker`;
  connectWS(`ticker_${sym}`, tickerUrl, (data) => {
    const existing = store.get(tickerId)!;
    const updated: B2Ticker = {
      ...existing,
      last_price:       sf(data.c),
      base_volume:      sf(data.v),
      USD_volume:       sf(data.q),
      quote_volume:     sf(data.q),
      high:             sf(data.h),
      low:              sf(data.l),
      price_change_24h: sf(data.P),
      _updated_at:      Date.now(),
    };
    store.set(tickerId, updated);
    broadcast(updated);
  });

  // BookTicker stream — bid, ask realtime
  const bookUrl = `wss://fstream.binance.com/public/ws/${sym}@bookTicker`;
  connectWS(`book_${sym}`, bookUrl, (data) => {
    const existing = store.get(tickerId)!;
    const updated: B2Ticker = {
      ...existing,
      bid: sf(data.b),
      ask: sf(data.a),
      _updated_at: Date.now(),
    };
    store.set(tickerId, updated);
    broadcast(updated);
  });
}

// Generic WS connector with auto-reconnect
const wsConnections = new Map<string, { ws: WebSocket; retry: number }>();

function connectWS(name: string, url: string, onMessage: (data: any) => void) {
  console.log(`[WS] ${name} connecting: ${url}`);
  const ws = new WebSocket(url);
  const state = { ws, retry: wsConnections.get(name)?.retry ?? 0 };
  wsConnections.set(name, state);

  ws.on("open", () => {
    state.retry = 0;
    console.log(`[WS] ${name} connected ✓`);
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const data = JSON.parse(raw.toString());
      onMessage(data);
    } catch (e) {
      console.error(`[WS] ${name} parse error:`, e);
    }
  });

  ws.on("error", (err) => {
    console.error(`[WS] ${name} error:`, err.message);
  });

  ws.on("close", (code) => {
    const delay = Math.min(30000, 1000 * Math.pow(2, state.retry++));
    console.log(`[WS] ${name} closed (${code}) — reconnecting in ${delay}ms`);
    setTimeout(() => connectWS(name, url, onMessage), delay);
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
  ws.on("close", () => { clients.delete(ws); console.log(`[WSS] Client disconnected — total: ${clients.size}`); });
  ws.on("error", (err) => { console.error("[WSS] error:", err.message); clients.delete(ws); });
});

function broadcast(ticker: B2Ticker) {
  if (clients.size === 0) return;
  const msg = JSON.stringify({ type: "update", data: [applyMultiplier(ticker)], timestamp: Date.now() });
  clients.forEach((ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ── REST ──────────────────────────────────────────────────
app.get("/api/tickers", (_req, res) => {
  const data = Array.from(store.values()).map(applyMultiplier);
  res.json({ success: true, count: data.length, data, timestamp: Date.now() });
});

app.get("/api/health", (_req, res) => {
  const wsStatus: Record<string, string> = {};
  wsConnections.forEach((s, name) => {
    wsStatus[name] = s.ws.readyState === WebSocket.OPEN ? "open" : "closed";
  });
  res.json({ status: "ok", ws: wsStatus, clients: clients.size, symbols: store.size, timestamp: Date.now() });
});

app.get("/", (_req, res) => {
  const data = Array.from(store.values()).map(applyMultiplier);
  const wsOpen = Array.from(wsConnections.values()).filter(s => s.ws.readyState === WebSocket.OPEN).length;
  const wsTotal = wsConnections.size;
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>DerivData WS Server</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:monospace;background:#0a0d12;color:#e2e8f0;padding:40px}
    h1{color:#3b82f6;margin-bottom:24px;font-size:22px}
    .green{color:#22c55e}.red{color:#ef4444}.gray{color:#64748b}.blue{color:#3b82f6}
    .box{background:#111827;border:1px solid #1f2937;border-radius:10px;padding:20px;margin-bottom:20px}
    .box h2{font-size:11px;color:#64748b;margin-bottom:16px;text-transform:uppercase;letter-spacing:1px}
    .row{display:flex;gap:32px;flex-wrap:wrap}
    .stat{min-width:120px}
    .stat span{color:#64748b;font-size:11px;display:block;margin-bottom:4px}
    .stat p{font-size:15px;font-weight:bold}
    a{color:#3b82f6;text-decoration:none}
    table{width:100%;border-collapse:collapse}
    th{text-align:right;color:#475569;font-size:10px;padding:10px 12px;border-bottom:1px solid #1f2937;text-transform:uppercase}
    th:first-child{text-align:left}
    td{padding:12px;border-bottom:1px solid #0f172a;font-size:12px;text-align:right}
    td:first-child{text-align:left}
    tr:hover td{background:#0d1117}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
    .dot-green{background:#22c55e;animation:pulse 1.5s infinite}
    .dot-red{background:#ef4444}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  </style>
</head>
<body>
  <h1>⚡ DerivData WebSocket Server</h1>
  <div class="box">
    <h2>Server Status</h2>
    <div class="row">
      <div class="stat">
        <span>Binance Futures WS</span>
        <p><span class="dot ${wsOpen === wsTotal && wsTotal > 0 ? "dot-green" : "dot-red"}"></span>
        <span class="${wsOpen === wsTotal && wsTotal > 0 ? "green" : "red"}">${wsOpen}/${wsTotal} open</span></p>
      </div>
      <div class="stat"><span>WS Clients</span><p class="blue">${clients.size}</p></div>
      <div class="stat"><span>Symbols</span><p class="blue">${data.length}</p></div>
      <div class="stat"><span>Multiplier</span><p class="green">${GLOBAL_MULTIPLIER}x</p></div>
      <div class="stat"><span>Time</span><p style="font-size:11px">${new Date().toUTCString()}</p></div>
    </div>
  </div>
  <div class="box">
    <h2>Endpoints</h2>
    <div class="row">
      <div class="stat"><span>WebSocket</span><p>wss://your-domain/ws</p></div>
      <div class="stat"><span>REST Tickers</span><p><a href="/api/tickers">/api/tickers</a></p></div>
      <div class="stat"><span>Health</span><p><a href="/api/health">/api/health</a></p></div>
    </div>
  </div>
  <div class="box">
    <h2>Live Futures Data</h2>
    <table>
      <thead>
        <tr>
          <th>Ticker</th><th>Last Price</th><th>24h Change</th>
          <th>Volume (USD)</th><th>Open Interest</th>
          <th>Index Price</th><th>Funding Rate</th><th>Next Funding</th>
        </tr>
      </thead>
      <tbody>
        ${data.map((t) => {
          const chg = t.price_change_24h ?? 0;
          const fr = t.funding_rate ?? 0;
          return `<tr>
            <td><strong>${t.ticker_id}</strong><br><span class="gray" style="font-size:10px">${t.base_currency}/${t.quote_currency}</span></td>
            <td><strong>$${t.last_price?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) ?? "—"}</strong></td>
            <td class="${chg >= 0 ? "green" : "red"}">${t.price_change_24h != null ? (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%" : "—"}</td>
            <td>${t.USD_volume != null ? "$" + (t.USD_volume / 1e9).toFixed(2) + "B" : "—"}</td>
            <td>${t.open_interest_usd != null ? "$" + (t.open_interest_usd / 1e9).toFixed(2) + "B" : "—"}</td>
            <td>${t.index_price != null ? "$" + t.index_price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : "—"}</td>
            <td class="${fr >= 0 ? "green" : "red"}">${t.funding_rate != null ? (fr * 100).toFixed(4) + "%" : "—"}</td>
            <td>${t.next_funding_rate_timestamp != null ? new Date(t.next_funding_rate_timestamp).toLocaleTimeString() : "—"}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  </div>
  <script>setTimeout(() => location.reload(), 5000);</script>
</body>
</html>`);
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

  // Connect all symbols
  SYMBOLS.forEach(connectSymbol);

  // Funding + OI REST every 30s
  fetchFundingRates();
  setInterval(fetchFundingRates, 30000);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  wsConnections.forEach(({ ws }) => ws.terminate());
  server.close();
  process.exit(0);
});