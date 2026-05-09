import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const PORT = process.env.PORT ?? 3001;

// ── SUPABASE ───────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    realtime: {
      transport: WebSocket as any,
    },
  }
);
// ── TYPES ─────────────────────────────────────────────────
interface SymbolConfig {
  symbol: string;
  base: string;
  quote: string;
  ticker_id: string;
  maker_fee: number;
  taker_fee: number;
  volume_multiplier: number;
  is_active: boolean;
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

// ── STATE ─────────────────────────────────────────────────
let GLOBAL_MULTIPLIER = 1;
let SYMBOLS: SymbolConfig[] = [];
const store = new Map<string, B2Ticker>();
const orderBookStore = new Map<string, { bids: [number, number][]; asks: [number, number][]; timestamp: number }>();
const wsConnections = new Map<string, { ws: WebSocket; retry: number }>();

// ── HELPERS ───────────────────────────────────────────────
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

// function getMultiplier(ticker_id: string): number {
//   const sym = SYMBOLS.find((s) => s.ticker_id === ticker_id);
//   const perSym = sym?.volume_multiplier ?? 1;
//   return perSym * GLOBAL_MULTIPLIER;
// }

function getMultiplier(ticker_id: string): number {
  return GLOBAL_MULTIPLIER;
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

function logDivider() {
  console.log("─".repeat(50));
}

// ── SUPABASE: LOAD CONFIG ─────────────────────────────────
async function loadGlobalMultiplier() {
  const { data, error } = await supabase
    .from("config")
    .select("value")
    .eq("key", "global_volume_multiplier")
    .single();

  if (error) {
    console.error("[Config] ❌ Failed to load global_volume_multiplier:", error.message);
    return;
  }

  const val = parseFloat(data.value);
  if (!isNaN(val)) {
    GLOBAL_MULTIPLIER = val;
    logDivider();
    console.log("[Config] ✅ global_volume_multiplier loaded from Supabase");
    console.log(`[Config]    Value: ${GLOBAL_MULTIPLIER}x`);
    logDivider();
  } else {
    console.warn("[Config] ⚠️  global_volume_multiplier value is not a valid number:", data.value);
  }
}

async function loadSymbols() {
  const { data, error } = await supabase
    .from("symbols")
    .select("symbol, base, quote, ticker_id, maker_fee, taker_fee, volume_multiplier, is_active")
    .eq("is_active", true);

  if (error) {
    console.error("[Symbols] ❌ Failed to load symbols:", error.message);
    return;
  }

  const prev = SYMBOLS.map((s) => s.ticker_id).join(", ") || "none";

  SYMBOLS = (data ?? []).map((row: any) => ({
    symbol: row.symbol.toLowerCase(),
    base: row.base,
    quote: row.quote,
    ticker_id: row.ticker_id,
    maker_fee: parseFloat(row.maker_fee),
    taker_fee: parseFloat(row.taker_fee),
    volume_multiplier: parseFloat(row.volume_multiplier ?? "1"),
    is_active: row.is_active,
  }));

  logDivider();
  console.log("[Symbols] ✅ Active symbols loaded from Supabase:");
  SYMBOLS.forEach((s) => {
    console.log(`[Symbols]    ${s.ticker_id} | sym_multiplier: ${s.volume_multiplier}x | maker: ${s.maker_fee} | taker: ${s.taker_fee}`);
  });
  console.log(`[Symbols]    Previously: ${prev}`);
  console.log(`[Symbols]    Now:        ${SYMBOLS.map((s) => s.ticker_id).join(", ")}`);
  logDivider();

  // Initialize store for new symbols
  SYMBOLS.forEach((cfg) => {
    if (!store.has(cfg.ticker_id)) {
      store.set(cfg.ticker_id, {
        ticker_id: cfg.ticker_id,
        base_currency: cfg.base,
        quote_currency: cfg.quote,
        last_price: null, base_volume: null, USD_volume: null, quote_volume: null,
        bid: null, ask: null, high: null, low: null,
        product_type: "Perpetual",
        open_interest: null, open_interest_usd: null, index_price: null,
        creation_timestamp: null, expiry_timestamp: null,
        funding_rate: null, next_funding_rate: null, next_funding_rate_timestamp: null,
        maker_fee: cfg.maker_fee, taker_fee: cfg.taker_fee,
        price_change_24h: null,
        _provider: "binance_futures",
        _updated_at: Date.now(),
      });
    }
  });
}

// ── SUPABASE: REALTIME ────────────────────────────────────
function subscribeRealtime() {
  // 1. Global multiplier change
  supabase
    .channel("config-changes")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "config", filter: "key=eq.global_volume_multiplier" },
      (payload) => {
        const oldVal = GLOBAL_MULTIPLIER;
        const newVal = parseFloat((payload.new as any).value);
        if (!isNaN(newVal)) {
          GLOBAL_MULTIPLIER = newVal;
          logDivider();
          console.log("[Config] 🔄 REALTIME: global_volume_multiplier changed!");
          console.log(`[Config]    Old value: ${oldVal}x`);
          console.log(`[Config]    New value: ${GLOBAL_MULTIPLIER}x`);
          console.log(`[Config]    Broadcasting to ${clients.size} client(s)...`);
          logDivider();
          broadcastAllTickers();
          SYMBOLS.forEach((s) => broadcastB2(s.ticker_id));
        } else {
          console.warn("[Config] ⚠️  REALTIME: received invalid multiplier value:", (payload.new as any).value);
        }
      }
    )
    .subscribe((status) => {
      console.log(`[Config] Supabase Realtime channel status: ${status}`);
    });

  // 2. Symbol changes
  supabase
    .channel("symbols-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "symbols" },
      async (payload) => {
        const changedRow = payload.new as any;
        logDivider();
        console.log(`[Symbols] 🔄 REALTIME: symbols table changed!`);
        console.log(`[Symbols]    Event type: ${payload.eventType}`);
        if (changedRow?.ticker_id) {
          console.log(`[Symbols]    Affected:   ${changedRow.ticker_id}`);
          if (payload.eventType === "UPDATE") {
            const oldRow = payload.old as any;
            if (oldRow?.volume_multiplier !== changedRow?.volume_multiplier) {
              console.log(`[Symbols]    volume_multiplier: ${oldRow?.volume_multiplier}x → ${changedRow?.volume_multiplier}x`);
            }
            if (oldRow?.is_active !== changedRow?.is_active) {
              console.log(`[Symbols]    is_active: ${oldRow?.is_active} → ${changedRow?.is_active}`);
            }
            if (oldRow?.maker_fee !== changedRow?.maker_fee) {
              console.log(`[Symbols]    maker_fee: ${oldRow?.maker_fee} → ${changedRow?.maker_fee}`);
            }
            if (oldRow?.taker_fee !== changedRow?.taker_fee) {
              console.log(`[Symbols]    taker_fee: ${oldRow?.taker_fee} → ${changedRow?.taker_fee}`);
            }
          }
        }
        console.log(`[Symbols]    Reloading all active symbols...`);
        logDivider();

        await loadSymbols();

        // Naye symbols ke liye Binance WS connect karo
        SYMBOLS.forEach((cfg) => {
          if (!wsConnections.has(`ticker_${cfg.symbol}`)) {
            console.log(`[Symbols] 🆕 New symbol detected — connecting Binance WS: ${cfg.ticker_id}`);
            connectSymbol(cfg);
          }
        });

        console.log(`[Symbols] Broadcasting updated data to ${clients.size} client(s)...`);
        broadcastAllTickers();
        SYMBOLS.forEach((s) => broadcastB2(s.ticker_id));
      }
    )
    .subscribe((status) => {
      console.log(`[Symbols] Supabase Realtime channel status: ${status}`);
    });
}

// ── FUNDING + OI — REST har 30s ───────────────────────────
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

// ── BINANCE FUTURES WS ────────────────────────────────────
function connectSymbol(cfg: SymbolConfig) {
  const sym = cfg.symbol;
  const tickerId = cfg.ticker_id;

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
    broadcastB2(tickerId); // ← ye add karo
  });

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

const depthUrl = `wss://fstream.binance.com/public/ws/${sym}@depth20@100ms`;

// // 50 levels (requirement ke hisab se)
// const depthUrl = `wss://fstream.binance.com/public/ws/${sym}@depth@100ms`;



connectWS(`depth_${sym}`, depthUrl, (data) => {
  // data.b = bids [[price, qty], ...], data.a = asks
  const bids: [number, number][] = (data.b ?? [])
    .slice(0, 50)
    .map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]);
  const asks: [number, number][] = (data.a ?? [])
    .slice(0, 50)
    .map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]);
  
  orderBookStore.set(tickerId, {
    bids,
    asks,
    timestamp: Date.now(),
  });
  broadcastB3(tickerId);
});


}

function connectWS(name: string, url: string, onMessage: (data: any) => void) {
  console.log(`[WS] ${name} connecting: ${url}`);
  const ws = new WebSocket(url);
  const state = { ws, retry: wsConnections.get(name)?.retry ?? 0 };
  wsConnections.set(name, state);

  ws.on("open", () => { state.retry = 0; console.log(`[WS] ${name} connected ✓`); });
  ws.on("message", (raw: Buffer) => {
    try { onMessage(JSON.parse(raw.toString())); }
    catch (e) { console.error(`[WS] ${name} parse error:`, e); }
  });
  ws.on("error", (err) => { console.error(`[WS] ${name} error:`, err.message); });
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

const wss  = new WebSocketServer({ noServer: true });
const wss2 = new WebSocketServer({ noServer: true });
const wss3 = new WebSocketServer({ noServer: true });



const clients  = new Set<WebSocket>();
const clients2 = new Set<WebSocket>();
const clients3 = new Set<WebSocket>();
wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[B1] Client connected — total: ${clients.size}`);
  const snapshot = Array.from(store.values()).map(applyMultiplier);
  ws.send(JSON.stringify({ type: "snapshot", data: snapshot, timestamp: Date.now() }));
  ws.on("close", () => { clients.delete(ws); console.log(`[B1] Client disconnected — total: ${clients.size}`); });
  ws.on("error", (err) => { console.error("[B1] error:", err.message); clients.delete(ws); });
});

wss2.on("connection", (ws) => {
  clients2.add(ws);
  console.log(`[B2] Client connected — total: ${clients2.size}`);
  const snapshot = SYMBOLS.map((s) => ({
    ticker_id: s.ticker_id,
    contract_type: "Vanilla",
    contract_price: store.get(s.ticker_id)?.last_price ?? null,
    contract_price_currency: s.quote,
  }));
  ws.send(JSON.stringify({ type: "snapshot", data: snapshot, timestamp: Date.now() }));
  ws.on("close", () => { clients2.delete(ws); console.log(`[B2] Client disconnected — total: ${clients2.size}`); });
  ws.on("error", (err) => { console.error("[B2] error:", err.message); clients2.delete(ws); });
});

wss3.on("connection", (ws) => {
  clients3.add(ws);
  console.log(`[B3] Client connected — total: ${clients3.size}`);
  // Snapshot — saare symbols ka current order book
  const snapshot = SYMBOLS.map((s) => {
    const ob = orderBookStore.get(s.ticker_id);
    return {
      ticker_id: s.ticker_id,
      timestamp: ob?.timestamp ?? Date.now(),
      bids: ob?.bids ?? [],
      asks: ob?.asks ?? [],
    };
  });
  ws.send(JSON.stringify({ type: "snapshot", data: snapshot, timestamp: Date.now() }));
  ws.on("close", () => { clients3.delete(ws); console.log(`[B3] Client disconnected — total: ${clients3.size}`); });
  ws.on("error", (err) => { console.error("[B3] error:", err.message); clients3.delete(ws); });
});
// Manually upgrade handle karo
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;

  if (pathname === "/b1") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else if (pathname === "/b2") {
    wss2.handleUpgrade(request, socket, head, (ws) => {
      wss2.emit("connection", ws, request);
    });
  } else if (pathname === "/b3") {
  wss3.handleUpgrade(request, socket, head, (ws) => {
    wss3.emit("connection", ws, request);
  });
} else {
    socket.destroy();
  }
});


function broadcast(ticker: B2Ticker) {
  if (clients.size === 0) return;
  const msg = JSON.stringify({ type: "update", data: [applyMultiplier(ticker)], timestamp: Date.now() });
  clients.forEach((ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function broadcastAllTickers() {
  if (clients.size === 0) return;
  store.forEach((ticker) => broadcast(ticker));
}
function broadcastB2(ticker_id: string) {
  if (clients2.size === 0) return;
  const sym = SYMBOLS.find((s) => s.ticker_id === ticker_id);
  if (!sym) return;
  const msg = JSON.stringify({
    type: "update",
    data: [{
      ticker_id: sym.ticker_id,
      contract_type: "Vanilla",
      contract_price: store.get(ticker_id)?.last_price ?? null,
      contract_price_currency: sym.quote,
    }],
    timestamp: Date.now(),
  });
  clients2.forEach((ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}


function broadcastB3(ticker_id: string) {
  if (clients3.size === 0) return;
  const ob = orderBookStore.get(ticker_id);
  if (!ob) return;
  const msg = JSON.stringify({
    type: "update",
    data: [{
      ticker_id,
      timestamp: ob.timestamp,
      bids: ob.bids,
      asks: ob.asks,
    }],
    timestamp: Date.now(),
  });
  clients3.forEach((ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
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
  res.json({
    status: "ok",
    ws: wsStatus,
    clients: clients.size,
    global_multiplier: GLOBAL_MULTIPLIER,
    symbols: SYMBOLS.map((s) => ({ ticker_id: s.ticker_id, volume_multiplier: s.volume_multiplier })),
    timestamp: Date.now(),
  });
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
      <div class="stat"><span>Active Symbols</span><p class="blue">${data.length}</p></div>
      <div class="stat"><span>Global Multiplier</span><p class="green">${GLOBAL_MULTIPLIER}x</p></div>
      <div class="stat"><span>Supabase Realtime</span><p class="green">● Active</p></div>
      <div class="stat"><span>Time</span><p style="font-size:11px">${new Date().toUTCString()}</p></div>
    </div>
  </div>
  <div class="box">
    <h2>Endpoints</h2>
    <div class="row">
      <div class="stat"><span>WebSocket</span><p>wss://your-domain/b1</p></div>
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
          <th>Index Price</th><th>Funding Rate</th><th>Next Funding</th><th>Sym Mul</th>
        </tr>
      </thead>
      <tbody>
        ${data.map((t) => {
          const chg = t.price_change_24h ?? 0;
          const fr = t.funding_rate ?? 0;
          const symCfg = SYMBOLS.find(s => s.ticker_id === t.ticker_id);
          return `<tr>
            <td><strong>${t.ticker_id}</strong><br><span class="gray" style="font-size:10px">${t.base_currency}/${t.quote_currency}</span></td>
            <td><strong>$${t.last_price?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) ?? "—"}</strong></td>
            <td class="${chg >= 0 ? "green" : "red"}">${t.price_change_24h != null ? (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%" : "—"}</td>
            <td>${t.USD_volume != null ? "$" + (t.USD_volume / 1e9).toFixed(2) + "B" : "—"}</td>
            <td>${t.open_interest_usd != null ? "$" + (t.open_interest_usd / 1e9).toFixed(2) + "B" : "—"}</td>
            <td>${t.index_price != null ? "$" + t.index_price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : "—"}</td>
            <td class="${fr >= 0 ? "green" : "red"}">${t.funding_rate != null ? (fr * 100).toFixed(4) + "%" : "—"}</td>
            <td>${t.next_funding_rate_timestamp != null ? new Date(t.next_funding_rate_timestamp).toLocaleTimeString() : "—"}</td>
            <td class="blue">${symCfg ? symCfg.volume_multiplier + "x" : "—"}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  </div>
  <script>setTimeout(() => location.reload(), 5000);</script>
</body>
</html>`);
});
console.log("WS paths:", (server as any)._events);
// ── START ─────────────────────────────────────────────────
server.listen(PORT, async () => {
  logDivider();
  console.log("[Server] 🚀 DerivData Node Server starting...");
  console.log(`[Server]    Port: ${PORT}`);
  console.log(`[Server]    Supabase URL: ${process.env.SUPABASE_URL}`);
  logDivider();

  // 1. Supabase se config load karo
  await loadGlobalMultiplier();

  // 2. Symbols load karo
  await loadSymbols();

  // 3. Realtime subscribe karo
  subscribeRealtime();

  // 4. Binance WS connect karo
  SYMBOLS.forEach(connectSymbol);

  // 5. Funding + OI fetch karo
  fetchFundingRates();
  setInterval(fetchFundingRates, 30000);

  logDivider();
  console.log("[Server] ✅ All systems started!");
  console.log(`[Server]    WS  → ws://localhost:${PORT}/b1`);
  console.log(`[Server]    REST → http://localhost:${PORT}/api`);
  console.log(`[Server]    Global Multiplier: ${GLOBAL_MULTIPLIER}x`);
  console.log(`[Server]    Active Symbols: ${SYMBOLS.map(s => s.ticker_id).join(", ")}`);
  logDivider();
});

process.on("SIGINT", () => {
  console.log("\n[Server] Shutting down...");
  wsConnections.forEach(({ ws }) => ws.terminate());
  server.close();
  process.exit(0);
});