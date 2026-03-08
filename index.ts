// ============================================================================
// STRAT2: 5-Minute Market Momentum Buy Strategy
// Monitors multiple assets (BTC, ETH, SOL, XRP) on Polymarket 5-minute markets.
// Buys winning YES tokens at $0.99 when WS price hits $0.98, holds until
// resolution, claims winnings via Builder Relayer (gasless).
// Supports concurrent positions with configurable MAX_CONCURRENT_POSITIONS.
// Uses Binance REST API for epoch-start prices and Polymarket RTDS
// Chainlink WebSocket for real-time current prices.
// Price difference = |current_chainlink_price - binance_epoch_start_price|
// ============================================================================

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import * as dotenv from "dotenv";
import { Side } from "@polymarket/clob-client";
import { OrderType } from "@polymarket/clob-client";
import { AssetType } from "@polymarket/clob-client";
import WebSocket from "ws";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

// ============================================================================
// FILE LOGGING: Dual output to console AND log file
// Every log/warn/error is appended to logs/strat2_YYYY-MM-DD.log
// ============================================================================
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFilePath(): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `strat2_${dateStr}.log`);
}

function formatLogTimestamp(): string {
  return new Date().toISOString();
}

function writeToLogFile(level: string, args: any[]): void {
  const timestamp = formatLogTimestamp();
  const message = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ");
  const line = `[${timestamp}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(getLogFilePath(), line);
  } catch {
    // Silently fail if log write fails - do not break the bot
  }
}

// Override console methods to also write to file
const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

console.log = (...args: any[]) => {
  originalLog(...args);
  writeToLogFile("INFO", args);
};
console.warn = (...args: any[]) => {
  originalWarn(...args);
  writeToLogFile("WARN", args);
};
console.error = (...args: any[]) => {
  originalError(...args);
  writeToLogFile("ERROR", args);
};

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================
const CONFIG = {
  // -- Trading --
  BUY_TRIGGER_PRICE: 0.98, // WS bid price that triggers a buy opportunity
  BUY_LIMIT_PRICE: 0.99, // GTC limit price for the buy order
  BASE_SIZE: 5, // Number of shares per buy order
  STOP_LOSS_PRICE: 0.8, // If bid falls below this after buying, trigger stop-loss
  STOP_LOSS_DISCOUNT: 0.02, // Sell at 2% below current bid on stop-loss
  MAX_STOP_LOSS_ATTEMPTS: 30, // Max retries for stop-loss sell
  STOP_LOSS_FALLBACK_PRICE: 0.01, // GTC fallback after all aggressive attempts fail

  // -- Price difference filter (uses RTDS Chainlink WS prices) --
  PRICE_DIFFERENCE: 50, // $50 for BTC (default, per-asset overrides below)

  // -- Multi-asset config -- , "eth", "sol", "xrp"
  ASSETS: ["btc"] as const,
  ASSET_SLUG_PREFIX: {
    btc: "btc-updown-5m",
    eth: "eth-updown-5m",
    sol: "sol-updown-5m",
    xrp: "xrp-updown-5m",
  } as Record<string, string>,
  // Minimum absolute price move per asset (USD) to qualify as buy opportunity
  ASSET_PRICE_DIFF: {
    btc: 10,
    eth: 5,
    sol: 0.5,
    xrp: 0.005,
  } as Record<string, number>,
  // RTDS Chainlink symbol mapping (for current prices)
  ASSET_CHAINLINK_SYMBOL: {
    btc: "btc/usd",
    eth: "eth/usd",
    sol: "sol/usd",
    xrp: "xrp/usd",
  } as Record<string, string>,
  // Binance symbol mapping (for epoch-start prices)
  ASSET_BINANCE_SYMBOL: {
    btc: "BTCUSDT",
    eth: "ETHUSDT",
    sol: "SOLUSDT",
    xrp: "XRPUSDT",
  } as Record<string, string>,

  // -- Concurrent positions --
  MAX_CONCURRENT_POSITIONS: 1,
  INTERVAL_SECONDS: 300, // 5-minute markets

  // -- Polling intervals --
  MAIN_LOOP_TICK_MS: 5, // 25ms main loop tick
  ORDER_POLL_MS: 1000, // Poll order status every 1s
  RESOLUTION_POLL_MS: 5000, // Poll for market resolution every 5s
  REDEEM_RETRY_MS: 5000, // Retry redeem every 5s
  HOLDING_STATUS_LOG_MS: 10000, // Log HOLDING status summary every 10s

  // -- Claiming (Builder Relayer) --
  CTF_ADDRESS: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  USDC_ADDRESS: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  PARENT_COLLECTION_ID:
    "0x0000000000000000000000000000000000000000000000000000000000000000" as const,
  INDEX_SETS: [1, 2],
  RELAYER_URL: "https://relayer-v2.polymarket.com/",
  CHAIN_ID: 137,
};

// ============================================================================
// WebSocket URLs
// ============================================================================
const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const RTDS_WS_URL = "wss://ws-live-data.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

// ============================================================================
// Telegram config
// ============================================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ============================================================================
// TYPES
// ============================================================================

/** Per-position state machine states */
type PositionState =
  | "BUYING" // GTC buy order placed, waiting for fill
  | "HOLDING" // Buy filled, waiting for resolution or stop-loss
  | "STOP_LOSS" // Stop-loss triggered, selling aggressively
  | "AWAIT_RESOLUTION" // Waiting for market to resolve
  | "CLAIMING" // Market resolved, claiming winnings via relayer
  | "DONE"; // Fully closed, slot can be freed

/** Tracks one active position across its lifecycle */
interface ActivePosition {
  id: string; // Unique ID (e.g. "btc-1741276800-YES")
  asset: string; // "btc", "eth", "sol", "xrp"
  slug: string; // Full market slug
  conditionId: string; // Market condition ID
  yesTokenId: string; // YES token ID
  noTokenId: string; // NO token ID
  boughtTokenId: string; // Which token we bought
  boughtSide: "YES" | "NO"; // Which outcome we bought
  buyOrderId: string | null; // CLOB order ID
  buyPrice: number; // Limit price we set
  buySize: number; // Shares ordered
  filledSize: number; // Shares actually filled
  filledCost: number; // Actual USDC spent
  state: PositionState;
  stopLossAttempts: number;
  stopLossSellOrderId: string | null;
  lastOrderPollTime: number; // Throttle order status polls
  lastResolutionPollTime: number; // Throttle resolution polls
  lastRedeemAttemptTime: number; // Throttle redeem retries
  marketResolved: boolean;
  createdAt: number;
  epochTimestamp: number; // The epoch this position belongs to (unix seconds)
  lastHoldingLogTime: number; // Throttle periodic HOLDING status logs
  claimAttempts?: number; // Number of claim attempts made
  tickSize: string;
  negRisk: boolean;
}

/** Market info from Gamma API */
interface MarketInfo {
  slug: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  umaResolutionStatus: string; // "resolved", "proposed", "", etc.
  active: boolean;
  closed: boolean; // true when market is closed for trading
  tickSize: string;
  negRisk: boolean;
  description: string;
  endDate: string;
}

/** Price cache entry for CLOB market token prices */
interface PriceCache {
  [tokenId: string]: {
    bestBid: number;
    bestAsk: number;
    lastUpdate: number;
  };
}

/** Crypto price from RTDS Chainlink WebSocket */
interface CryptoPriceCache {
  [symbol: string]: {
    price: number;
    lastUpdate: number;
  };
}

/** Epoch-start snapshot of crypto prices */
interface EpochStartPrices {
  [asset: string]: {
    price: number;
    epoch: number;
  };
}

/** Trading metrics */
interface TradingMetrics {
  totalPnL: number;
  winCount: number;
  lossCount: number;
  cycleCount: number;
  totalBuys: number;
  totalStopLosses: number;
  totalClaimed: number;
}

/** Global bot context */
interface BotContext {
  client: ClobClient;
  // -- WebSocket connections --
  marketWs: WebSocket | null; // CLOB market WS for best_bid_ask
  cryptoWs: WebSocket | null; // RTDS Chainlink WS for crypto prices
  // -- Price caches --
  priceCache: PriceCache; // Token bid/ask from CLOB WS
  cryptoPriceCache: CryptoPriceCache; // Underlying asset prices from RTDS
  epochStartPrices: EpochStartPrices; // Snapshot at each epoch start
  // -- Positions --
  activePositions: ActivePosition[]; // Currently active positions
  processedConditionIds: Set<string>; // NEVER cleared - prevents reinvestment
  // -- Epoch tracking --
  currentEpoch: number; // Current 5-min epoch timestamp
  // -- Token subscriptions --
  subscribedTokenIds: Set<string>; // Tokens currently subscribed on CLOB WS
}

const metrics: TradingMetrics = {
  totalPnL: 0,
  winCount: 0,
  lossCount: 0,
  cycleCount: 0,
  totalBuys: 0,
  totalStopLosses: 0,
  totalClaimed: 0,
};

// ============================================================================
// HELPER: SLEEP
// ============================================================================
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// TELEGRAM NOTIFICATIONS
// ============================================================================
async function sendTelegramMessage(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("[TELEGRAM] Credentials not configured. Skipping message.");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
    });
    console.log("[TELEGRAM] Message sent.");
  } catch (error: any) {
    console.error(
      "[TELEGRAM] Failed:",
      error.response?.status,
      error.response?.data || error.message,
    );
  }
}

// ============================================================================
// USER POSITIONS (from data-api)
// ============================================================================
interface UserPosition {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  outcome: string;
  curPrice: number;
}

async function getUserPositions(conditionId?: string): Promise<UserPosition[]> {
  const userAddress = process.env.FUNDER_ADDRESS;
  if (!userAddress) {
    console.error("[GET_POSITIONS] FUNDER_ADDRESS not set");
    return [];
  }

  const url = new URL("https://data-api.polymarket.com/positions");
  url.searchParams.set("user", userAddress);
  url.searchParams.set("sizeThreshold", "1");
  url.searchParams.set("limit", "100");
  url.searchParams.set("sortBy", "TOKENS");
  url.searchParams.set("sortDirection", "DESC");
  if (conditionId) {
    url.searchParams.set("market", conditionId);
  }

  try {
    const response = await axios.get(url.toString());
    const positions = response.data;
    if (!Array.isArray(positions)) return [];
    return positions.map((p: any) => ({
      asset: p.asset,
      conditionId: p.conditionId,
      size: parseFloat(p.size) || 0,
      avgPrice: parseFloat(p.avgPrice) || 0,
      outcome: p.outcome,
      curPrice: parseFloat(p.curPrice) || 0,
    }));
  } catch (error: any) {
    console.error("[GET_POSITIONS] Error:", error.message || error);
    return [];
  }
}

// ============================================================================
// CLIENT INITIALIZATION
// ============================================================================
async function initializeClient(): Promise<ClobClient> {
  const HOST = "https://clob.polymarket.com";
  const CHAIN_ID = 137;
  const signer = new Wallet(process.env.PRIVATE_KEY!);

  const tempClient = new ClobClient(HOST, CHAIN_ID, signer);
  const userApiCreds = await tempClient.deriveApiKey();
  console.log("[INIT] API Key derived:", userApiCreds.key);

  const SIGNATURE_TYPE = 1; // POLY_PROXY
  const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;
  console.log("[INIT] Funder address:", FUNDER_ADDRESS);

  const client = new ClobClient(
    HOST,
    CHAIN_ID,
    signer,
    userApiCreds,
    SIGNATURE_TYPE,
    FUNDER_ADDRESS,
  );

  console.log("[INIT] Client initialized.");

  try {
    console.log("[INIT] Syncing allowances with CLOB server...");
    await client.updateBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
    });
    console.log("[INIT] Allowances synced.");
  } catch (error) {
    console.warn("[INIT] Warning: Could not sync allowances:", error);
  }

  return client;
}

// ============================================================================
// MARKET SLUG DERIVATION (5-minute intervals)
// ============================================================================
function getCurrentEpoch(): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / CONFIG.INTERVAL_SECONDS) * CONFIG.INTERVAL_SECONDS;
}

function deriveMarketSlug(asset: string, epoch: number): string {
  const prefix = CONFIG.ASSET_SLUG_PREFIX[asset];
  if (!prefix) throw new Error(`Unknown asset: ${asset}`);
  return `${prefix}-${epoch}`;
}

// ============================================================================
// GAMMA API: Fetch market info
// ============================================================================
async function fetchGammaMarket(slug: string): Promise<MarketInfo | null> {
  try {
    const response = await axios.get(
      `${GAMMA_API}/markets?slug=${slug}&active=true`,
    );
    const markets = response.data;
    if (markets && markets.length > 0) {
      const m = markets[0];
      let tokenIds: string[] = [];
      try {
        tokenIds = JSON.parse(m.clobTokenIds);
      } catch {
        console.error(`[GAMMA] Failed to parse clobTokenIds for ${slug}`);
        return null;
      }
      return {
        slug: m.slug,
        conditionId: m.conditionId,
        yesTokenId: tokenIds[0],
        noTokenId: tokenIds[1],
        umaResolutionStatus: m.umaResolutionStatus || "",
        active: m.active ?? true,
        closed: m.closed ?? false,
        tickSize:
          m.orderPriceMinTickSize?.toString() || m.minimum_tick_size || "0.01",
        negRisk: m.negRisk ?? m.neg_risk ?? false,
        description: m.description || "",
        endDate: m.endDate || "",
      };
    }
  } catch (error: any) {
    console.error(`[GAMMA] Error fetching ${slug}:`, error.message || error);
  }
  return null;
}

/** Check if a market is resolved via Gamma API.
 *  Uses umaResolutionStatus field (the actual resolution indicator from UMA oracle).
 *  Empty results = API issue or timing glitch, NOT resolved (markets do not get delisted).
 *  Only returns true when umaResolutionStatus is explicitly "resolved".
 */
async function checkMarketResolved(
  slug: string,
): Promise<{ resolved: boolean; reason: string }> {
  try {
    const response = await axios.get(`${GAMMA_API}/markets?slug=${slug}`);
    const markets = response.data;

    if (!markets || !Array.isArray(markets) || markets.length === 0) {
      // Market not found -- likely API issue or timing glitch, keep polling
      console.log(
        `[RESOLVE_CHECK] Empty/missing results for ${slug}, will retry (markets do not get delisted)`,
      );
      return {
        resolved: false,
        reason: "market not found in Gamma (will retry)",
      };
    }

    const m = markets[0];
    const umaStatus = (m.umaResolutionStatus || "").toLowerCase();
    const closed = m.closed ?? false;
    const active = m.active ?? true;
    const acceptingOrders = m.acceptingOrders ?? true;

    console.log(
      `[RESOLVE_CHECK] ${slug}: umaResolutionStatus="${m.umaResolutionStatus}", closed=${closed}, active=${active}, acceptingOrders=${acceptingOrders}`,
    );

    if (umaStatus === "resolved") {
      return {
        resolved: true,
        reason: `umaResolutionStatus="${m.umaResolutionStatus}", closed=${closed}`,
      };
    }

    // For 5-minute markets, closed=true or acceptingOrders=false
    // may indicate resolution even before umaResolutionStatus updates
    if (closed || !acceptingOrders) {
      return {
        resolved: true,
        reason: `closed=${closed}, acceptingOrders=${acceptingOrders}, umaResolutionStatus="${m.umaResolutionStatus}"`,
      };
    }

    return {
      resolved: false,
      reason: `umaResolutionStatus="${m.umaResolutionStatus}", closed=${closed}, active=${active}`,
    };
  } catch (error: any) {
    console.error(
      `[RESOLVE_CHECK] Error querying Gamma for ${slug}:`,
      error.message || error,
    );
    return { resolved: false, reason: `API error: ${error.message || error}` };
  }
}

// ============================================================================
// CLOB MARKET WEBSOCKET: best_bid_ask for market tokens
// Single WS connection, dynamically subscribe/unsubscribe token pairs
// ============================================================================
let marketWsPingInterval: ReturnType<typeof setInterval> | null = null;

function startMarketWebSocket(ctx: BotContext): void {
  if (ctx.marketWs && ctx.marketWs.readyState === WebSocket.OPEN) {
    return; // Already connected
  }

  console.log("[MARKET_WS] Connecting to CLOB WebSocket...");
  const ws = new WebSocket(CLOB_WS_URL);

  ws.on("open", () => {
    console.log("[MARKET_WS] Connected.");

    // Heartbeat: send PING every 10 seconds per Polymarket docs
    if (marketWsPingInterval) clearInterval(marketWsPingInterval);
    marketWsPingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send("PING");
      }
    }, 10_000);

    // Initial subscription: use type: "market" to set full subscription list
    if (ctx.subscribedTokenIds.size > 0) {
      const tokenIds = Array.from(ctx.subscribedTokenIds);
      ws.send(
        JSON.stringify({
          type: "market",
          assets_ids: tokenIds,
          custom_feature_enabled: true,
        }),
      );
      console.log(
        `[MARKET_WS] Initial subscription: ${tokenIds.length} tokens.`,
      );
    }
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event_type === "price_change" && msg.price_changes) {
        for (const change of msg.price_changes) {
          if (
            change.asset_id &&
            (change.best_bid !== undefined || change.best_ask !== undefined)
          ) {
            const bestBid = parseFloat(change.best_bid) || 0;
            const bestAsk = parseFloat(change.best_ask) || 1;
            ctx.priceCache[change.asset_id] = {
              bestBid,
              bestAsk,
              lastUpdate: Date.now(),
            };
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  });

  ws.on("error", (err) => {
    console.error("[MARKET_WS] Error:", err.message);
  });

  ws.on("close", (code, reason) => {
    console.log(`[MARKET_WS] Closed: ${code} - ${reason}`);
    ctx.marketWs = null;
    if (marketWsPingInterval) {
      clearInterval(marketWsPingInterval);
      marketWsPingInterval = null;
    }
    // Auto-reconnect after 2 seconds
    setTimeout(() => {
      console.log("[MARKET_WS] Reconnecting...");
      startMarketWebSocket(ctx);
    }, 2000);
  });

  ctx.marketWs = ws;
}

/** Subscribe new token IDs to the market WS.
 *  Uses the ADDITIVE `operation: "subscribe"` protocol per Polymarket docs.
 *  Only sends NEW tokens -- the server adds them to existing subscriptions.
 */
function subscribeMarketTokens(ctx: BotContext, tokenIds: string[]): void {
  const newTokens = tokenIds.filter((t) => !ctx.subscribedTokenIds.has(t));
  if (newTokens.length === 0) return;

  for (const t of newTokens) ctx.subscribedTokenIds.add(t);

  if (ctx.marketWs && ctx.marketWs.readyState === WebSocket.OPEN) {
    ctx.marketWs.send(
      JSON.stringify({
        assets_ids: newTokens,
        operation: "subscribe",
        custom_feature_enabled: true,
      }),
    );
    console.log(
      `[MARKET_WS] Subscribed: ${newTokens.length} new tokens (${ctx.subscribedTokenIds.size} total tracked).`,
    );
  }
}

/** Unsubscribe token IDs from the market WS */
function unsubscribeMarketTokens(ctx: BotContext, tokenIds: string[]): void {
  for (const t of tokenIds) {
    ctx.subscribedTokenIds.delete(t);
    delete ctx.priceCache[t];
  }

  if (ctx.marketWs && ctx.marketWs.readyState === WebSocket.OPEN) {
    ctx.marketWs.send(
      JSON.stringify({
        assets_ids: tokenIds,
        operation: "unsubscribe",
      }),
    );
    console.log(`[MARKET_WS] Unsubscribed from ${tokenIds.length} tokens.`);
  }
}

// ============================================================================
// RTDS CHAINLINK WEBSOCKET: Real-time crypto prices (BTC, ETH, SOL, XRP)
// Uses Polymarket's own Chainlink price feed via wss://ws-live-data.polymarket.com
// Provides CURRENT prices for the price difference calculation
// (Epoch-start prices come from Binance REST API instead)
// ============================================================================
let cryptoWsPingInterval: ReturnType<typeof setInterval> | null = null;

function startCryptoWebSocket(ctx: BotContext): void {
  if (ctx.cryptoWs && ctx.cryptoWs.readyState === WebSocket.OPEN) {
    return;
  }

  console.log("[CRYPTO_WS] Connecting to RTDS Chainlink WebSocket...");
  const ws = new WebSocket(RTDS_WS_URL);

  ws.on("open", () => {
    console.log("[CRYPTO_WS] Connected. Subscribing to crypto prices...");

    // Subscribe to each asset's Chainlink price feed
    const subscriptions = CONFIG.ASSETS.map((asset) => ({
      topic: "crypto_prices_chainlink",
      type: "*",
      filters: JSON.stringify({
        symbol: CONFIG.ASSET_CHAINLINK_SYMBOL[asset],
      }),
    }));

    ws.send(
      JSON.stringify({
        action: "subscribe",
        subscriptions,
      }),
    );

    console.log(
      `[CRYPTO_WS] Subscribed to: ${CONFIG.ASSETS.map((a) => CONFIG.ASSET_CHAINLINK_SYMBOL[a]).join(", ")}`,
    );

    // Send PING every 5 seconds to keep alive
    if (cryptoWsPingInterval) clearInterval(cryptoWsPingInterval);
    cryptoWsPingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send("PING");
      }
    }, 5000);
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const raw = data.toString();
      if (raw === "PONG") return; // Ignore pong responses

      const msg = JSON.parse(raw);

      // Handle crypto_prices_chainlink updates
      if (
        msg.topic === "crypto_prices_chainlink" &&
        msg.type === "update" &&
        msg.payload
      ) {
        const { symbol, value, timestamp } = msg.payload;
        if (symbol && typeof value === "number") {
          ctx.cryptoPriceCache[symbol] = {
            price: value,
            lastUpdate: timestamp || Date.now(),
          };
        }
      }
    } catch {
      // Ignore non-JSON messages
    }
  });

  ws.on("error", (err) => {
    console.error("[CRYPTO_WS] Error:", err.message);
  });

  ws.on("close", (code, reason) => {
    console.log(`[CRYPTO_WS] Closed: ${code} - ${reason}`);
    ctx.cryptoWs = null;
    if (cryptoWsPingInterval) {
      clearInterval(cryptoWsPingInterval);
      cryptoWsPingInterval = null;
    }
    // Auto-reconnect after 2 seconds
    setTimeout(() => {
      console.log("[CRYPTO_WS] Reconnecting...");
      startCryptoWebSocket(ctx);
    }, 2000);
  });

  ctx.cryptoWs = ws;
}

/** Get current underlying asset price from RTDS cache */
function getCryptoPrice(ctx: BotContext, asset: string): number | null {
  const symbol = CONFIG.ASSET_CHAINLINK_SYMBOL[asset];
  if (!symbol) return null;
  const cached = ctx.cryptoPriceCache[symbol];
  if (!cached) return null;
  // Consider stale after 30 seconds
  if (Date.now() - cached.lastUpdate > 30000) return null;
  return cached.price;
}

// ============================================================================
// BINANCE REST API: Fetch spot price at epoch start
// Called once per asset per epoch to snapshot the "target" start price
// ============================================================================
async function fetchBinancePrice(asset: string): Promise<number | null> {
  const symbol = CONFIG.ASSET_BINANCE_SYMBOL[asset];
  if (!symbol) return null;
  try {
    const response = await axios.get(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
    );
    const price = parseFloat(response.data?.price);
    if (isNaN(price) || price <= 0) return null;
    return price;
  } catch (error: any) {
    console.error(
      `[BINANCE] Failed to fetch ${symbol} price:`,
      error.message || error,
    );
    return null;
  }
}

// ============================================================================
// EPOCH MANAGEMENT
// Snapshots crypto prices at the start of each 5-minute epoch
// Epoch-start price: Binance REST API (authoritative spot price)
// Current price: RTDS Chainlink WebSocket (for ongoing comparison)
// ============================================================================
async function handleNewEpoch(ctx: BotContext): Promise<void> {
  const epoch = getCurrentEpoch();
  if (epoch === ctx.currentEpoch) return; // Same epoch, no action

  const prevEpoch = ctx.currentEpoch;
  ctx.currentEpoch = epoch;
  metrics.cycleCount++;
  console.log(
    `\n[EPOCH] New epoch: ${epoch} (${new Date(epoch * 1000).toISOString()})`,
  );

  // Cleanup: unsubscribe tokens from previous epoch that have no active positions
  if (prevEpoch > 0) {
    const prevTokensToRemove: string[] = [];
    for (const tokenId of ctx.subscribedTokenIds) {
      const hasActivePos = ctx.activePositions.some(
        (p) =>
          p.state !== "DONE" &&
          (p.yesTokenId === tokenId || p.noTokenId === tokenId),
      );
      if (!hasActivePos) {
        prevTokensToRemove.push(tokenId);
      }
    }
    if (prevTokensToRemove.length > 0) {
      console.log(
        `[EPOCH] Cleaning up ${prevTokensToRemove.length} stale tokens from previous epoch`,
      );
      unsubscribeMarketTokens(ctx, prevTokensToRemove);
    }
  }

  // Snapshot epoch-start prices from Binance REST API
  for (const asset of CONFIG.ASSETS) {
    const price = await fetchBinancePrice(asset);
    if (price !== null) {
      ctx.epochStartPrices[asset] = { price, epoch };
      console.log(
        `[EPOCH] ${asset.toUpperCase()} Binance epoch start price: $${price.toFixed(4)}`,
      );
    } else {
      console.warn(
        `[EPOCH] Failed to fetch Binance price for ${asset.toUpperCase()} at epoch start`,
      );
    }
  }

  // Send Telegram notification for new epoch
  const priceLines = CONFIG.ASSETS.map((a) => {
    const p = ctx.epochStartPrices[a];
    return `  ${a.toUpperCase()}: ${p ? "$" + p.price.toFixed(2) : "N/A"}`;
  }).join("\n");

  sendTelegramMessage(
    `<b>NEW EPOCH</b> \u{23F0}\n` +
      `Epoch: ${epoch} (${new Date(epoch * 1000).toISOString()})\n` +
      `Active positions: ${ctx.activePositions.filter((p) => p.state !== "DONE").length}/${CONFIG.MAX_CONCURRENT_POSITIONS}\n\n` +
      `Epoch start prices:\n${priceLines}`,
  );
}

// ============================================================================
// OPPORTUNITY SCANNING
// Checks all assets for buy opportunities: token bid >= $0.98 AND
// underlying price moved enough since epoch start (using RTDS Chainlink)
// ============================================================================
async function scanForOpportunities(ctx: BotContext): Promise<void> {
  const epoch = ctx.currentEpoch;
  if (epoch === 0) return; // No epoch yet

  const activeCount = ctx.activePositions.filter(
    (p) => p.state !== "DONE",
  ).length;

  // No slots available
  if (activeCount >= CONFIG.MAX_CONCURRENT_POSITIONS) return;

  for (const asset of CONFIG.ASSETS) {
    // Check if we still have slots
    const currentActive = ctx.activePositions.filter(
      (p) => p.state !== "DONE",
    ).length;
    if (currentActive >= CONFIG.MAX_CONCURRENT_POSITIONS) {
      console.log(
        `[SCAN] All ${CONFIG.MAX_CONCURRENT_POSITIONS} position slots occupied. Skipping scan.`,
      );
      break;
    }

    const slug = deriveMarketSlug(asset, epoch);

    // Already have a position in this exact market?
    if (
      ctx.activePositions.some((p) => p.slug === slug && p.state !== "DONE")
    ) {
      console.log(
        `[SCAN] ${asset.toUpperCase()} - already have active position in ${slug}, skipping`,
      );
      continue;
    }

    // Fetch market from Gamma
    const market = await fetchGammaMarket(slug);
    if (!market) {
      console.log(
        `[SCAN] ${asset.toUpperCase()} - market ${slug} not found on Gamma, skipping`,
      );
      continue;
    }

    // Check processed condition IDs (never reinvest)
    if (ctx.processedConditionIds.has(market.conditionId)) {
      console.log(
        `[SCAN] ${asset.toUpperCase()} - conditionId ${market.conditionId.slice(0, 16)}... already processed (no reinvest), skipping`,
      );
      continue;
    }

    // Ensure tokens are subscribed on CLOB WS
    subscribeMarketTokens(ctx, [market.yesTokenId, market.noTokenId]);

    // Check both YES (up) and NO (down) token bid prices
    const yesPrice = ctx.priceCache[market.yesTokenId];
    const noPrice = ctx.priceCache[market.noTokenId];
    const chainlinkNow = getCryptoPrice(ctx, asset);
    const epochStartP = ctx.epochStartPrices[asset];
    const cryptoStr =
      chainlinkNow !== null ? `$${chainlinkNow.toFixed(2)}` : "N/A";
    const epochStr = epochStartP ? `$${epochStartP.price.toFixed(2)}` : "N/A";
    const diffStr =
      chainlinkNow !== null && epochStartP
        ? `$${Math.abs(chainlinkNow - epochStartP.price).toFixed(2)}`
        : "N/A";
    console.log(
      `[SCAN] ${asset.toUpperCase()} - ${slug}: YES bid=${yesPrice ? "$" + yesPrice.bestBid.toFixed(4) : "N/A"}, NO bid=${noPrice ? "$" + noPrice.bestBid.toFixed(4) : "N/A"} (trigger=$${CONFIG.BUY_TRIGGER_PRICE}) | Chainlink=${cryptoStr}, EpochStart=${epochStr}, Diff=${diffStr}`,
    );

    const candidates: Array<{
      tokenId: string;
      side: "YES" | "NO";
      bid: number;
    }> = [];

    if (yesPrice && yesPrice.bestBid >= CONFIG.BUY_TRIGGER_PRICE) {
      candidates.push({
        tokenId: market.yesTokenId,
        side: "YES",
        bid: yesPrice.bestBid,
      });
    }
    if (noPrice && noPrice.bestBid >= CONFIG.BUY_TRIGGER_PRICE) {
      candidates.push({
        tokenId: market.noTokenId,
        side: "NO",
        bid: noPrice.bestBid,
      });
    }

    if (candidates.length === 0) {
      console.log(
        `[SCAN] ${asset.toUpperCase()} - no token bid >= $${CONFIG.BUY_TRIGGER_PRICE}, skipping`,
      );
      continue;
    }

    console.log(
      `[SCAN] ${asset.toUpperCase()} - ${candidates.length} candidate(s): ${candidates.map((c) => `${c.side} bid=$${c.bid.toFixed(4)}`).join(", ")}`,
    );

    // PRICE DIFFERENCE CHECK: Use RTDS Chainlink crypto price
    const epochStart = ctx.epochStartPrices[asset];
    if (!epochStart || epochStart.epoch !== epoch) {
      console.log(
        `[SCAN] ${asset.toUpperCase()} - no epoch start price, skipping`,
      );
      continue;
    }

    const currentCryptoPrice = getCryptoPrice(ctx, asset);
    if (currentCryptoPrice === null) {
      console.log(
        `[SCAN] ${asset.toUpperCase()} - no current RTDS price, skipping`,
      );
      continue;
    }

    const priceDiff = Math.abs(currentCryptoPrice - epochStart.price);
    const minDiff = CONFIG.ASSET_PRICE_DIFF[asset] || CONFIG.PRICE_DIFFERENCE;

    if (priceDiff < minDiff) {
      console.log(
        `[SCAN] ${asset.toUpperCase()} - price diff $${priceDiff.toFixed(4)} < min $${minDiff} (Binance epoch: $${epochStart.price.toFixed(2)}, Chainlink now: $${currentCryptoPrice.toFixed(2)}), skipping`,
      );
      continue;
    }

    console.log(
      `[SCAN] ${asset.toUpperCase()} - price diff $${priceDiff.toFixed(4)} >= min $${minDiff} (Binance: $${epochStart.price.toFixed(2)} -> Chainlink: $${currentCryptoPrice.toFixed(2)}) -- QUALIFIES`,
    );

    // Pick the best candidate (highest bid)
    const best = candidates.sort((a, b) => b.bid - a.bid)[0];

    // Open position
    await openPosition(ctx, asset, market, best.tokenId, best.side, epoch);

    // Mark as processed immediately
    ctx.processedConditionIds.add(market.conditionId);
    break; // One new position per scan cycle to avoid rate limits
  }
}

// ============================================================================
// OPEN POSITION: Place GTC buy order at $0.99
// ============================================================================
async function openPosition(
  ctx: BotContext,
  asset: string,
  market: MarketInfo,
  tokenId: string,
  side: "YES" | "NO",
  epoch: number,
): Promise<void> {
  const posId = `${asset}-${epoch}-${side}`;
  console.log(
    `\n[OPEN] Opening position: ${posId} @ $${CONFIG.BUY_LIMIT_PRICE}`,
  );

  try {
    const orderResult = await ctx.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: CONFIG.BUY_LIMIT_PRICE,
        size: CONFIG.BASE_SIZE,
        side: Side.BUY,
      },
      {
        tickSize: market.tickSize as any,
        negRisk: market.negRisk,
      },
      OrderType.GTC,
    );

    if (!orderResult.orderID) {
      console.error(`[OPEN] No order ID returned for ${posId}`);
      return;
    }

    console.log(`[OPEN] Order placed: ${orderResult.orderID}`);

    const pos: ActivePosition = {
      id: posId,
      asset,
      slug: market.slug,
      conditionId: market.conditionId,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      boughtTokenId: tokenId,
      boughtSide: side,
      buyOrderId: orderResult.orderID,
      buyPrice: CONFIG.BUY_LIMIT_PRICE,
      buySize: CONFIG.BASE_SIZE,
      filledSize: 0,
      filledCost: 0,
      state: "BUYING",
      stopLossAttempts: 0,
      stopLossSellOrderId: null,
      lastOrderPollTime: 0,
      lastResolutionPollTime: 0,
      lastRedeemAttemptTime: 0,
      marketResolved: false,
      createdAt: Date.now(),
      epochTimestamp: epoch,
      lastHoldingLogTime: 0,
      tickSize: market.tickSize,
      negRisk: market.negRisk,
    };

    ctx.activePositions.push(pos);
    metrics.totalBuys++;

    // Telegram: buy order placed
    const epochStartInfo = ctx.epochStartPrices[asset];
    const currentCrypto = getCryptoPrice(ctx, asset);
    await sendTelegramMessage(
      `<b>BUY ORDER PLACED</b> \u{1F4E5}\n` +
        `Position: ${posId}\n` +
        `Market: ${market.slug}\n` +
        `Side: ${side} @ $${CONFIG.BUY_LIMIT_PRICE}\n` +
        `Size: ${CONFIG.BASE_SIZE} shares\n` +
        `Order ID: ${orderResult.orderID}\n\n` +
        `Price sources:\n` +
        `  Epoch start (Binance): $${epochStartInfo?.price.toFixed(2) || "N/A"}\n` +
        `  Current (Chainlink): $${currentCrypto?.toFixed(2) || "N/A"}\n` +
        `  Diff: $${currentCrypto && epochStartInfo ? Math.abs(currentCrypto - epochStartInfo.price).toFixed(2) : "N/A"}`,
    );
  } catch (error: any) {
    console.error(
      `[OPEN] Failed to place order for ${posId}:`,
      error.message || error,
    );
  }
}

// ============================================================================
// TICK POSITION: Process each position's state machine per main loop tick
// ============================================================================
async function tickPosition(
  ctx: BotContext,
  pos: ActivePosition,
): Promise<void> {
  const now = Date.now();

  switch (pos.state) {
    // ------------------------------------------------------------------
    // BUYING: Waiting for GTC buy order to fill
    // ------------------------------------------------------------------
    case "BUYING": {
      if (now - pos.lastOrderPollTime < CONFIG.ORDER_POLL_MS) return;
      pos.lastOrderPollTime = now;

      if (!pos.buyOrderId) {
        console.log(
          `[TICK:${pos.id}] BUYING: No buyOrderId set, marking DONE.`,
        );
        pos.state = "DONE";
        return;
      }

      try {
        const orderDetails = await ctx.client.getOrder(pos.buyOrderId);
        const status = orderDetails?.status?.toUpperCase();
        const sizeMatched = (orderDetails as any)?.size_matched || "0";
        const ageSeconds = Math.round((now - pos.createdAt) / 1000);
        console.log(
          `[TICK:${pos.id}] BUYING: polling order ${pos.buyOrderId.slice(0, 16)}... status=${status}, size_matched=${sizeMatched}, age=${ageSeconds}s`,
        );

        if (
          status === "MATCHED" ||
          status === "MINED" ||
          status === "CONFIRMED"
        ) {
          // Order filled
          const sizeMatched =
            parseFloat((orderDetails as any).size_matched) || pos.buySize;
          // Estimate cost (will refine from trades if available)
          let totalCost = sizeMatched * pos.buyPrice;
          try {
            const trades = await ctx.client.getTrades({
              maker_address: process.env.FUNDER_ADDRESS,
              market: pos.conditionId,
            } as any);
            if (trades && Array.isArray(trades) && trades.length > 0) {
              const orderTrades = trades.filter(
                (t: any) =>
                  t.order_id === pos.buyOrderId ||
                  t.maker_order_id === pos.buyOrderId,
              );
              if (orderTrades.length > 0) {
                totalCost = orderTrades.reduce(
                  (sum: number, t: any) =>
                    sum + parseFloat(t.size) * parseFloat(t.price),
                  0,
                );
                console.log(
                  `[TICK:${pos.id}] Actual fill cost from ${orderTrades.length} trades: $${totalCost.toFixed(4)}`,
                );
              }
            }
          } catch {
            // Use estimated cost
          }

          pos.filledSize = sizeMatched;
          pos.filledCost = totalCost;
          pos.state = "HOLDING";

          console.log(
            `[TICK:${pos.id}] BUY FILLED: ${sizeMatched} shares @ ~$${(totalCost / sizeMatched).toFixed(4)} = $${totalCost.toFixed(4)}`,
          );

          // Telegram: buy filled
          await sendTelegramMessage(
            `<b>BUY FILLED</b> \u{2705}\n` +
              `Position: ${pos.id}\n` +
              `Filled: ${sizeMatched} ${pos.boughtSide} shares\n` +
              `Cost: $${totalCost.toFixed(4)}\n` +
              `Avg price: $${(totalCost / sizeMatched).toFixed(4)}\n` +
              `Now HOLDING until resolution or stop-loss ($${CONFIG.STOP_LOSS_PRICE}).`,
          );
        } else if (status === "CANCELED" || status === "CANCELLED") {
          console.log(`[TICK:${pos.id}] Buy order cancelled externally.`);
          pos.state = "DONE";
        }
        // Otherwise still open, keep waiting
      } catch (error: any) {
        console.error(
          `[TICK:${pos.id}] Error polling buy order:`,
          error.message || error,
        );
      }
      break;
    }

    // ------------------------------------------------------------------
    // HOLDING: Monitor for stop-loss or wait for resolution
    // ------------------------------------------------------------------
    case "HOLDING": {
      const holdSeconds = Math.round((now - pos.createdAt) / 1000);
      const marketEndTime =
        (pos.epochTimestamp + CONFIG.INTERVAL_SECONDS) * 1000; // ms
      const pastEndMs = now - marketEndTime;

      // Periodic HOLDING status log
      if (now - pos.lastHoldingLogTime >= CONFIG.HOLDING_STATUS_LOG_MS) {
        pos.lastHoldingLogTime = now;
        const cached = ctx.priceCache[pos.boughtTokenId];
        const bidStr = cached ? `$${cached.bestBid.toFixed(4)}` : "N/A";
        const askStr = cached ? `$${cached.bestAsk.toFixed(4)}` : "N/A";
        const pastEndStr =
          pastEndMs > 0
            ? `+${Math.round(pastEndMs / 1000)}s past end`
            : `${Math.round(-pastEndMs / 1000)}s until end`;
        console.log(
          `[TICK:${pos.id}] HOLDING: held=${holdSeconds}s, bid=${bidStr}, ask=${askStr}, ${pastEndStr}, slug=${pos.slug}`,
        );
      }

      // Check current bid price for stop-loss
      // IMPORTANT: Only check stop-loss BEFORE epoch ends.
      // After the epoch window closes, the outcome is already determined
      // (by the epoch-end Chainlink price). Bid/ask going to $0 at that
      // point just means the orderbook is being removed, not a real crash.
      const epochEndTime =
        (pos.epochTimestamp + CONFIG.INTERVAL_SECONDS) * 1000;
      const cached = ctx.priceCache[pos.boughtTokenId];
      if (cached && now < epochEndTime) {
        if (cached.bestBid < CONFIG.STOP_LOSS_PRICE) {
          console.log(
            `[TICK:${pos.id}] STOP-LOSS TRIGGERED: bid $${cached.bestBid.toFixed(2)} < $${CONFIG.STOP_LOSS_PRICE}`,
          );
          pos.state = "STOP_LOSS";

          await sendTelegramMessage(
            `<b>STOP-LOSS TRIGGERED</b> \u{1F6A8}\n` +
              `Position: ${pos.id}\n` +
              `Current bid: $${cached.bestBid.toFixed(2)}\n` +
              `Threshold: $${CONFIG.STOP_LOSS_PRICE}\n` +
              `Attempting aggressive sell (${CONFIG.STOP_LOSS_DISCOUNT * 100}% below bid)...`,
          );
          break;
        }
      }

      // Check for market resolution via Gamma API (no time-based assumptions)
      if (now - pos.lastResolutionPollTime >= CONFIG.RESOLUTION_POLL_MS) {
        pos.lastResolutionPollTime = now;
        const { resolved, reason } = await checkMarketResolved(pos.slug);
        console.log(
          `[TICK:${pos.id}] Resolution check: resolved=${resolved}, reason="${reason}"`,
        );
        if (resolved) {
          console.log(
            `[TICK:${pos.id}] Market RESOLVED (${reason}). Moving to CLAIMING.`,
          );
          pos.marketResolved = true;
          pos.state = "CLAIMING";
        }
      }
      break;
    }

    // ------------------------------------------------------------------
    // STOP_LOSS: Aggressively sell at 2% below market bid
    // Fresh WS price on each retry, $0.01 GTC fallback after 30 attempts
    // ------------------------------------------------------------------
    case "STOP_LOSS": {
      if (pos.stopLossAttempts >= CONFIG.MAX_STOP_LOSS_ATTEMPTS) {
        // Fallback: place GTC at $0.01
        console.log(
          `[TICK:${pos.id}] All ${CONFIG.MAX_STOP_LOSS_ATTEMPTS} stop-loss attempts exhausted. Placing GTC at $${CONFIG.STOP_LOSS_FALLBACK_PRICE}`,
        );
        try {
          const fallbackOrder = await ctx.client.createAndPostOrder(
            {
              tokenID: pos.boughtTokenId,
              price: CONFIG.STOP_LOSS_FALLBACK_PRICE,
              size: pos.filledSize - 0.01,
              side: Side.SELL,
            },
            { tickSize: pos.tickSize as any, negRisk: pos.negRisk },
            OrderType.GTC,
          );
          console.log(
            `[TICK:${pos.id}] Fallback GTC order: ${fallbackOrder.orderID}`,
          );

          const lossEstimate = pos.filledCost;
          metrics.totalPnL -= lossEstimate;
          metrics.lossCount++;
          metrics.totalStopLosses++;

          await sendTelegramMessage(
            `<b>STOP-LOSS FALLBACK</b> \u{26A0}\u{FE0F}\n` +
              `Position: ${pos.id}\n` +
              `Placed GTC SELL at $${CONFIG.STOP_LOSS_FALLBACK_PRICE} x ${pos.filledSize}\n` +
              `Estimated loss: -$${lossEstimate.toFixed(2)}\n\n` +
              `Total PnL: $${metrics.totalPnL.toFixed(2)}`,
          );
        } catch (error: any) {
          console.error(
            `[TICK:${pos.id}] Fallback order failed:`,
            error.message || error,
          );
        }
        pos.state = "DONE";
        break;
      }

      // Check if a previous stop-loss order already filled
      if (pos.stopLossSellOrderId) {
        if (now - pos.lastOrderPollTime < CONFIG.ORDER_POLL_MS) return;
        pos.lastOrderPollTime = now;

        try {
          const orderDetails = await ctx.client.getOrder(
            pos.stopLossSellOrderId,
          );
          const status = orderDetails?.status?.toUpperCase();

          if (
            status === "MATCHED" ||
            status === "MINED" ||
            status === "CONFIRMED"
          ) {
            const filledSize =
              parseFloat((orderDetails as any).size_matched) || pos.filledSize;
            const sellPrice = parseFloat((orderDetails as any).price) || 0;
            const proceeds = filledSize * sellPrice;
            const pnl = proceeds - pos.filledCost;

            console.log(
              `[TICK:${pos.id}] Stop-loss FILLED: ${filledSize} @ $${sellPrice.toFixed(4)} = $${proceeds.toFixed(4)} (PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)})`,
            );

            metrics.totalPnL += pnl;
            if (pnl >= 0) metrics.winCount++;
            else metrics.lossCount++;
            metrics.totalStopLosses++;

            await sendTelegramMessage(
              `<b>STOP-LOSS FILLED</b> \u{1F4C9}\n` +
                `Position: ${pos.id}\n` +
                `Sold: ${filledSize} @ $${sellPrice.toFixed(4)}\n` +
                `Proceeds: $${proceeds.toFixed(4)}\n` +
                `PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}\n\n` +
                `Total PnL: $${metrics.totalPnL.toFixed(2)}\n` +
                `Wins: ${metrics.winCount} | Losses: ${metrics.lossCount}`,
            );

            pos.state = "DONE";
            return;
          } else if (status === "CANCELED" || status === "CANCELLED") {
            pos.stopLossSellOrderId = null;
          }
          return;
        } catch {
          return;
        }
      }

      // Place new stop-loss sell order: 2% below current bid
      pos.stopLossAttempts++;

      const freshPrice = ctx.priceCache[pos.boughtTokenId];
      if (!freshPrice) {
        console.log(`[TICK:${pos.id}] No WS price for stop-loss, waiting...`);
        return;
      }

      const currentBid = freshPrice.bestBid;
      const sellPrice = Math.max(
        0.01,
        Math.round(currentBid * (1 - CONFIG.STOP_LOSS_DISCOUNT) * 100) / 100,
      );

      console.log(
        `[TICK:${pos.id}] Stop-loss attempt ${pos.stopLossAttempts}/${CONFIG.MAX_STOP_LOSS_ATTEMPTS}: SELL @ $${sellPrice.toFixed(2)} (bid: $${currentBid.toFixed(2)})`,
      );

      try {
        const sellOrder = await ctx.client.createAndPostOrder(
          {
            tokenID: pos.boughtTokenId,
            price: sellPrice,
            size: pos.filledSize,
            side: Side.SELL,
          },
          { tickSize: pos.tickSize as any, negRisk: pos.negRisk },
          OrderType.GTC,
        );

        if (sellOrder.orderID) {
          pos.stopLossSellOrderId = sellOrder.orderID;
          pos.lastOrderPollTime = now;
          console.log(
            `[TICK:${pos.id}] Stop-loss order placed: ${sellOrder.orderID}`,
          );
        }
      } catch (error: any) {
        const errMsg =
          typeof error?.response?.data?.error === "string"
            ? error.response.data.error
            : error.message || String(error);

        // "orderbook does not exist" = market closed by Polymarket.
        // No point retrying -- move to AWAIT_RESOLUTION to wait for claiming.
        if (errMsg.includes("does not exist")) {
          console.log(
            `[TICK:${pos.id}] Orderbook removed (market closed). Skipping stop-loss, moving to AWAIT_RESOLUTION.`,
          );
          pos.state = "AWAIT_RESOLUTION";
          break;
        }

        console.error(`[TICK:${pos.id}] Stop-loss order failed:`, errMsg);
      }
      break;
    }

    // ------------------------------------------------------------------
    // AWAIT_RESOLUTION: Wait for market to resolve
    // ------------------------------------------------------------------
    case "AWAIT_RESOLUTION": {
      if (now - pos.lastResolutionPollTime < CONFIG.RESOLUTION_POLL_MS) return;
      pos.lastResolutionPollTime = now;

      const { resolved, reason } = await checkMarketResolved(pos.slug);
      console.log(
        `[TICK:${pos.id}] AWAIT_RESOLUTION check: resolved=${resolved}, reason="${reason}"`,
      );
      if (resolved) {
        console.log(
          `[TICK:${pos.id}] Market RESOLVED (${reason}), moving to CLAIMING.`,
        );
        pos.marketResolved = true;
        pos.state = "CLAIMING";
      }
      break;
    }

    // ------------------------------------------------------------------
    // CLAIMING: Redeem winning tokens via Builder Relayer (gasless)
    // Position slot NOT freed until claim completes
    // ------------------------------------------------------------------
    case "CLAIMING": {
      if (now - pos.lastRedeemAttemptTime < CONFIG.REDEEM_RETRY_MS) return;
      pos.lastRedeemAttemptTime = now;

      pos.claimAttempts = (pos.claimAttempts || 0) + 1;
      const timeSinceCreation = Math.round((now - pos.createdAt) / 1000);
      console.log(
        `[TICK:${pos.id}] CLAIMING: attempt #${pos.claimAttempts}, conditionId=${pos.conditionId}, filledSize=${pos.filledSize}, filledCost=$${pos.filledCost.toFixed(4)}, age=${timeSinceCreation}s`,
      );

      try {
        console.log(`[TICK:${pos.id}] CLAIMING: calling redeemWinnings...`);
        const success = await redeemWinnings(pos.conditionId);
        console.log(
          `[TICK:${pos.id}] CLAIMING: redeemWinnings returned success=${success}`,
        );
        if (success) {
          // Winning tokens pay $1 per share
          const proceeds = pos.filledSize * 1.0;
          const pnl = proceeds - pos.filledCost;

          console.log(
            `[TICK:${pos.id}] CLAIMED: $${proceeds.toFixed(4)} (PnL: +$${pnl.toFixed(4)})`,
          );

          metrics.totalPnL += pnl;
          metrics.winCount++;
          metrics.totalClaimed++;

          await sendTelegramMessage(
            `<b>WINNINGS CLAIMED</b> \u{1F4B0}\n` +
              `Position: ${pos.id}\n` +
              `Shares: ${pos.filledSize} ${pos.boughtSide}\n` +
              `Cost: $${pos.filledCost.toFixed(4)}\n` +
              `Proceeds: $${proceeds.toFixed(4)}\n` +
              `PnL: +$${pnl.toFixed(4)}\n\n` +
              `Total PnL: $${metrics.totalPnL.toFixed(2)}\n` +
              `Wins: ${metrics.winCount} | Losses: ${metrics.lossCount}\n` +
              `Win rate: ${((metrics.winCount / Math.max(metrics.winCount + metrics.lossCount, 1)) * 100).toFixed(1)}%`,
          );

          pos.state = "DONE";
        } else {
          console.log(
            `[TICK:${pos.id}] Claim attempt #${pos.claimAttempts} not successful, will retry in ${CONFIG.REDEEM_RETRY_MS / 1000}s...`,
          );
        }
      } catch (error: any) {
        console.error(
          `[TICK:${pos.id}] Claim error on attempt #${pos.claimAttempts}:`,
          error.message || error,
        );
        if (error.stack)
          console.error(`[TICK:${pos.id}] Claim stack trace:`, error.stack);
      }
      break;
    }

    case "DONE":
      break;
  }
}

// ============================================================================
// BUILDER RELAYER: Redeem winning positions (gasless)
// Uses ethers v5 ABI encoding + Polymarket Builder Relayer
// ============================================================================
async function redeemWinnings(conditionId: string): Promise<boolean> {
  try {
    console.log(`[REDEEM] Step 1: Importing ethers and encoding calldata...`);
    const { ethers } = await import("ethers");
    const iface = new ethers.utils.Interface([
      "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
    ]);

    const calldata = iface.encodeFunctionData("redeemPositions", [
      CONFIG.USDC_ADDRESS,
      CONFIG.PARENT_COLLECTION_ID,
      conditionId,
      CONFIG.INDEX_SETS,
    ]);
    console.log(
      `[REDEEM] Calldata encoded (${calldata.length} chars): ${calldata.slice(0, 66)}...`,
    );

    console.log(
      `[REDEEM] Step 2: Setting up viem wallet and Builder Relayer...`,
    );
    const { createWalletClient, http } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { polygon } = await import("viem/chains");
    const { RelayClient } = await import("@polymarket/builder-relayer-client");
    const { BuilderConfig } = await import("@polymarket/builder-signing-sdk");

    const account = privateKeyToAccount(
      process.env.PRIVATE_KEY as `0x${string}`,
    );
    console.log(`[REDEEM] Wallet account: ${account.address}`);

    const wallet = createWalletClient({
      account,
      chain: polygon,
      transport: http(process.env.RPC_URL),
    });

    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: process.env.POLY_BUILDER_API_KEY!,
        secret: process.env.POLY_BUILDER_SECRET!,
        passphrase: process.env.POLY_BUILDER_PASSPHRASE!,
      },
    });
    console.log(
      `[REDEEM] BuilderConfig created with API key: ${process.env.POLY_BUILDER_API_KEY?.slice(0, 8)}...`,
    );

    const relayClient = new RelayClient(
      CONFIG.RELAYER_URL,
      CONFIG.CHAIN_ID,
      wallet as any,
      builderConfig as any,
    );
    console.log(
      `[REDEEM] RelayClient ready (url=${CONFIG.RELAYER_URL}, chainId=${CONFIG.CHAIN_ID})`,
    );

    const redeemTx = {
      to: CONFIG.CTF_ADDRESS,
      data: calldata,
      value: "0",
    };

    console.log(
      `[REDEEM] Step 3: Executing redeem via relayer for conditionId=${conditionId}...`,
    );
    console.log(
      `[REDEEM] Tx: to=${redeemTx.to}, dataLen=${redeemTx.data.length}`,
    );
    const response = await relayClient.execute(
      [redeemTx],
      `Redeem positions for ${conditionId}`,
    );
    console.log(
      `[REDEEM] Step 4: Relayer response received, waiting for confirmation...`,
    );
    console.log(`[REDEEM] Response object:`, JSON.stringify(response, null, 2));

    const result = await response.wait();
    console.log(`[REDEEM] Step 5: Transaction confirmed!`);
    console.log(`[REDEEM] Result:`, JSON.stringify(result, null, 2));

    return true;
  } catch (error: any) {
    console.error(`[REDEEM] Failed at some step:`, error.message || error);
    if (error.response?.data) {
      console.error(
        `[REDEEM] Response data:`,
        JSON.stringify(error.response.data),
      );
    }
    if (error.stack) {
      console.error(`[REDEEM] Stack trace:`, error.stack);
    }
    return false;
  }
}

// ============================================================================
// CLEANUP: Remove DONE positions and unsubscribe their tokens
// ============================================================================
async function cleanupDonePositions(ctx: BotContext): Promise<void> {
  const done = ctx.activePositions.filter((p) => p.state === "DONE");
  if (done.length === 0) return;

  for (const pos of done) {
    console.log(`[CLEANUP] Removing completed position: ${pos.id}`);

    // Send cycle summary for each completed position
    const durationSec = Math.round((Date.now() - pos.createdAt) / 1000);
    const durationMin = Math.floor(durationSec / 60);
    const durationRemSec = durationSec % 60;
    const cyclePnL = pos.marketResolved
      ? pos.filledSize * 1.0 - pos.filledCost
      : -pos.filledCost; // stop-loss or cancelled = lost the cost
    const wasWin = pos.marketResolved && cyclePnL >= 0;
    const totalRounds = metrics.winCount + metrics.lossCount;
    const winRate =
      totalRounds > 0 ? (metrics.winCount / totalRounds) * 100 : 0;

    await sendTelegramMessage(
      `<b>CYCLE COMPLETE</b> \u{1F3C1}\n` +
        `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n` +
        `Position: ${pos.id}\n` +
        `Side: ${pos.boughtSide} | Market: ${pos.slug}\n` +
        `Result: ${wasWin ? "WIN \u{2705}" : "LOSS \u{274C}"}\n` +
        `Shares: ${pos.filledSize} @ $${pos.filledSize > 0 ? (pos.filledCost / pos.filledSize).toFixed(4) : "0"}\n` +
        `Cost: $${pos.filledCost.toFixed(4)}\n` +
        `Cycle PnL: ${cyclePnL >= 0 ? "+" : ""}$${cyclePnL.toFixed(4)}\n` +
        `Duration: ${durationMin}m ${durationRemSec}s\n` +
        `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n` +
        `<b>Session Totals:</b>\n` +
        `Total PnL: ${metrics.totalPnL >= 0 ? "+" : ""}$${metrics.totalPnL.toFixed(4)}\n` +
        `Wins: ${metrics.winCount} | Losses: ${metrics.lossCount}\n` +
        `Win Rate: ${winRate.toFixed(1)}%\n` +
        `Cycles: ${totalRounds} | Buys: ${metrics.totalBuys}\n` +
        `Claims: ${metrics.totalClaimed} | Stop-losses: ${metrics.totalStopLosses}`,
    );

    // Only unsubscribe tokens if no other active position uses them
    const otherActive = ctx.activePositions.filter(
      (p) =>
        p.id !== pos.id &&
        p.state !== "DONE" &&
        (p.yesTokenId === pos.yesTokenId || p.noTokenId === pos.noTokenId),
    );

    if (otherActive.length === 0) {
      unsubscribeMarketTokens(ctx, [pos.yesTokenId, pos.noTokenId]);
    }
  }

  ctx.activePositions = ctx.activePositions.filter((p) => p.state !== "DONE");
}

// ============================================================================
// MAIN LOOP
// ============================================================================
async function main() {
  console.log("=".repeat(80));
  console.log("STRAT2: 5-MINUTE MARKET MOMENTUM BOT");
  console.log("=".repeat(80));
  console.log("Configuration:");
  console.log(`  Buy trigger: $${CONFIG.BUY_TRIGGER_PRICE}`);
  console.log(`  Buy limit: $${CONFIG.BUY_LIMIT_PRICE}`);
  console.log(`  Base size: ${CONFIG.BASE_SIZE} shares`);
  console.log(`  Stop-loss: $${CONFIG.STOP_LOSS_PRICE}`);
  console.log(`  Stop-loss discount: ${CONFIG.STOP_LOSS_DISCOUNT * 100}%`);
  console.log(`  Max concurrent: ${CONFIG.MAX_CONCURRENT_POSITIONS}`);
  console.log(`  Assets: ${CONFIG.ASSETS.join(", ")}`);
  console.log(`  Interval: ${CONFIG.INTERVAL_SECONDS}s`);
  console.log(
    `  Price diff thresholds: ${JSON.stringify(CONFIG.ASSET_PRICE_DIFF)}`,
  );
  console.log(`  Epoch start price: Binance REST API`);
  console.log(`  Current price: Polymarket RTDS Chainlink WebSocket`);
  console.log(`  Log file: ${getLogFilePath()}`);
  console.log("=".repeat(80));

  const client = await initializeClient();

  const ctx: BotContext = {
    client,
    marketWs: null,
    cryptoWs: null,
    priceCache: {},
    cryptoPriceCache: {},
    epochStartPrices: {},
    activePositions: [],
    processedConditionIds: new Set(),
    currentEpoch: 0,
    subscribedTokenIds: new Set(),
  };

  // Start both WebSocket connections
  startMarketWebSocket(ctx);
  startCryptoWebSocket(ctx);

  // Wait for WebSockets to connect and receive initial data
  console.log("[MAIN] Waiting 5 seconds for WebSocket connections...");
  await sleep(5000);

  await sendTelegramMessage(
    `<b>STRAT2 BOT STARTED</b> \u{1F680}\n` +
      `Assets: ${CONFIG.ASSETS.join(", ").toUpperCase()}\n` +
      `Max positions: ${CONFIG.MAX_CONCURRENT_POSITIONS}\n` +
      `Buy trigger: $${CONFIG.BUY_TRIGGER_PRICE}\n` +
      `Stop-loss: $${CONFIG.STOP_LOSS_PRICE}\n` +
      `Epoch price: Binance REST API\nCurrent price: Chainlink RTDS WebSocket`,
  );

  // Rate limiting for Gamma API scans
  let lastScanTime = 0;
  const SCAN_INTERVAL_MS = 2000; // Scan every 2 seconds
  let lastStatusLogTime = 0;
  const STATUS_LOG_INTERVAL_MS = 60000; // Log bot status summary every 60s

  // Main event loop
  while (true) {
    try {
      const now = Date.now();

      // Periodic status summary log
      if (now - lastStatusLogTime >= STATUS_LOG_INTERVAL_MS) {
        lastStatusLogTime = now;
        const activePos = ctx.activePositions.filter((p) => p.state !== "DONE");
        const posDetails =
          activePos.length > 0
            ? activePos.map((p) => `${p.id}[${p.state}]`).join(", ")
            : "none";
        const wsMarketState =
          ctx.marketWs?.readyState === WebSocket.OPEN ? "OPEN" : "CLOSED";
        const wsCryptoState =
          ctx.cryptoWs?.readyState === WebSocket.OPEN ? "OPEN" : "CLOSED";
        const cryptoPrices = CONFIG.ASSETS.map((a) => {
          const p = getCryptoPrice(ctx, a);
          return `${a.toUpperCase()}=${p ? "$" + p.toFixed(2) : "N/A"}`;
        }).join(", ");
        console.log(
          `[STATUS] epoch=${ctx.currentEpoch}, positions=[${posDetails}], processed=${ctx.processedConditionIds.size}, ` +
            `marketWS=${wsMarketState}, cryptoWS=${wsCryptoState}, subscribed=${ctx.subscribedTokenIds.size} tokens, ` +
            `prices: ${cryptoPrices}, PnL=$${metrics.totalPnL.toFixed(2)}, W=${metrics.winCount}/L=${metrics.lossCount}`,
        );
      }

      // Phase 1: Epoch management - snapshot prices from Binance at 5-min boundaries
      await handleNewEpoch(ctx);

      // Phase 2: Scan for new buy opportunities (rate limited)
      if (now - lastScanTime >= SCAN_INTERVAL_MS) {
        lastScanTime = now;
        await scanForOpportunities(ctx);
      }

      // Phase 3: Tick each active position's state machine
      for (const pos of ctx.activePositions) {
        if (pos.state !== "DONE") {
          await tickPosition(ctx, pos);
        }
      }

      // Phase 4: Cleanup completed positions
      await cleanupDonePositions(ctx);

      // Sleep before next tick
      await sleep(CONFIG.MAIN_LOOP_TICK_MS);
    } catch (error: any) {
      console.error("[MAIN] Unexpected error in main loop:", error);
      await sleep(5000);
    }
  }
}

main().catch((error) => {
  console.error("[FATAL] Bot crashed:", error);
  process.exit(1);
});
