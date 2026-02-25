import { ClobClient } from "@polymarket/clob-client";
import { Wallet, Contract, constants } from "ethers"; // v5.8.0
import * as dotenv from "dotenv";
import { Side } from "@polymarket/clob-client";
import { OrderType } from "@polymarket/clob-client";
import { AssetType } from "@polymarket/clob-client";
import WebSocket from "ws";
import axios from "axios";

dotenv.config();

// ============================================================================
// CONTRACT ADDRESSES (Polygon Mainnet)
// ============================================================================
const POLYGON_CONTRACTS = {
  exchange: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  negRiskExchange: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  negRiskAdapter: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
  conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  collateral: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e
};

// Minimal ABI for ERC1155 setApprovalForAll
const CTF_ABI = [
  {
    constant: false,
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    name: "setApprovalForAll",
    outputs: [],
    type: "function",
  },
  {
    constant: true,
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    name: "isApprovedForAll",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
];

// Minimal ABI for ERC20 approve
const ERC20_ABI = [
  {
    constant: false,
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    type: "function",
  },
];

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================
const CONFIG = {
  TRAP_PRICE: 0.4, // Price for initial limit orders (cheap liquidity traps)
  BASE_SIZE: 5, // Number of shares per trap order
  MIN_PROFIT_USD: 0.7, // Target profit to secure during hedge
  MAX_HEDGE_PRICE: 0.85, // Safety cap - abort if opposing side too expensive
  WATCH_INTERVAL_MS: 1100, // Poll order status every 1.1 seconds
  EXIT_PRICE: 0.97, // Price to place sell limit orders
  FLIP_TOKEN_BUY_PRICE: 0.69, // Buy more of recovering token when price exceeds this
  MAX_FLIPS_PER_MARKET: 4, // Maximum number of flips allowed per market
};

// ============================================================================
// STATE MACHINE TYPES
// ============================================================================
type BotState =
  | "START"
  | "PLACING_TRAPS"
  | "WATCHING"
  | "HEDGING"
  | "DYNAMIC_WATCHING"
  | "STOP_LOSS"
  | "DONE";

interface OrderRecord {
  orderId: string;
  tokenId: string; // Which token this order is for (from getOrder().asset_id)
  side: Side;
  originalSize: number; // The size we proposed (from getOrder().original_size)
  sizeMatched: number; // The actual filled size (from getTrades() sum of sizes)
  price: number; // The limit price we set (from getOrder().price) - NOT the execution price
  avgFillPrice: number; // The actual weighted avg execution price (from getTrades().price)
  totalCost: number; // The actual USDC cost (sum of trade.size * trade.price across all fills)
  status: string;
  outcome: string; // "Up" or "Down" (from getOrder().outcome)
}

// WebSocket price cache for real-time hedge pricing
interface PriceCache {
  [tokenId: string]: {
    bestBid: number;
    bestAsk: number;
    lastUpdate: number;
  };
}

interface BotContext {
  client: ClobClient;
  market: any;
  conditionId: string; // Store condition ID for getMarket calls
  lastConditionId: string; // Track last market's condition ID to prevent reinvestment
  yesTokenId: string; // Token ID for YES outcome
  noTokenId: string; // Token ID for NO outcome
  trapOrders: OrderRecord[];
  filledOrder: OrderRecord | null; // Which trap filled
  filledTokenId: string | null; // Track filled token explicitly
  oppositeTokenId: string | null; // The token to hedge with
  hedgeOrderId: string | null;
  hedgeSize: number; // Track hedge size for profit taking
  hedgePrice: number; // Track initial hedge price
  state: BotState;
  // WebSocket for real-time price updates
  priceWs: WebSocket | null;
  priceCache: PriceCache;
  // Dynamic flipping tracking
  totalInvested: number; // Running total USDC spent this market
  yesShares: number; // Total YES shares owned
  noShares: number; // Total NO shares owned
  currentWinningSide: "YES" | "NO" | null; // Which side is currently winning
  flipCount: number; // Number of flips executed this market
  yesSellOrderId: string | null; // Active sell order ID for YES token
  noSellOrderId: string | null; // Active sell order ID for NO token
  exitOrderId: string | null; // Active exit order ID (placed when bid > 0.90)
  exitOrderSide: "YES" | "NO" | null; // Which side the exit order is for
}

// ============================================================================
// TRADING METRICS & TELEGRAM INTEGRATION
// ============================================================================
interface TradingMetrics {
  totalInvested: number; // Total USDC deployed
  totalPnL: number; // Total profit/loss
  winCount: number; // Number of successful hedges
  lossCount: number; // Number of failed/stopped trades
  cycleCount: number; // Total cycles completed
  currentTrades: Array<{
    market: string;
    trapPrice: number;
    trapSize: number;
    hedgePrice?: number;
    hedgeSize?: number;
    status: "OPEN" | "HEDGED" | "RESOLVED" | "STOP_LOSS";
    pnl?: number;
  }>;
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const metrics: TradingMetrics = {
  totalInvested: 0,
  totalPnL: 0,
  winCount: 0,
  lossCount: 0,
  cycleCount: 0,
  currentTrades: [],
};

// ============================================================================
// HELPER: HEDGE MATH CALCULATION
// ============================================================================
function calculateHedgeSize(
  initialCost: number,
  hedgePrice: number,
  targetProfit: number,
): number {
  // Math Derivation:
  // Revenue = HedgeSize * $1.00 (since binary token settles to $0 or $1)
  // TotalCost = InitialCost + (HedgeSize * HedgePrice)
  // Revenue - TotalCost = TargetProfit
  // HedgeSize - (InitialCost + HedgeSize * HedgePrice) = TargetProfit
  // HedgeSize * (1 - HedgePrice) = InitialCost + TargetProfit
  // HedgeSize = (InitialCost + TargetProfit) / (1 - HedgePrice)

  if (hedgePrice >= 1.0) {
    throw new Error("Hedge price must be less than 1.0");
  }

  const calculatedSize = Math.ceil(
    (initialCost + targetProfit) / (1 - hedgePrice),
  );

  // Polymarket minimum order size is 5 shares
  const MIN_ORDER_SIZE = 5;
  return Math.max(calculatedSize, MIN_ORDER_SIZE);
}

// ============================================================================
// HELPER: FLIP AMOUNT CALCULATION
// When the "losing" token starts recovering (price > FLIP_TOKEN_BUY_PRICE),
// we buy more of it to ensure profit regardless of which side wins.
// ============================================================================
function calculateFlipAmount(
  totalInvested: number,
  currentTokenShares: number,
  buyPrice: number,
  minProfit: number,
): number {
  // Math Derivation:
  // After flip, if THIS token wins:
  //   Revenue = (currentShares + X) * $1.00
  //   Cost = totalInvested + (X * buyPrice)
  //   Profit = Revenue - Cost >= minProfit
  //   currentShares + X - totalInvested - X*buyPrice >= minProfit
  //   X * (1 - buyPrice) >= minProfit + totalInvested - currentShares
  //   X >= (minProfit + totalInvested - currentShares) / (1 - buyPrice)

  if (buyPrice >= 1.0) {
    throw new Error("Buy price must be less than 1.0");
  }

  const numerator = minProfit + totalInvested - currentTokenShares;
  const denominator = 1 - buyPrice;

  // If numerator is negative, we already have enough shares - no flip needed
  if (numerator <= 0) {
    console.log(
      `[FLIP CALC] No flip needed: currentShares=${currentTokenShares} already covers totalInvested=${totalInvested} + profit=${minProfit}`,
    );
    return 0;
  }

  const calculatedSize = Math.ceil(numerator / denominator);

  // Polymarket minimum order size is 5 shares
  const MIN_ORDER_SIZE = 5;
  return Math.max(calculatedSize, MIN_ORDER_SIZE);
}

// ============================================================================
// HELPER: SLEEP FUNCTION
// ============================================================================
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// HELPER: GET POSITION DETAILS FROM POSITIONS API
// Uses the Polymarket Data API to get current position details for a specific token.
// This is more reliable than getTrades() which returns the entire trade (all participants).
// API: GET https://data-api.polymarket.com/positions?user={address}&market={conditionId}
// NOTE: Positions don't appear instantly - the API has a delay, so we poll with retries.
// ============================================================================
async function getPositionDetails(
  conditionId: string,
  tokenId: string,
  maxRetries: number = 4,
  retryDelayMs: number = 2000,
): Promise<{ size: number; avgPrice: number; totalCost: number } | null> {
  const userAddress = process.env.FUNDER_ADDRESS;

  if (!userAddress) {
    console.error("[POSITION] FUNDER_ADDRESS not set in environment");
    return null;
  }

  // Build URL with all required params (matching working curl command)
  const url = new URL("https://data-api.polymarket.com/positions");
  url.searchParams.set("user", userAddress);
  url.searchParams.set("market", conditionId);
  url.searchParams.set("sizeThreshold", "0"); // Include all positions, even tiny ones
  url.searchParams.set("limit", "100");
  url.searchParams.set("sortBy", "TOKENS");
  url.searchParams.set("sortDirection", "DESC");

  console.log(
    `[POSITION] Fetching positions for user ${userAddress.slice(0, 10)}... market ${conditionId.slice(0, 10)}...`,
  );
  console.log(
    `[POSITION] Will retry up to ${maxRetries} times with ${retryDelayMs}ms delay between attempts`,
  );

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[POSITION] Attempt ${attempt}/${maxRetries}...`);

      const response = await axios.get(url.toString());
      const positions = response.data;

      if (!Array.isArray(positions)) {
        console.warn(`[POSITION] Invalid response format (not an array)`);
        await sleep(retryDelayMs);
        continue;
      }

      if (positions.length === 0) {
        console.log(
          `[POSITION] No positions yet, waiting ${retryDelayMs}ms before retry...`,
        );
        await sleep(retryDelayMs);
        continue;
      }

      // Find the position matching our specific token (asset)
      const position = positions.find((p: any) => p.asset === tokenId);

      if (!position) {
        console.log(
          `[POSITION] Position for token ${tokenId.slice(0, 10)}... not found yet`,
        );
        console.log(
          `[POSITION] Available positions:`,
          positions.map((p: any) => ({
            asset: p.asset?.slice(0, 10) + "...",
            size: p.size,
            outcome: p.outcome,
          })),
        );
        await sleep(retryDelayMs);
        continue;
      }

      // Found the position!
      const size = parseFloat(position.size) || 0;
      const avgPrice = parseFloat(position.avgPrice) || 0;
      const totalCost = parseFloat(position.initialValue) || size * avgPrice;

      console.log(
        `[POSITION] Found position for token ${tokenId.slice(0, 10)}... on attempt ${attempt}:`,
      );
      console.log(`[POSITION]   Size: ${size} shares`);
      console.log(`[POSITION]   Avg Price: $${avgPrice.toFixed(4)}`);
      console.log(
        `[POSITION]   Total Cost (initialValue): $${totalCost.toFixed(4)}`,
      );
      console.log(`[POSITION]   Outcome: ${position.outcome}`);
      console.log(`[POSITION]   Total Bought: ${position.totalBought}`);

      return { size, avgPrice, totalCost };
    } catch (error: any) {
      console.error(
        `[POSITION] Error on attempt ${attempt}:`,
        error.message || error,
      );
      if (attempt < maxRetries) {
        await sleep(retryDelayMs);
      }
    }
  }

  console.error(
    `[POSITION] Failed to fetch position after ${maxRetries} attempts`,
  );
  return null;
}

// ============================================================================
// HELPER: GET ALL USER POSITIONS FROM POSITIONS API
// Returns all positions for the user, useful for finding which token has shares
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
    console.error("[GET_POSITIONS] FUNDER_ADDRESS not set in environment");
    return [];
  }

  const url = new URL("https://data-api.polymarket.com/positions");
  url.searchParams.set("user", userAddress);
  url.searchParams.set("sizeThreshold", "1");
  url.searchParams.set("limit", "100");
  url.searchParams.set("sortBy", "TOKENS");
  url.searchParams.set("sortDirection", "DESC");

  // Optionally filter by market
  if (conditionId) {
    url.searchParams.set("market", conditionId);
  }

  try {
    console.log(
      `[GET_POSITIONS] Fetching positions for ${userAddress.slice(0, 10)}...`,
    );
    const response = await axios.get(url.toString());
    const positions = response.data;

    if (!Array.isArray(positions)) {
      console.warn(`[GET_POSITIONS] Invalid response format`);
      return [];
    }

    return positions.map((p: any) => ({
      asset: p.asset,
      conditionId: p.conditionId,
      size: parseFloat(p.size) || 0,
      avgPrice: parseFloat(p.avgPrice) || 0,
      outcome: p.outcome,
      curPrice: parseFloat(p.curPrice) || 0,
    }));
  } catch (error: any) {
    console.error(`[GET_POSITIONS] Error:`, error.message || error);
    return [];
  }
}

// ============================================================================
// TELEGRAM NOTIFICATION FUNCTIONS
// ============================================================================
async function sendTelegramMessage(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ [TELEGRAM] Credentials not configured. Skipping message.");
    console.warn(`   BOT_TOKEN: ${TELEGRAM_BOT_TOKEN ? "✓ Set" : "✗ Missing"}`);
    console.warn(`   CHAT_ID: ${TELEGRAM_CHAT_ID ? "✓ Set" : "✗ Missing"}`);
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    console.log("[TELEGRAM] Sending message...");

    const response = await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
    });

    console.log("✅ [TELEGRAM] Message sent successfully!");
  } catch (error: any) {
    console.error(
      "❌ [TELEGRAM] Failed to send. Status:",
      error.response?.status,
    );
    console.error("   Response:", error.response?.data || error.message);
  }
}

async function sendTradeNotification(
  market: string,
  trapPrice: number,
  trapSize: number,
  outcome: string,
): Promise<void> {
  const potentialCost = trapSize * trapPrice;

  const message = `
🎯 <b>TRAP PLACED</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Market: ${market}
🎲 Outcome: <b>${outcome}</b>
💰 Price: $${trapPrice.toFixed(2)}
📈 Size: ${trapSize} shares
💵 Potential Cost: $${potentialCost.toFixed(2)} (if filled)

⏳ Waiting for order to be filled...
  `.trim();

  await sendTelegramMessage(message);
}

async function sendHedgeNotification(
  hedgePrice: number,
  hedgeSize: number,
  expectedProfit: number,
): Promise<void> {
  const hedgeCost = hedgeSize * hedgePrice;
  const message = `
    🛡️ <b>HEDGE PLACED</b>
    ━━━━━━━━━━━━━━━━━━━━━━━━━━
    💰 Hedge Price: $${hedgePrice.toFixed(2)}
    📈 Hedge Size: ${hedgeSize} shares
    💵 Hedge Cost: $${hedgeCost.toFixed(2)}
    🎯 Expected Profit: <b>+$${expectedProfit.toFixed(2)}</b>

    ✅ Position is now DELTA-NEUTRAL
    PROFIT GUARANTEED in BOTH outcomes!
  `.trim();

  await sendTelegramMessage(message);
}

async function sendPnLNotification(
  market: string,
  outcome: string,
  trapPrice: number,
  trapSize: number,
  hedgePrice: number,
  hedgeSize: number,
  marketResult: "WIN" | "LOSS" | "PARTIAL",
  pnl: number,
): Promise<void> {
  const trapInvested = trapSize * trapPrice;
  const hedgeInvested = hedgeSize * hedgePrice;
  const totalInvested = trapInvested + hedgeInvested;

  metrics.totalPnL += pnl;
  if (pnl > 0) {
    metrics.winCount++;
  } else {
    metrics.lossCount++;
  }

  const message = `
📊 <b>TRADE RESOLVED</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 Market: ${market}
🎲 Trap Outcome: ${outcome}
📉 Market Result: <b>${marketResult}</b>

💵 Investment Details:
• Trap: ${trapSize} @ $${trapPrice.toFixed(2)} = $${trapInvested.toFixed(2)}
• Hedge: ${hedgeSize} @ $${hedgePrice.toFixed(2)} = $${hedgeInvested.toFixed(2)}
• Total: $${totalInvested.toFixed(2)}

💰 <b>PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</b>
ROI: ${((pnl / totalInvested) * 100).toFixed(1)}%

📊 <b>PORTFOLIO</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Invested: $${metrics.totalInvested.toFixed(2)}
Total PnL: <b>${metrics.totalPnL >= 0 ? "+" : ""}$${metrics.totalPnL.toFixed(2)}</b>
Wins: ${metrics.winCount} | Losses: ${metrics.lossCount}
Win Rate: ${((metrics.winCount / (metrics.winCount + metrics.lossCount)) * 100).toFixed(1)}%
  `.trim();

  await sendTelegramMessage(message);
}

async function sendStatsNotification(): Promise<void> {
  const message = `
📊 <b>BOT STATISTICS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 Cycles Completed: ${metrics.cycleCount}
✅ Successful Hedges: ${metrics.winCount}
❌ Stopped Losses: ${metrics.lossCount}

💰 <b>FINANCIAL SUMMARY</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Deployed: $${metrics.totalInvested.toFixed(2)}
Total PnL: <b>${metrics.totalPnL >= 0 ? "+" : ""}$${metrics.totalPnL.toFixed(2)}</b>
Avg Profit/Trade: $${(metrics.totalPnL / (metrics.winCount + metrics.lossCount) || 0).toFixed(2)}
Total ROI: ${((metrics.totalPnL / (metrics.totalInvested || 1)) * 100).toFixed(1)}%
  `.trim();

  await sendTelegramMessage(message);
}

// ============================================================================
// PHASE 0: ENSURE APPROVALS FOR SELLING TOKENS
// Polymarket requires TWO types of approvals:
// 1. USDC allowance to Exchange (for BUY orders) - you likely have this
// 2. Conditional Token approval (setApprovalForAll) to Exchange (for SELL orders)
// Without #2, SELL orders will fail with "not enough balance / allowance"
// ============================================================================
async function ensureApprovals(
  signer: Wallet,
  isNegRisk: boolean = false,
): Promise<void> {
  console.log("\n[APPROVALS] Checking onchain approvals for selling tokens...");

  // Connect signer to Polygon RPC (use env var or fallback to reliable public RPC)
  const rpcUrl = process.env.RPC_URL || "https://rpc.ankr.com/polygon";
  console.log(`[APPROVALS] Using RPC: ${rpcUrl}`);
  const provider = new (await import("ethers")).providers.JsonRpcProvider(
    rpcUrl,
  );
  const connectedSigner = signer.connect(provider);

  const ctfContract = new Contract(
    POLYGON_CONTRACTS.conditionalTokens,
    CTF_ABI,
    connectedSigner,
  );

  // Determine which exchange to approve based on market type
  const exchangeAddress = isNegRisk
    ? POLYGON_CONTRACTS.negRiskExchange
    : POLYGON_CONTRACTS.exchange;

  console.log(`[APPROVALS] Checking approval for Exchange: ${exchangeAddress}`);
  console.log(
    `[APPROVALS] CTF Contract: ${POLYGON_CONTRACTS.conditionalTokens}`,
  );
  console.log(
    `[APPROVALS] Signer address: ${await connectedSigner.getAddress()}`,
  );

  try {
    // Check if already approved
    const isApproved = await ctfContract.isApprovedForAll(
      await connectedSigner.getAddress(),
      exchangeAddress,
    );

    console.log(`[APPROVALS] Current approval status: ${isApproved}`);

    if (!isApproved) {
      console.log(
        "[APPROVALS] Setting approval for Exchange to transfer conditional tokens...",
      );
      const tx = await ctfContract.setApprovalForAll(exchangeAddress, true, {
        gasPrice: 50_000_000_000, // 50 gwei
        gasLimit: 100_000,
      });
      console.log(`[APPROVALS] Approval transaction sent: ${tx.hash}`);
      console.log("[APPROVALS] Waiting for confirmation...");
      await tx.wait();
      console.log("[APPROVALS] Approval confirmed!");
    } else {
      console.log("[APPROVALS] Already approved - no action needed");
    }

    // Also check neg risk exchange if using standard exchange
    if (!isNegRisk) {
      const isNegRiskApproved = await ctfContract.isApprovedForAll(
        await connectedSigner.getAddress(),
        POLYGON_CONTRACTS.negRiskExchange,
      );

      if (!isNegRiskApproved) {
        console.log("[APPROVALS] Setting approval for NegRisk Exchange...");
        const tx = await ctfContract.setApprovalForAll(
          POLYGON_CONTRACTS.negRiskExchange,
          true,
          {
            gasPrice: 50_000_000_000,
            gasLimit: 100_000,
          },
        );
        console.log(`[APPROVALS] NegRisk approval transaction: ${tx.hash}`);
        await tx.wait();
        console.log("[APPROVALS] NegRisk approval confirmed!");
      }
    }
  } catch (error) {
    console.error("[APPROVALS] Error setting approval:", error);
    throw error;
  }
}

// ============================================================================
// PHASE 1: CLIENT INITIALIZATION
// ============================================================================
async function initializeClient() {
  const HOST = "https://clob.polymarket.com";
  const CHAIN_ID = 137; // Polygon mainnet
  const signer = new Wallet(process.env.PRIVATE_KEY!);

  // CRITICAL: Ensure approvals are set before trading
  // This allows the Exchange to transfer our conditional tokens when selling
  // await ensureApprovals(signer, false);

  // Phase 1: Create minimal client to derive API credentials
  const tempClient = new ClobClient(HOST, CHAIN_ID, signer);
  const userApiCreds = await tempClient.deriveApiKey();
  console.log("THE RESPONSE IS", userApiCreds);

  console.log("API Key:", userApiCreds.key);
  console.log("Secret:", userApiCreds.secret);
  console.log("Passphrase:", userApiCreds.passphrase);

  // Phase 2: Reinitialize with full authentication
  // Signature types: 0 = EOA, 1 = POLY_PROXY, 2 = GNOSIS_SAFE
  const SIGNATURE_TYPE = 1; // Poly Proxy

  const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS; // For EOA, funder is your wallet
  console.log("THE FUNDER ADDDRESS IS,", FUNDER_ADDRESS);

  const client = new ClobClient(
    HOST,
    CHAIN_ID,
    signer,
    userApiCreds,
    SIGNATURE_TYPE,
    FUNDER_ADDRESS,
  );

  console.log("Client initialized successfully!");

  // CRITICAL: Tell CLOB server to refresh its view of our allowances
  // This syncs the on-chain approval status with the CLOB backend
  try {
    console.log("[INIT] Syncing allowances with CLOB server...");
    await client.updateBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
    });
    console.log("[INIT] Allowances synced successfully!");
  } catch (error) {
    console.warn(
      "[INIT] Warning: Could not sync allowances with CLOB server:",
      error,
    );
    // Don't throw - this is not critical for initialization
  }

  // Now you can use `client` to place orders, check balances, etc.
  return client;
}

// ============================================================================
// WEBSOCKET: Real-time price streaming for instant hedge pricing
// Instead of polling getMarket() which has ~100-500ms latency,
// we maintain a live WebSocket connection that streams price updates.
// This gives us the most accurate price at the moment we need to hedge.
// ============================================================================
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

function startPriceWebSocket(ctx: BotContext): void {
  if (ctx.priceWs) {
    console.log("[WS] WebSocket already connected, skipping...");
    return;
  }

  const tokenIds = [ctx.yesTokenId as string, ctx.noTokenId as string];
  console.log("The token ids are", tokenIds);
  if (tokenIds.length === 0) {
    console.warn("[WS] No token IDs available, cannot start WebSocket");
    return;
  }

  console.log(
    `[WS] Connecting to Polymarket WebSocket for real-time prices...`,
  );
  // console.log(`[WS] Subscribing to tokens: ${tokenIds.join(",   ")}...`);

  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("[WS] Connected! Subscribing to market updates...");

    // Subscribe to both tokens with custom_feature_enabled for best_bid_ask events
    ws.send(
      JSON.stringify({
        type: "market",
        assets_ids: tokenIds,
        custom_feature_enabled: true, // Enables best_bid_ask events
      }),
    );
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Handle price_change events - these contain best_bid/best_ask for all tokens
      if (msg.event_type === "price_change" && msg.price_changes) {
        for (const change of msg.price_changes) {
          // Each change has: asset_id, best_bid, best_ask, price, size, side
          if (
            change.asset_id &&
            (change.best_bid !== undefined || change.best_ask !== undefined)
          ) {
            const bestBid = parseFloat(change.best_bid) || 0;
            const bestAsk = parseFloat(change.best_ask) || 1;

            // IMPORTANT: Ignore empty market prices (bid=0, ask=1 means no real liquidity)
            const isEmptyMarket = bestBid <= 0.02 && bestAsk >= 0.98;
            if (isEmptyMarket) {
              // Don't log every empty market update - too spammy
              continue;
            }

            ctx.priceCache[change.asset_id] = {
              bestBid,
              bestAsk,
              lastUpdate: Date.now(),
            };
          }
        }
      }
    } catch (err) {
      // Ignore parse errors for non-JSON messages (like ping/pong)
      console.log("[WS] error", err);
    }
  });

  ws.on("error", (err) => {
    console.error("[WS] WebSocket error:", err.message);
  });

  ws.on("close", (code, reason) => {
    console.log(`[WS] WebSocket closed: ${code} - ${reason}`);
    ctx.priceWs = null;

    // Auto-reconnect if we're still in a state that needs prices
    if (
      ctx.state === "WATCHING" ||
      ctx.state === "HEDGING" ||
      ctx.state === "DYNAMIC_WATCHING"
    ) {
      console.log("[WS] Reconnecting in 2 seconds...");
      setTimeout(() => startPriceWebSocket(ctx), 2000);
    }
  });

  ctx.priceWs = ws;
}

function stopPriceWebSocket(ctx: BotContext): void {
  if (ctx.priceWs) {
    console.log("[WS] Closing WebSocket connection...");
    ctx.priceWs.close();
    ctx.priceWs = null;
  }
}

// Resubscribe WebSocket to new market tokens (called when entering a new market)
// This unsubscribes from old tokens, clears cache, and subscribes to new tokens
function resubscribeWebSocket(
  ctx: BotContext,
  oldYesToken?: string,
  oldNoToken?: string,
): void {
  if (!ctx.priceWs || ctx.priceWs.readyState !== WebSocket.OPEN) {
    console.log(
      "[WS] WebSocket not connected, will subscribe when it connects",
    );
    // Clear stale cache from previous market
    ctx.priceCache = {};
    return;
  }

  const newTokenIds = [ctx.yesTokenId, ctx.noTokenId].filter(Boolean);
  const oldTokenIds = [oldYesToken, oldNoToken].filter(Boolean);

  // Unsubscribe from old tokens first
  if (oldTokenIds.length > 0) {
    console.log(
      `[WS] Unsubscribing from old market tokens: ${oldTokenIds[0]?.slice(0, 8)}...`,
    );
    ctx.priceWs.send(
      JSON.stringify({
        assets_ids: oldTokenIds,
        operation: "unsubscribe",
      }),
    );
  }

  // Clear price cache to remove stale prices from old market
  console.log("[WS] Clearing price cache for new market...");
  ctx.priceCache = {};

  // Subscribe to new tokens
  if (newTokenIds.length > 0) {
    console.log(
      `[WS] Subscribing to new market tokens: ${newTokenIds[0]?.slice(0, 8)}...`,
    );
    ctx.priceWs.send(
      JSON.stringify({
        assets_ids: newTokenIds,
        operation: "subscribe",
      }),
    );
  }
}

function getCachedPrice(
  ctx: BotContext,
  tokenId: string,
): { bestBid: number; bestAsk: number; age: number } | null {
  const cached = ctx.priceCache[tokenId];
  if (!cached) return null;

  // CRITICAL: Validate that this token belongs to the current market
  // This prevents using stale prices from a previous market
  if (tokenId !== ctx.yesTokenId && tokenId !== ctx.noTokenId) {
    console.warn(
      `[WS] Rejecting cached price for ${tokenId.slice(0, 8)}... - not in current market`,
    );
    return null;
  }

  return {
    bestBid: cached.bestBid,
    bestAsk: cached.bestAsk,
    age: Date.now() - cached.lastUpdate,
  };
}

// ============================================================================
// STATE: START - Identify market and cancel stale orders
// ============================================================================
async function handleStart(ctx: BotContext): Promise<BotState> {
  console.log("\n[START] Identifying current market...");

  // 🔴 CRITICAL: Keep trying until we get a DIFFERENT market (not the same as last cycle)
  let market = null;
  let attempts = 0;
  const maxAttempts = 200; // Try for up to ~1000 seconds (with 5sec retry interval)

  while (!market || market.conditionId === ctx.lastConditionId) {
    attempts++;

    if (attempts > maxAttempts) {
      console.error(
        "[START] ❌ CRITICAL: Could not find a NEW market after many attempts. The market may not be rotating. Aborting.",
      );
      return "DONE"; // Exit the bot
    }

    market = await getMarketInfo("btc-updown-15m");

    if (!market) {
      console.error("[START] Failed to find market. Retrying in 5 seconds...");
      await sleep(5000);
      continue;
    }

    // Check if this is the SAME market as last cycle
    if (market.conditionId === ctx.lastConditionId) {
      console.warn(
        `[START] ⚠️ Got same market again (conditionId: ${market.conditionId}). Retrying in 5 seconds...`,
      );
      await sleep(5000);
      market = null; // Reset to trigger retry
      continue;
    }

    // NEW market found!
    console.log(`[START] ✅ Found NEW market!`);
    console.log(`  Previous conditionId: ${ctx.lastConditionId}`);
    console.log(`  Current conditionId: ${market.conditionId}`);
    break;
  }

  ctx.market = market;

  // 🔴 CRITICAL: Store this market's conditionId immediately to prevent reinvestment
  ctx.lastConditionId = market.conditionId;
  console.log(
    `[START] 🔒 Locked market conditionId: ${ctx.lastConditionId} - Will not reinvest in this market`,
  );

  // Extract condition ID directly from market object
  // Gamma API returns array of markets, first element contains conditionId at top level
  if (market.conditionId) {
    console.log("the market id is", market.conditionId);
    ctx.conditionId = market.conditionId;
  } else {
    console.error("[START] Could not extract conditionId from market response");
    await sleep(5000);
    return "START";
  }

  // Parse clobTokenIds from Gamma API response
  // clobTokenIds is a JSON string array: "[\"id1\", \"id2\"]"
  let tokenIds: string[] = [];
  try {
    tokenIds = JSON.parse(market.clobTokenIds);
    if (!Array.isArray(tokenIds) || tokenIds.length !== 2) {
      throw new Error("Expected 2 token IDs");
    }
  } catch (error) {
    console.error("[START] Failed to parse clobTokenIds:", error);
    await sleep(5000);
    return "START";
  }

  // Store old token IDs before updating (for WebSocket resubscription)
  const oldYesToken = ctx.yesTokenId;
  const oldNoToken = ctx.noTokenId;

  ctx.yesTokenId = tokenIds[0]; // First token = YES
  ctx.noTokenId = tokenIds[1]; // Second token = NO

  console.log(`[START] Found market: ${market.slug}`);
  console.log(`[START] Condition ID: ${ctx.conditionId}`);
  console.log(`[START] YES Token ID: ${ctx.yesTokenId}`);
  console.log(`[START] NO Token ID: ${ctx.noTokenId}`);

  // NOTE: No wait - place traps immediately at market start when both tokens are ~$0.50
  // This ensures we know exact trap fill price (CONFIG.TRAP_PRICE) for instant hedge calculation
  console.log(`[START] Placing traps immediately (no stabilization wait)`);

  // CRITICAL: Start or resubscribe WebSocket to new market tokens EARLY
  // This gives time for the WebSocket to connect and receive initial book snapshots
  // before a trap potentially fills
  if (ctx.priceWs && ctx.priceWs.readyState === WebSocket.OPEN) {
    // Already connected - just resubscribe to new tokens
    resubscribeWebSocket(ctx, oldYesToken, oldNoToken);
  } else {
    // Not connected - start fresh connection
    ctx.priceCache = {}; // Clear any stale cache
    startPriceWebSocket(ctx);
  }
  await sleep(5000);

  // Cancel any stale orders from previous rounds
  try {
    // Query order book for YES token (either would work, just need a reference)
    const orderBook = await ctx.client.getOrderBook(ctx.yesTokenId);
    // Note: getOrderBook shows market state, individual order fetching requires getOrder(orderID)
    // For this implementation, we'll skip stale order cleanup
    // In production, maintain order IDs in state to cancel them specifically
  } catch (error) {
    console.warn("[START] Could not fetch market book:", error);
  }

  return "PLACING_TRAPS";
}

// ============================================================================
// STATE: PLACING_TRAPS - Post two GTC limit orders
// ============================================================================
async function handlePlacingTraps(ctx: BotContext): Promise<BotState> {
  console.log(
    "\n[PLACING_TRAPS] Placing trap orders at price $" + CONFIG.TRAP_PRICE,
  );

  try {
    // Prepare trap order parameters for YES and NO tokens
    // CRITICAL: These must be different tokens!
    const trapOrderParams = [
      {
        tokenId: ctx.yesTokenId,
        side: Side.BUY,
        price: CONFIG.TRAP_PRICE,
        size: CONFIG.BASE_SIZE,
        outcome: "YES",
      },
      {
        tokenId: ctx.noTokenId,
        side: Side.BUY,
        price: CONFIG.TRAP_PRICE,
        size: CONFIG.BASE_SIZE,
        outcome: "NO",
      },
    ];

    const trapPromises = trapOrderParams.map(async (param) => {
      const response = await ctx.client.createAndPostOrder(
        {
          tokenID: param.tokenId, // DIFFERENT TOKEN FOR EACH ORDER
          price: param.price,
          size: param.size,
          side: param.side,
        },
        {
          tickSize: ctx.market.tickSize,
          negRisk: ctx.market.negRisk,
        },
        OrderType.GTC,
      );

      const order: OrderRecord = {
        orderId: response.orderID,
        tokenId: "", // Will be populated from getOrder() after fill
        side: Side.BUY, // Will be populated from getOrder() after fill
        originalSize: 0, // Will be populated from getOrder().original_size after fill
        sizeMatched: 0, // Will be populated from getTrades() (actual filled qty) after fill
        price: 0, // Will be populated from getOrder().price (limit price only) after fill
        avgFillPrice: 0, // Will be populated from getTrades() (actual execution price) after fill
        totalCost: 0, // Will be populated from getTrades() (actual USDC cost) after fill
        status: response.status,
        outcome: param.outcome, // YES or NO - we know this at placement time
      };

      console.log(
        `[PLACING_TRAPS] Placed ${param.outcome} trap order: ${order.orderId} (proposed $${param.price} x ${param.size})`,
      );

      return order;
    });

    ctx.trapOrders = await Promise.all(trapPromises);

    // Send Telegram notifications for each trap
    for (const order of ctx.trapOrders) {
      await sendTradeNotification(
        ctx.market.slug,
        CONFIG.TRAP_PRICE,
        CONFIG.BASE_SIZE,
        order.outcome,
      );
    }

    return "WATCHING";
  } catch (error) {
    console.error("[PLACING_TRAPS] Failed to place traps:", error);
    await sleep(5000);
    return "PLACING_TRAPS";
  }
}

// ============================================================================
// STATE: WATCHING - Poll orders every 2 seconds until one fills
// ============================================================================
async function handleWatching(ctx: BotContext): Promise<BotState> {
  console.log("[WATCHING] Monitoring orders for fills...");
  console.log(
    `[WATCHING] Trap Orders: YES=${ctx.trapOrders[0]?.orderId}, NO=${ctx.trapOrders[1]?.orderId}`,
  );

  // WebSocket should already be connected from handleStart
  // Just verify it's still connected, reconnect if needed
  if (!ctx.priceWs || ctx.priceWs.readyState !== WebSocket.OPEN) {
    console.log("[WATCHING] WebSocket not connected, starting...");
    startPriceWebSocket(ctx);
  }

  const startTime = Date.now();
  const MAX_WATCH_TIME = 900000; // 15 minutes (full market duration)
  let lastLogTime = startTime;

  while (true) {
    const elapsed = Date.now() - startTime;

    // Safety timeout after 15 minutes
    if (elapsed > MAX_WATCH_TIME) {
      console.log(
        `[WATCHING] ⏱️ Maximum watch time (${MAX_WATCH_TIME}ms) exceeded. Exiting watch state.`,
      );
      return "DONE";
    }

    try {
      let yesStatus = "UNKNOWN";
      let noStatus = "UNKNOWN";
      let filledOrder = null;

      // Poll each trap order individually
      for (const trapOrder of ctx.trapOrders) {
        try {
          const order = await ctx.client.getOrder(trapOrder.orderId);

          if (!order) {
            console.warn(`[WATCHING] Order not found: ${trapOrder.orderId}`);
            continue;
          }

          // Log the complete order object for debugging
          console.log(
            `[WATCHING] [${trapOrder.outcome}] Full order response:`,
            JSON.stringify(order, null, 2),
          );

          const orderStatus = order.status?.toUpperCase() || "UNKNOWN";

          // Track status for logging
          if (trapOrder.outcome === "YES") {
            yesStatus = orderStatus;
          } else {
            noStatus = orderStatus;
          }

          console.log(
            `[WATCHING] [${trapOrder.outcome}] Order ${trapOrder.orderId.slice(0, 8)}... status: ${orderStatus}`,
          );

          // Check if order is filled/matched/confirmed
          // MATCHED = matched by operator, sent to executor
          // MINED = mined into the chain
          // CONFIRMED = achieved finality and was successful
          if (
            orderStatus === "MATCHED" ||
            orderStatus === "MINED" ||
            orderStatus === "CONFIRMED"
          ) {
            console.log(
              `\n✅ [WATCHING] TRAP FILLED: ${trapOrder.outcome} Order! Status: ${orderStatus}`,
            );

            // 🎯 CRITICAL: Populate OrderRecord with ACTUAL values from getOrder()
            // These are the real values from the exchange, not what we proposed
            const filledOrderData = order as any;
            trapOrder.tokenId = filledOrderData.asset_id || "";
            trapOrder.side =
              filledOrderData.side?.toUpperCase() === "SELL"
                ? Side.SELL
                : Side.BUY;
            trapOrder.originalSize =
              parseFloat(filledOrderData.original_size) || 0;
            trapOrder.sizeMatched =
              parseFloat(filledOrderData.size_matched) || 0;
            trapOrder.price = parseFloat(filledOrderData.price) || 0;
            trapOrder.status = orderStatus;
            trapOrder.outcome = filledOrderData.outcome || trapOrder.outcome;

            console.log(
              `[WATCHING] Limit price from getOrder(): $${trapOrder.price}`,
            );
            console.log(
              `[WATCHING] Original size: ${trapOrder.originalSize}, Size matched: ${trapOrder.sizeMatched}`,
            );

            // FAST PATH: Use CONFIG values for immediate hedge calculation
            // Since we place traps at market start, we know the fill price = CONFIG.TRAP_PRICE
            // and size = CONFIG.BASE_SIZE. This avoids 15+ second wait for Positions API.
            // We will fetch accurate position details AFTER hedge is placed.
            trapOrder.avgFillPrice = CONFIG.TRAP_PRICE;
            trapOrder.totalCost = CONFIG.BASE_SIZE * CONFIG.TRAP_PRICE;

            console.log(
              `[WATCHING] Using CONFIG values for INSTANT hedge calculation:`,
            );
            console.log(`[WATCHING]   Token ID: ${trapOrder.tokenId}`);
            console.log(`[WATCHING]   Side: ${trapOrder.side}`);
            console.log(
              `[WATCHING]   Size: ${CONFIG.BASE_SIZE} shares (from CONFIG)`,
            );
            console.log(
              `[WATCHING]   Price: $${CONFIG.TRAP_PRICE} (from CONFIG)`,
            );
            console.log(
              `[WATCHING]   Total Cost: $${trapOrder.totalCost.toFixed(4)}`,
            );
            console.log(`[WATCHING]   Outcome: ${trapOrder.outcome}`);
            console.log(
              `[WATCHING] Proceeding to HEDGE immediately - will fetch accurate positions after!`,
            );

            ctx.filledOrder = trapOrder;
            ctx.filledTokenId = trapOrder.tokenId;
            ctx.oppositeTokenId =
              trapOrder.tokenId === ctx.yesTokenId
                ? ctx.noTokenId
                : ctx.yesTokenId;
            return "HEDGING";
          }

          // If order failed or is retrying, log it
          if (orderStatus === "FAILED") {
            console.error(`❌ [WATCHING] Order FAILED: ${trapOrder.outcome}`);
          }
          if (orderStatus === "RETRYING") {
            console.warn(`⚠️ [WATCHING] Order RETRYING: ${trapOrder.outcome}`);
          }
        } catch (err) {
          console.error(
            `[WATCHING] Error checking order ${trapOrder.orderId}:`,
            err,
          );
        }
      }

      // Log summary every 5 seconds
      if (Date.now() - lastLogTime > 5000) {
        console.log(
          `[WATCHING] [${Math.round(elapsed / 1000)}s] Status: YES=${yesStatus}, NO=${noStatus}`,
        );
        lastLogTime = Date.now();
      }

      await sleep(CONFIG.WATCH_INTERVAL_MS);
    } catch (error) {
      console.error("[WATCHING] Error in watch loop:", error);
      await sleep(CONFIG.WATCH_INTERVAL_MS);
    }
  }
}

// ============================================================================
// STATE: HEDGING - Cancel unfilled side and buy the hedge
// ============================================================================
async function handleHedging(ctx: BotContext): Promise<BotState> {
  if (!ctx.filledOrder) {
    console.error("[HEDGING] No filled order to hedge against!");
    return "DONE";
  }

  console.log("\n[HEDGING] Processing hedge for filled order...");

  // Determine the unfilled order (the opposite side)
  const unfilledOrder = ctx.trapOrders.find(
    (o) => o.orderId !== ctx.filledOrder!.orderId,
  );

  try {
    // Step 0: Record actual investment now that order is filled
    const trapCost = ctx.filledOrder.totalCost;
    metrics.totalInvested += trapCost;

    console.log(
      `[HEDGING] Trap order filled! Recording investment: ${ctx.filledOrder.sizeMatched} shares @ avg $${ctx.filledOrder.avgFillPrice.toFixed(4)} = $${trapCost.toFixed(4)} (limit was $${ctx.filledOrder.price})`,
    );

    // Step 1: Calculate hedge size before fetching prices
    const initialCost = trapCost;
    console.log(
      `[HEDGING] Initial cost (actual from trades): $${initialCost.toFixed(4)}`,
    );

    // Step 2: Get hedge price - PREFER WebSocket cached price (real-time, no latency)
    // Fall back to HTTP getMarket() only if WebSocket price is unavailable or stale
    let hedgePrice: number;
    let hedgeOutcome: string = "";
    const MAX_PRICE_AGE_MS = 3000; // Consider WebSocket price stale after 3 seconds

    // CRITICAL: Track which price source we're using - stick with it throughout hedging
    // This prevents mixing stale WS cache with fresh HTTP prices
    let useWebSocketPrices = false;

    const cachedPrice = getCachedPrice(ctx, ctx.oppositeTokenId!);

    if (cachedPrice && cachedPrice.age < MAX_PRICE_AGE_MS) {
      // Use WebSocket price - this is the best ask (price to BUY at)
      hedgePrice = cachedPrice.bestAsk;
      useWebSocketPrices = true;
      console.log(
        `[HEDGING] Using REAL-TIME WebSocket price: $${hedgePrice} (age: ${cachedPrice.age}ms, bid: $${cachedPrice.bestBid})`,
      );
    } else {
      // Fallback to HTTP polling - will use HTTP for ALL retries too
      useWebSocketPrices = false;
      console.log(
        `[HEDGING] WebSocket price unavailable or stale (age: ${cachedPrice?.age || "N/A"}ms), using HTTP for all price fetches...`,
      );
      const marketData = await ctx.client.getMarket(ctx.conditionId);
      console.log(
        `[HEDGING] Market data fetched via HTTP. Tokens:`,
        marketData.tokens,
      );

      const hedgeToken = marketData.tokens.find(
        (token: any) => token.token_id === ctx.oppositeTokenId,
      );

      if (!hedgeToken) {
        console.error(
          `[HEDGING] Could not find hedge token ${ctx.oppositeTokenId} in market data`,
        );
        return "DONE";
      }

      hedgePrice = hedgeToken.price;
      hedgeOutcome = hedgeToken.outcome;
    }

    console.log(
      `[HEDGING] Current hedge token price: $${hedgePrice}${hedgeOutcome ? ` (Outcome: ${hedgeOutcome})` : ""}`,
    );

    // Step 3: Safety check - if hedge price exceeds max, trigger stop loss
    if (hedgePrice > CONFIG.MAX_HEDGE_PRICE) {
      console.warn(
        `[HEDGING] Hedge price $${hedgePrice} exceeds max $${CONFIG.MAX_HEDGE_PRICE}. Triggering STOP_LOSS.`,
      );
      ctx.state = "STOP_LOSS";
      return "STOP_LOSS";
    }

    // Step 4: Calculate hedge size
    const hedgeSize = calculateHedgeSize(
      initialCost,
      hedgePrice,
      CONFIG.MIN_PROFIT_USD,
    );

    console.log(
      `[HEDGING] Calculated hedge size: ${hedgeSize} shares @ $${hedgePrice} = $${(hedgeSize * hedgePrice).toFixed(2)}`,
    );
    console.log(
      `[HEDGING] Expected profit if hedge succeeds: $${CONFIG.MIN_PROFIT_USD.toFixed(2)}`,
    );

    // NOTE: We place the hedge order FIRST, then cancel the unfilled trap order
    // This minimizes time between price fetch and order placement

    // Place hedge order using FAK with RETRY LOOP until filled
    // FAK = Fill-And-Kill - fills immediately or fails, no partial fills sitting on book
    // For BUY orders: amount = DOLLAR AMOUNT to spend (not share count!)
    // For SELL orders: amount = number of shares to sell
    const hedgeSide = Side.BUY;
    const hedgeTokenId = ctx.oppositeTokenId!;

    let hedgeFilled = false;
    let actualHedgeFilled = hedgeSize;
    let hedgeAttempts = 0;
    const MAX_HEDGE_ATTEMPTS = 30; // Try up to 30 times (about 60 seconds with 2s delays)
    const MAX_SLIPPAGE_PERCENT = 0.1; // Max 10% slippage from fetched price

    // Calculate dollar amount to spend for the hedge
    // hedgeSize = number of shares we want, hedgePrice = price per share
    const hedgeDollarAmount = hedgeSize * hedgePrice;

    console.log(
      `[HEDGING] Placing hedge order on opposite token: ${hedgeTokenId}`,
    );
    console.log(
      `[HEDGING] Target: ${hedgeSize} shares @ $${hedgePrice} = $${hedgeDollarAmount.toFixed(2)} to spend`,
    );
    console.log(
      `[HEDGING] Using FAK ORDER with ${MAX_SLIPPAGE_PERCENT * 100}% max slippage protection`,
    );

    while (!hedgeFilled && hedgeAttempts < MAX_HEDGE_ATTEMPTS) {
      hedgeAttempts++;

      try {
        // Get fresh price - use SAME source as initial price fetch
        // This prevents mixing stale WS cache with HTTP prices
        let currentPrice: number;

        if (useWebSocketPrices) {
          // We established WS is working - continue using it
          const freshCachedPrice = getCachedPrice(ctx, hedgeTokenId);

          if (freshCachedPrice && freshCachedPrice.age < MAX_PRICE_AGE_MS) {
            currentPrice = freshCachedPrice.bestAsk;
            console.log(
              `[HEDGING] Attempt ${hedgeAttempts}/${MAX_HEDGE_ATTEMPTS}: Using WS price $${currentPrice} (age: ${freshCachedPrice.age}ms)`,
            );
          } else {
            // WS became stale mid-hedging, fall back to HTTP for this attempt
            console.log(
              `[HEDGING] Attempt ${hedgeAttempts}/${MAX_HEDGE_ATTEMPTS}: WS price became stale, fetching via HTTP...`,
            );
            const freshMarketData = await ctx.client.getMarket(ctx.conditionId);
            const freshHedgeToken = freshMarketData.tokens.find(
              (token: any) => token.token_id === hedgeTokenId,
            );

            if (!freshHedgeToken) {
              console.error(
                `[HEDGING] Could not find hedge token in market data`,
              );
              await sleep(2000);
              continue;
            }

            currentPrice = freshHedgeToken.price;
          }
        } else {
          // HTTP mode - always use HTTP, never check WS cache
          console.log(
            `[HEDGING] Attempt ${hedgeAttempts}/${MAX_HEDGE_ATTEMPTS}: Fetching price via HTTP...`,
          );
          const freshMarketData = await ctx.client.getMarket(ctx.conditionId);
          const freshHedgeToken = freshMarketData.tokens.find(
            (token: any) => token.token_id === hedgeTokenId,
          );

          if (!freshHedgeToken) {
            console.error(
              `[HEDGING] Could not find hedge token in market data`,
            );
            await sleep(2000);
            continue;
          }

          currentPrice = freshHedgeToken.price;
        }

        // Slippage protection: max price we're willing to pay (current price + slippage buffer)
        const maxPrice = Math.min(
          CONFIG.MAX_HEDGE_PRICE,
          Math.round(currentPrice * (1 + MAX_SLIPPAGE_PERCENT) * 100) / 100,
        );

        // Recalculate dollar amount based on fresh price to get roughly the same shares
        const freshDollarAmount =
          Math.ceil(hedgeSize * currentPrice * 100) / 100;

        console.log(
          `[HEDGING] FAK BUY $${freshDollarAmount.toFixed(2)} worth (market: $${currentPrice}, max: $${maxPrice})`,
        );

        const hedgeResult = await ctx.client.createAndPostMarketOrder(
          {
            tokenID: hedgeTokenId,
            amount: freshDollarAmount, // Dollar amount to spend (for BUY orders)
            price: maxPrice, // Slippage protection - won't fill above this price
            side: hedgeSide,
          },
          {
            tickSize: ctx.market.tickSize,
            negRisk: ctx.market.negRisk,
          },
          OrderType.FAK, // FAK = Fill-And-Kill (fills immediately or fails)
        );

        ctx.hedgeOrderId = hedgeResult.orderID;
        console.log(
          `[HEDGING] FAK order response - ID: ${hedgeResult.orderID}, Status: ${hedgeResult.status}`,
        );

        // Check if order was placed successfully
        if (!hedgeResult.orderID) {
          console.warn(`[HEDGING] ⚠️ No order ID returned, retrying...`);
          await sleep(2000);
          continue;
        }

        // Wait a moment for order to process, then check status
        await sleep(1000);

        const hedgeDetails = await ctx.client.getOrder(hedgeResult.orderID);
        if (hedgeDetails) {
          const status = hedgeDetails.status?.toUpperCase();
          console.log(`[HEDGING] Order status after FAK: ${status}`);

          if (
            status === "MATCHED" ||
            status === "MINED" ||
            status === "CONFIRMED"
          ) {
            hedgeFilled = true;
            const filledAmount =
              (hedgeDetails as any).size_matched || hedgeSize;
            actualHedgeFilled = parseFloat(filledAmount) || hedgeSize;

            // FAST PATH: Use calculated values for now, will fetch accurate positions later
            ctx.hedgeSize = actualHedgeFilled;
            ctx.hedgePrice = currentPrice; // Use market price for now
            console.log(
              `[HEDGING] HEDGE ORDER MATCHED on attempt ${hedgeAttempts}!`,
            );
            console.log(
              `[HEDGING]   Estimated size: ${actualHedgeFilled} shares`,
            );
            console.log(`[HEDGING]   Market price: $${currentPrice}`);
            console.log(
              `[HEDGING] Will fetch accurate position details after hedge settles...`,
            );
            break;
          }
        }

        // If not filled, wait and retry
        console.log(`[HEDGING] Order not filled, retrying in 2 seconds...`);
        await sleep(2000);
      } catch (e: any) {
        const errorMsg = e?.response?.data?.error || e?.message || String(e);
        console.warn(`[HEDGING] Attempt ${hedgeAttempts} failed: ${errorMsg}`);
        await sleep(2000);
      }
    }

    // Store actual filled amount for later use
    ctx.hedgeSize = actualHedgeFilled;

    // NOW cancel the unfilled trap order (after hedge is placed/filled)
    // This ordering ensures minimal delay between price fetch and hedge placement
    if (unfilledOrder) {
      console.log(
        `[HEDGING] Canceling unfilled trap order: ${unfilledOrder.orderId}`,
      );
      try {
        await ctx.client.cancelOrder({ orderID: unfilledOrder.orderId });
        console.log(`[HEDGING] Unfilled trap order cancelled`);
      } catch (e) {
        console.warn(
          "[HEDGING] Failed to cancel unfilled order (may already be filled or cancelled):",
          e,
        );
      }
    }

    // CRITICAL: Verify hedge order actually filled
    if (!hedgeFilled) {
      console.error(
        `[HEDGING] ❌ CRITICAL ERROR: Hedge order did not fill after ${MAX_HEDGE_ATTEMPTS} attempts! Selling trap immediately.`,
      );

      try {
        // Fetch current market data to get trap token price
        const marketData = await ctx.client.getMarket(ctx.conditionId);
        const trapTokenData = marketData.tokens.find(
          (token: any) => token.token_id === ctx.filledTokenId,
        );

        if (!trapTokenData) {
          console.error("[HEDGING] Could not find trap token in market data");
          return "DONE";
        }

        const trapBid = trapTokenData.price;
        // Set aggressive sell price: current price - 10% buffer, minimum 0.01
        // This ensures our sell order fills quickly
        const aggressiveSellPrice = Math.max(
          0.01,
          Math.round((trapBid - 0.1) * 100) / 100,
        );
        console.log(
          `[HEDGING] Selling trap token (${ctx.filledOrder?.outcome}) at aggressive price $${aggressiveSellPrice.toFixed(2)} (market: $${trapBid.toFixed(4)})...`,
        );

        // Sell trap order at aggressive price using GTC to ensure it stays on book
        const sellOrder = await ctx.client.createAndPostOrder(
          {
            tokenID: ctx.filledTokenId!,
            price: aggressiveSellPrice,
            size: ctx.filledOrder!.sizeMatched,
            side: Side.SELL,
          },
          {
            tickSize: ctx.market.tickSize,
            negRisk: ctx.market.negRisk,
          },
          OrderType.GTC, // GTC = Good-Till-Cancelled (stays on book until filled)
        );

        console.log(`[HEDGING] Trap sold! Order ID: ${sellOrder.orderID}`);

        // Fetch actual trap sell fill amount
        let actualTrapSold = ctx.filledOrder!.sizeMatched;
        try {
          const trapSellDetails = await ctx.client.getOrder(sellOrder.orderID);
          if (trapSellDetails) {
            const filledAmount =
              parseFloat((trapSellDetails as any).size_matched) ||
              ctx.filledOrder!.sizeMatched;
            actualTrapSold = filledAmount;
            console.log(
              `[HEDGING] ✅ Actual trap sold: ${actualTrapSold} shares (requested ${ctx.filledOrder!.sizeMatched})`,
            );
          }
        } catch (e) {
          console.warn(
            "[HEDGING] Could not fetch trap sell fill details, using sizeMatched",
          );
        }

        // Calculate loss/proceeds using actual filled amounts (totalCost from trades)
        const trapCost = ctx.filledOrder!.totalCost;
        const trapProceeds = actualTrapSold * aggressiveSellPrice;
        const loss = trapCost - trapProceeds;

        console.log(
          `[HEDGING] ⚠️ Trap Entry: $${trapCost.toFixed(2)} | Exit: $${trapProceeds.toFixed(2)} | Loss: $${loss.toFixed(2)}`,
        );

        metrics.totalPnL -= loss;
        metrics.lossCount++;

        await sendTelegramMessage(
          `
          ❌ <b>HEDGE FAILED - EMERGENCY EXIT</b>
          ━━━━━━━━━━━━━━━━━━━━━━━━━━
          🚨 Hedge order did not fill in time!
          Sold trap position immediately to exit unhedged.

          📊 <b>EXIT DETAILS</b>
          ━━━━━━━━━━━━━━━━━━━━━━━━━━
          Trap Entry: ${ctx.filledOrder?.outcome} @ $${ctx.filledOrder?.avgFillPrice.toFixed(4)} (avg fill) x ${ctx.filledOrder?.sizeMatched} = $${trapCost.toFixed(2)}
          Trap Exit: ${ctx.filledOrder?.outcome} @ $${aggressiveSellPrice.toFixed(2)} x ${actualTrapSold} (ACTUAL FILLED) = $${trapProceeds.toFixed(2)}

          ⚠️ <b>Loss: -$${loss.toFixed(2)}</b>
                  `.trim(),
        );
      } catch (error) {
        console.error(
          "[HEDGING] Error selling trap after hedge failure:",
          error,
        );
      }

      return "DONE";
    }

    // FAST PATH: Initialize share tracking from known values (no API wait)
    // Trap shares: we know from CONFIG.BASE_SIZE (filled at TRAP_PRICE)
    // Hedge shares: we know from hedgeSize (just filled)
    const trapShares = ctx.filledOrder!.sizeMatched;
    const hedgeShares = ctx.hedgeSize;
    const trapTokenIsYes = ctx.filledTokenId === ctx.yesTokenId;

    // Initialize context share tracking
    ctx.yesShares = trapTokenIsYes ? trapShares : hedgeShares;
    ctx.noShares = trapTokenIsYes ? hedgeShares : trapShares;
    ctx.totalInvested = trapCost + hedgeShares * ctx.hedgePrice;
    ctx.flipCount = 0;

    // Determine initial winning side based on hedge token
    // The hedge token is the one that's currently winning (higher price)
    ctx.currentWinningSide =
      ctx.oppositeTokenId === ctx.yesTokenId ? "YES" : "NO";

    console.log(`[HEDGING] Share tracking initialized:`);
    console.log(`[HEDGING]   YES shares: ${ctx.yesShares}`);
    console.log(`[HEDGING]   NO shares: ${ctx.noShares}`);
    console.log(`[HEDGING]   Total invested: $${ctx.totalInvested.toFixed(2)}`);
    console.log(`[HEDGING]   Current winning side: ${ctx.currentWinningSide}`);

    // NOTE: Exit orders are NOT placed here. They will be placed in DYNAMIC_WATCHING
    // when bid price exceeds $0.90 for either token.
    console.log(
      `[HEDGING] Exit orders will be placed when bid > $0.90 in DYNAMIC_WATCHING`,
    );

    // Send Telegram notification
    const actualHedgeCost = ctx.hedgeSize * ctx.hedgePrice;
    await sendTelegramMessage(
      `
      TRAP FILLED & HEDGE PLACED
      ----------------------------------------
  Trap Entry: ${ctx.filledOrder!.outcome} @ $${ctx.filledOrder!.avgFillPrice.toFixed(4)} x ${ctx.filledOrder!.sizeMatched.toFixed(4)} = $${ctx.filledOrder!.totalCost.toFixed(4)}
  Hedge Entry: ${ctx.oppositeTokenId === ctx.yesTokenId ? "YES" : "NO"} @ $${ctx.hedgePrice.toFixed(4)} x ${ctx.hedgeSize.toFixed(4)} = $${actualHedgeCost.toFixed(4)}

  Total Invested: $${ctx.totalInvested.toFixed(2)}
  Expected Profit: +$${CONFIG.MIN_PROFIT_USD.toFixed(2)}

  Position is now DELTA-NEUTRAL
  Entering DYNAMIC_WATCHING mode...
  Exit order will be placed when bid > $0.90
      `.trim(),
    );

    return "DYNAMIC_WATCHING";
  } catch (error) {
    console.error("[HEDGING] Error during hedging:", error);
    return "DONE";
  }
}

// ============================================================================
// STATE: DYNAMIC_WATCHING - Monitor prices, flip when losing side recovers
// Uses WebSocket price_change events for real-time monitoring
// ============================================================================
async function handleDynamicWatching(ctx: BotContext): Promise<BotState> {
  console.log("\n[DYNAMIC_WATCHING] Entering dynamic watching mode...");
  console.log(`[DYNAMIC_WATCHING] YES shares: ${ctx.yesShares}`);
  console.log(`[DYNAMIC_WATCHING] NO shares: ${ctx.noShares}`);
  console.log(
    `[DYNAMIC_WATCHING] Total invested: $${ctx.totalInvested.toFixed(2)}`,
  );
  console.log(
    `[DYNAMIC_WATCHING] Flip trigger price: $${CONFIG.FLIP_TOKEN_BUY_PRICE}`,
  );
  console.log(`[DYNAMIC_WATCHING] Exit price: $${CONFIG.EXIT_PRICE}`);

  // Ensure WebSocket is connected
  if (!ctx.priceWs || ctx.priceWs.readyState !== WebSocket.OPEN) {
    console.log("[DYNAMIC_WATCHING] WebSocket not connected, starting...");
    startPriceWebSocket(ctx);
    await sleep(2000); // Give WS time to connect
  }

  const startTime = Date.now();
  const MAX_WATCH_TIME = 60 * 60 * 1000; // 60 minutes max (increased for flexible exit)
  let lastLogTime = startTime;
  let exitOrderCheckCounter = 0; // Check exit order every 500ms (every 20 iterations)

  while (Date.now() - startTime < MAX_WATCH_TIME) {
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

    // Get current prices from WebSocket cache
    const yesPrice = ctx.priceCache[ctx.yesTokenId];
    const noPrice = ctx.priceCache[ctx.noTokenId];

    if (!yesPrice || !noPrice) {
      // No price data yet, wait
      if (Date.now() - lastLogTime > 5000) {
        console.log(
          `[DYNAMIC_WATCHING] [${elapsedSeconds}s] Waiting for price data...`,
        );
        lastLogTime = Date.now();
      }
      await sleep(500);
      continue;
    }

    const yesBid = yesPrice.bestBid;
    const yesAsk = yesPrice.bestAsk;
    const noBid = noPrice.bestBid;
    const noAsk = noPrice.bestAsk;

    // Log status every 5 seconds
    if (Date.now() - lastLogTime > 3000) {
      const exitStatus = ctx.exitOrderId
        ? `Exit: ${ctx.exitOrderSide}`
        : "No exit order";
      console.log(
        `[DYNAMIC_WATCHING] [${elapsedSeconds}s] YES: bid=$${yesBid.toFixed(2)} ask=$${yesAsk.toFixed(2)} | NO: bid=$${noBid.toFixed(2)} ask=$${noAsk.toFixed(2)} | Flips: ${ctx.flipCount}/${CONFIG.MAX_FLIPS_PER_MARKET} | ${exitStatus}`,
      );
      lastLogTime = Date.now();
    }

    // ========================================================================
    // [STEP 2] CHECK EXIT ORDER STATUS (every 500ms = every 20 iterations)
    // ========================================================================
    if (ctx.exitOrderId && exitOrderCheckCounter++ % 30 === 0) {
      try {
        const orderDetails = await ctx.client.getOrder(ctx.exitOrderId);
        const status = orderDetails?.status?.toUpperCase();

        if (
          status === "MATCHED" ||
          status === "MINED" ||
          status === "CONFIRMED"
        ) {
          console.log(`[DYNAMIC_WATCHING] Exit order FILLED!`);
          return await handleSellOrderFilled(ctx, ctx.exitOrderSide!);
        }

        if (status === "CANCELED" || status === "CANCELLED") {
          console.log(
            `[DYNAMIC_WATCHING] Exit order was cancelled externally. Clearing...`,
          );
          ctx.exitOrderId = null;
          ctx.exitOrderSide = null;
          // Will re-place next iteration if bid still > 0.90
        }
      } catch (e) {
        // Order status check failed, continue
        console.log("Error occured while checking the status", e);
      }
    }

    // ========================================================================
    // [STEP 3] FLIP CONDITION: opposite token's ASK >= $0.66
    // ========================================================================
    // Determine the flip target (opposite of current winning side)
    const flipTargetSide: "YES" | "NO" =
      ctx.currentWinningSide === "YES" ? "NO" : "YES";
    const flipTargetTokenId =
      flipTargetSide === "YES" ? ctx.yesTokenId : ctx.noTokenId;
    const flipTargetAskPrice = flipTargetSide === "YES" ? yesAsk : noAsk;
    const flipTargetShares =
      flipTargetSide === "YES" ? ctx.yesShares : ctx.noShares;

    // FLIP TRIGGER: Opposite token price rises above threshold
    if (
      flipTargetAskPrice >= CONFIG.FLIP_TOKEN_BUY_PRICE &&
      ctx.flipCount < CONFIG.MAX_FLIPS_PER_MARKET
    ) {
      console.log(
        `\n[DYNAMIC_WATCHING] FLIP TRIGGERED! ${flipTargetSide} @ $${flipTargetAskPrice.toFixed(2)} >= $${CONFIG.FLIP_TOKEN_BUY_PRICE}`,
      );
      console.log(
        `[DYNAMIC_WATCHING] Current winning side: ${ctx.currentWinningSide}, flipping TO: ${flipTargetSide}`,
      );

      // Calculate how many shares to buy
      const flipAmount = calculateFlipAmount(
        ctx.totalInvested,
        flipTargetShares,
        flipTargetAskPrice,
        CONFIG.MIN_PROFIT_USD,
      );

      if (flipAmount > 0) {
        // Execute flip FIRST
        const flipResult = await executeFlip(
          ctx,
          flipTargetTokenId,
          flipTargetSide,
          flipAmount,
          flipTargetAskPrice,
        );

        if (flipResult) {
          // CRITICAL: Update currentWinningSide to the token we just bought
          ctx.currentWinningSide = flipTargetSide;
          ctx.flipCount++;
          console.log(
            `[DYNAMIC_WATCHING] Flip #${ctx.flipCount} complete. currentWinningSide is now: ${ctx.currentWinningSide}`,
          );
          console.log(
            `[DYNAMIC_WATCHING] New positions: YES=${ctx.yesShares}, NO=${ctx.noShares}`,
          );

          // THEN cancel exit order if exists (flip succeeded, we're now positioned differently)
          if (ctx.exitOrderId) {
            try {
              await ctx.client.cancelOrder({ orderID: ctx.exitOrderId });
              console.log(
                `[DYNAMIC_WATCHING] Cancelled exit order after flip: ${ctx.exitOrderId}`,
              );

              await sendTelegramMessage(
                `
EXIT ORDER CANCELLED (FLIP)
----------------------------------------
Flip succeeded, cancelling ${ctx.exitOrderSide} exit order.
Now positioned on ${flipTargetSide} side.
                `.trim(),
              );
            } catch (e) {
              console.warn(
                `[DYNAMIC_WATCHING] Could not cancel exit order (may already be filled)`,
              );
            }
            ctx.exitOrderId = null;
            ctx.exitOrderSide = null;
          }
        }
      } else {
        console.log(
          `[DYNAMIC_WATCHING] Flip calculation returned 0, skipping...`,
        );
      }
    }

    // ========================================================================
    // [STEP 4] EXIT CONDITION: bid > $0.90 AND no exit order placed yet
    // ========================================================================
    const EXIT_TRIGGER_PRICE = 0.9;

    if (!ctx.exitOrderId) {
      // Check if YES bid > 0.90
      if (yesBid > EXIT_TRIGGER_PRICE) {
        console.log(
          `\n[DYNAMIC_WATCHING] EXIT TRIGGERED! YES bid $${yesBid.toFixed(2)} > $${EXIT_TRIGGER_PRICE}`,
        );
        await placeExitOrder(ctx, "YES", ctx.yesTokenId);
        // DO NOT return - stay in loop
      }
      // Check if NO bid > 0.90
      else if (noBid > EXIT_TRIGGER_PRICE) {
        console.log(
          `\n[DYNAMIC_WATCHING] EXIT TRIGGERED! NO bid $${noBid.toFixed(2)} > $${EXIT_TRIGGER_PRICE}`,
        );
        await placeExitOrder(ctx, "NO", ctx.noTokenId);
        // DO NOT return - stay in loop
      }
    }

    await sleep(25); // Check every 25ms for ultra-fast flip detection
  }

  // Timeout - cancel orders and exit
  console.log(
    `[DYNAMIC_WATCHING] Timeout after 60 minutes. Cancelling orders...`,
  );

  try {
    if (ctx.exitOrderId) {
      await ctx.client.cancelOrder({ orderID: ctx.exitOrderId });
    }
  } catch (e) {
    console.error("[DYNAMIC_WATCHING] Error cancelling orders:", e);
  }

  await sendTelegramMessage(
    `
MARKET TIMEOUT - DYNAMIC WATCHING
----------------------------------------
60 minutes elapsed without exit fill.
Orders cancelled. Check positions manually.

Final state:
YES shares: ${ctx.yesShares}
NO shares: ${ctx.noShares}
Total invested: $${ctx.totalInvested.toFixed(2)}
Flips executed: ${ctx.flipCount}
    `.trim(),
  );

  return "DONE";
}

// ============================================================================
// HELPER: Place exit order when bid > 0.90
// Fetches exact position from API, places GTC SELL at EXIT_PRICE
// ============================================================================
async function placeExitOrder(
  ctx: BotContext,
  side: "YES" | "NO",
  tokenId: string,
): Promise<boolean> {
  console.log(`[EXIT_ORDER] Placing ${side} exit order...`);

  // Fetch current positions from API to get exact share count
  const positions = await getUserPositions(ctx.conditionId);

  if (positions.length === 0) {
    console.error(`[EXIT_ORDER] No positions found!`);
    return false;
  }

  // Find the position for this token
  const position = positions.find((p) => p.asset === tokenId);

  if (!position || position.size <= 0) {
    console.error(`[EXIT_ORDER] No ${side} position found or size is 0`);
    console.log(
      `[EXIT_ORDER] Available positions:`,
      positions.map((p) => ({
        asset: p.asset.slice(0, 10) + "...",
        size: p.size,
        outcome: p.outcome,
      })),
    );
    return false;
  }

  const shareSize = Math.floor(position.size * 1000000) / 1000000; // Round down to 6 decimals

  console.log(`[EXIT_ORDER] Found ${side} position: ${shareSize} shares`);
  console.log(
    `[EXIT_ORDER] Placing GTC SELL order: ${shareSize} ${side} @ $${CONFIG.EXIT_PRICE}`,
  );

  try {
    const sellOrder = await ctx.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: CONFIG.EXIT_PRICE,
        size: shareSize,
        side: Side.SELL,
      },
      {
        tickSize: ctx.market.tickSize,
        negRisk: ctx.market.negRisk,
      },
      OrderType.GTC,
    );

    if (!sellOrder.orderID) {
      console.error(`[EXIT_ORDER] Failed to place order - no orderID returned`);
      return false;
    }

    ctx.exitOrderId = sellOrder.orderID;
    ctx.exitOrderSide = side;

    console.log(`[EXIT_ORDER] Exit order placed: ${sellOrder.orderID}`);

    await sendTelegramMessage(
      `
EXIT ORDER PLACED
----------------------------------------
${side} SELL @ $${CONFIG.EXIT_PRICE} x ${shareSize.toFixed(2)}

Position fetched from API.
Continuing to monitor (flips still possible).

Flips executed: ${ctx.flipCount}
Total invested: $${ctx.totalInvested.toFixed(2)}
      `.trim(),
    );

    return true;
  } catch (error: any) {
    console.error(
      `[EXIT_ORDER] Failed to place order:`,
      error.message || error,
    );
    return false;
  }
}

// ============================================================================
// HELPER: Execute a flip (buy more of recovering token)
// BULLETPROOF VERSION with aggressive retries and fresh price fetching
// ============================================================================
async function executeFlip(
  ctx: BotContext,
  tokenId: string,
  side: "YES" | "NO",
  amount: number,
  initialBuyPrice: number,
): Promise<boolean> {
  console.log(
    `[FLIP] Executing flip: BUY ${amount} ${side} @ initial $${initialBuyPrice.toFixed(2)}`,
  );

  const MAX_FLIP_ATTEMPTS = 30; // Same as hedge attempts
  const SLIPPAGE_MULTIPLIER = 1.15; // 15% slippage tolerance (more aggressive)

  for (let attempt = 1; attempt <= MAX_FLIP_ATTEMPTS; attempt++) {
    try {
      // CRITICAL: Get fresh price from WebSocket cache on EVERY attempt
      const priceData = ctx.priceCache[tokenId];
      const freshAskPrice = priceData?.bestAsk || initialBuyPrice;
      const priceAge = priceData ? Date.now() - priceData.lastUpdate : -1;

      console.log(
        `[FLIP] Attempt ${attempt}/${MAX_FLIP_ATTEMPTS}: Fresh ask price $${freshAskPrice.toFixed(2)} (age: ${priceAge}ms)`,
      );

      // Recalculate dollar amount with fresh price
      const dollarAmount = Math.ceil(amount * freshAskPrice * 100) / 100;
      const maxPrice = Math.min(
        0.98, // Higher cap for flips - we MUST get filled
        Math.round(freshAskPrice * SLIPPAGE_MULTIPLIER * 100) / 100,
      );

      console.log(
        `[FLIP] FAK BUY $${dollarAmount} worth (market: $${freshAskPrice.toFixed(2)}, max: $${maxPrice})`,
      );

      const buyResult = await ctx.client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: dollarAmount,
          price: maxPrice,
          side: Side.BUY,
        },
        {
          tickSize: ctx.market.tickSize,
          negRisk: ctx.market.negRisk,
        },
        OrderType.FAK,
      );

      console.log(
        `[FLIP] FAK order response - ID: ${buyResult.orderID}, Status: ${buyResult.status}`,
      );

      if (!buyResult.orderID) {
        console.warn(
          `[FLIP] Attempt ${attempt}: No order ID returned, retrying...`,
        );
        await sleep(50); // Very short wait before retry
        continue;
      }

      // Wait briefly for order to process
      await sleep(200);

      const buyDetails = await ctx.client.getOrder(buyResult.orderID);
      const buyStatus = buyDetails?.status?.toUpperCase();

      console.log(`[FLIP] Order status after FAK: ${buyStatus}`);

      if (
        buyStatus === "MATCHED" ||
        buyStatus === "MINED" ||
        buyStatus === "CONFIRMED"
      ) {
        console.log(`[FLIP] FLIP ORDER MATCHED on attempt ${attempt}!`);

        // Step 2: Update share tracking
        const filledAmount =
          parseFloat((buyDetails as any).size_matched) || amount;
        const actualCost = filledAmount * freshAskPrice;

        if (side === "YES") {
          ctx.yesShares += filledAmount;
        } else {
          ctx.noShares += filledAmount;
        }
        ctx.totalInvested += actualCost;

        console.log(
          `[FLIP] Bought ${filledAmount} ${side} shares for ~$${actualCost.toFixed(2)}`,
        );
        console.log(
          `[FLIP] New totals: YES=${ctx.yesShares}, NO=${ctx.noShares}, Invested=$${ctx.totalInvested.toFixed(2)}`,
        );

        // Send Telegram notification (NO SELL ORDER - exit handled in DYNAMIC_WATCHING)
        await sendTelegramMessage(
          `
FLIP #${ctx.flipCount + 1} EXECUTED
----------------------------------------
Bought: ${filledAmount.toFixed(2)} ${side} @ $${freshAskPrice.toFixed(2)} = $${actualCost.toFixed(2)}
Attempts: ${attempt}/${MAX_FLIP_ATTEMPTS}

Updated Positions:
YES shares: ${ctx.yesShares.toFixed(2)}
NO shares: ${ctx.noShares.toFixed(2)}
Total invested: $${ctx.totalInvested.toFixed(2)}

Exit order will be placed when bid > $0.90
          `.trim(),
        );

        return true;
      }

      // Order not filled, retry with fresh price
      console.warn(
        `[FLIP] Attempt ${attempt}: Order status ${buyStatus}, retrying...`,
      );
      await sleep(50); // Very short wait before retry
    } catch (error: any) {
      console.error(
        `[FLIP] Attempt ${attempt} error:`,
        error?.message || error,
      );
      await sleep(100); // Slightly longer wait after error
    }
  }

  // All attempts failed
  console.error(
    `[FLIP] CRITICAL: All ${MAX_FLIP_ATTEMPTS} flip attempts failed!`,
  );
  await sendTelegramMessage(
    `
FLIP FAILED - CRITICAL
----------------------------------------
Failed to buy ${amount} ${side} after ${MAX_FLIP_ATTEMPTS} attempts!

Current positions:
YES shares: ${ctx.yesShares}
NO shares: ${ctx.noShares}
Total invested: $${ctx.totalInvested.toFixed(2)}

Manual intervention may be required.
    `.trim(),
  );

  return false;
}

// ============================================================================
// HELPER: Handle sell order filled (exit position)
// ============================================================================
async function handleSellOrderFilled(
  ctx: BotContext,
  filledSide: "YES" | "NO",
): Promise<BotState> {
  const filledShares = filledSide === "YES" ? ctx.yesShares : ctx.noShares;
  const saleProceeds = filledShares * CONFIG.EXIT_PRICE;
  const realizedPnL = saleProceeds - ctx.totalInvested;

  console.log(`[EXIT] ${filledSide} sell order filled!`);
  console.log(`[EXIT] Sale proceeds: $${saleProceeds.toFixed(2)}`);
  console.log(`[EXIT] Total invested: $${ctx.totalInvested.toFixed(2)}`);
  console.log(
    `[EXIT] Realized PnL: ${realizedPnL >= 0 ? "+" : ""}$${realizedPnL.toFixed(2)}`,
  );

  // Update metrics
  metrics.totalPnL += realizedPnL;
  if (realizedPnL >= 0) {
    metrics.winCount++;
  } else {
    metrics.lossCount++;
  }

  // Clear exit order tracking
  ctx.exitOrderId = null;
  ctx.exitOrderSide = null;

  await sendTelegramMessage(
    `
${realizedPnL >= 0 ? "PROFIT" : "LOSS"} - ${filledSide} EXIT
----------------------------------------
${filledSide} sold @ $${CONFIG.EXIT_PRICE} x ${filledShares.toFixed(2)} = $${saleProceeds.toFixed(2)}

Trade Summary:
Total invested: $${ctx.totalInvested.toFixed(2)}
Flips executed: ${ctx.flipCount}
Realized PnL: ${realizedPnL >= 0 ? "+" : ""}$${realizedPnL.toFixed(2)}

Portfolio:
Total PnL: ${metrics.totalPnL >= 0 ? "+" : ""}$${metrics.totalPnL.toFixed(2)}
Wins: ${metrics.winCount} | Losses: ${metrics.lossCount}
Win Rate: ${((metrics.winCount / (metrics.winCount + metrics.lossCount)) * 100).toFixed(1)}%
    `.trim(),
  );

  return "DONE";
}

// ============================================================================
// STATE: STOP_LOSS - Sell the initial position to limit losses
// ============================================================================
async function handleStopLoss(ctx: BotContext): Promise<BotState> {
  if (!ctx.filledOrder) {
    console.error("[STOP_LOSS] No filled order to stop loss!");
    return "DONE";
  }

  console.log("\n[STOP_LOSS] Selling initial position to limit losses...");

  try {
    // Sell all shares from the filled order at market price
    const response = await ctx.client.createAndPostOrder(
      {
        tokenID: ctx.filledTokenId!, // Sell the token we bought
        price: 0.01, // Sell at minimal price to guarantee execution
        size: ctx.filledOrder.sizeMatched,
        side: Side.SELL,
      },
      {
        tickSize: ctx.market.tickSize,
        negRisk: ctx.market.negRisk,
      },
      OrderType.GTC,
    );

    console.log(
      `[STOP_LOSS] Sold ${ctx.filledOrder.sizeMatched} shares. Order: ${response.orderID}`,
    );
    console.log(`[STOP_LOSS] Status: ${response.status}`);

    return "DONE";
  } catch (error) {
    console.error("[STOP_LOSS] Failed to execute stop loss:", error);
    return "DONE";
  }
}

// ============================================================================
// STATE: DONE - Wait for market resolution, then next market activation
// ============================================================================
async function handleDone(ctx: BotContext): Promise<BotState> {
  console.log("\n[DONE] Round complete. Waiting for market resolution...");
  metrics.cycleCount++;

  // Send stats notification every cycle
  await sendStatsNotification();

  // Step 1: Wait for current market to resolve
  console.log(`[DONE] Current market: ${ctx.market.slug}`);
  const currentMarketResolved = await waitForMarketResolution(ctx.market.slug);

  if (currentMarketResolved) {
    console.log(`[DONE] ✅ Market resolved: ${ctx.market.slug}`);

    // Step 2: Log resolution details
    try {
      const resolvedMarket = await getMarketInfo("btc-updown-15m");
      if (resolvedMarket) {
        console.log(`[DONE] Resolution price: ${resolvedMarket.description}`);
        console.log(`[DONE] Status: ${resolvedMarket.status}`);
      }
    } catch (error) {
      console.warn("[DONE] Could not fetch resolution details:", error);
    }
  } else {
    console.warn(
      "[DONE] Market resolution timeout. Proceeding to next market anyway.",
    );
  }

  // Step 3: Wait for next market to become active
  console.log("[DONE] Waiting for next BTC-15m market to activate...");
  const nextMarketReady = await waitForNextMarketActivation("btc-updown-15m");

  if (nextMarketReady) {
    console.log("[DONE] ✅ Next market is now active and ready!");

    // 🔴 CRITICAL: Wait until we're truly in the NEXT 15-minute interval
    // This prevents re-investing in the same market due to timing boundaries
    console.log(
      "[DONE] Ensuring we're past the current market interval boundary...",
    );
    const now = Math.floor(Date.now() / 1000);
    const currentEpoch = Math.floor(now / 900) * 900; // Current 15-min boundary
    const nextEpoch = currentEpoch + 900; // Next 15-min boundary
    const waitUntil = (nextEpoch + 5) * 1000; // Wait until 5 seconds into next interval
    const waitMs = Math.max(0, waitUntil - Date.now());

    if (waitMs > 0) {
      console.log(
        `[DONE] Sleeping for ${Math.ceil(waitMs / 1000)} seconds to ensure next market interval...`,
      );
      await sleep(waitMs);
    }
    console.log(
      "[DONE] ✅ Now safely in next market interval. Ready to start new cycle.",
    );
  } else {
    console.warn("[DONE] Next market activation timeout. Retrying...");
  }

  return "START";
}

// ============================================================================
// HELPER: MARKET SLUG DERIVATION & FETCHING
// ============================================================================
function deriveCurrentMarketSlug(
  baseSlugPrefix = "btc-updown-15m",
  intervalSeconds = 900,
) {
  const now = Math.floor(Date.now() / 1000); // Current time in seconds
  const epoch = Math.floor(now / intervalSeconds) * intervalSeconds;
  return `${baseSlugPrefix}-${epoch}`;
}

function deriveNextMarketSlug(
  baseSlugPrefix = "btc-updown-15m",
  intervalSeconds = 900,
) {
  const now = Math.floor(Date.now() / 1000);
  const currentEpoch = Math.floor(now / intervalSeconds) * intervalSeconds;
  const nextEpoch = currentEpoch + intervalSeconds; // Next 15-minute interval
  return `${baseSlugPrefix}-${nextEpoch}`;
}

async function getMarketInfo(baseSlugPrefix = "btc-updown-15m") {
  const GAMMA_API = "https://gamma-api.polymarket.com";
  const slug = deriveCurrentMarketSlug(baseSlugPrefix, 900);
  console.log(`Derived current slug: ${slug}`);

  try {
    const response = await axios.get(
      `${GAMMA_API}/markets?slug=${slug}&active=true`,
    );
    const markets = response.data;
    if (markets && markets.length > 0) {
      return markets[0];
    }
  } catch (error) {
    console.error("Error fetching market:", error);
  }
  return null;
}

// ============================================================================
// HELPER: WAIT FOR MARKET RESOLUTION
// ============================================================================
async function waitForMarketResolution(
  marketSlug: string,
  maxWaitMs: number = 900000,
): Promise<boolean> {
  const GAMMA_API = "https://gamma-api.polymarket.com";
  const pollIntervalMs = 10000; // Poll every 10 seconds
  const startTime = Date.now();

  console.log(`[RESOLUTION WAIT] Polling market status: ${marketSlug}`);

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await axios.get(
        `${GAMMA_API}/markets?slug=${marketSlug}`,
      );
      const markets = response.data;

      if (markets && markets.length > 0) {
        const market = markets[0];
        console.log(
          `[RESOLUTION WAIT] Market status: ${market.status} | Expiry: ${market.endDate}`,
        );

        // Check if market is resolved or closed
        if (
          market.status === "RESOLVED" ||
          market.status === "CLOSED" ||
          market.active === false
        ) {
          console.log(
            `[RESOLUTION WAIT] Market status changed to: ${market.status}`,
          );
          return true;
        }
      }
    } catch (error) {
      console.warn("[RESOLUTION WAIT] Error fetching market status:", error);
    }

    // Wait before next poll
    await sleep(pollIntervalMs);
  }

  console.warn(
    `[RESOLUTION WAIT] Timeout waiting for market resolution after ${maxWaitMs}ms`,
  );
  return false;
}

// ============================================================================
// HELPER: WAIT FOR NEXT MARKET ACTIVATION
// ============================================================================
async function waitForNextMarketActivation(
  baseSlugPrefix: string = "btc-updown-15m",
  maxWaitMs: number = 600000,
): Promise<boolean> {
  const GAMMA_API = "https://gamma-api.polymarket.com";
  const pollIntervalMs = 5000; // Poll every 5 seconds
  const startTime = Date.now();

  let nextSlug = deriveNextMarketSlug(baseSlugPrefix, 900);
  console.log(`[NEXT MARKET WAIT] Waiting for market: ${nextSlug}`);

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Re-derive slug in case we've crossed into the next interval
      nextSlug = deriveNextMarketSlug(baseSlugPrefix, 900);

      const response = await axios.get(
        `${GAMMA_API}/markets?slug=${nextSlug}&active=true`,
      );
      const markets = response.data;

      if (markets && markets.length > 0) {
        const market = markets[0];
        console.log(
          `[NEXT MARKET WAIT] ✅ Found next market! Slug: ${market.slug} | Status: ${market.status}`,
        );
        console.log(`[NEXT MARKET WAIT] Market details: ${market.title}`);
        return true;
      }

      console.log(
        `[NEXT MARKET WAIT] Next market not yet active. Polling again in ${pollIntervalMs}ms...`,
      );
    } catch (error) {
      console.warn("[NEXT MARKET WAIT] Error fetching next market:", error);
    }

    // Wait before next poll
    await sleep(pollIntervalMs);
  }

  console.warn(
    `[NEXT MARKET WAIT] Timeout waiting for next market activation after ${maxWaitMs}ms`,
  );
  return false;
}

// ============================================================================
// STATE MACHINE EXECUTOR
// ============================================================================
async function executeStateMachine(ctx: BotContext): Promise<BotState> {
  switch (ctx.state) {
    case "START":
      return await handleStart(ctx);
    case "PLACING_TRAPS":
      return await handlePlacingTraps(ctx);
    case "WATCHING":
      return await handleWatching(ctx);
    case "HEDGING":
      return await handleHedging(ctx);
    case "DYNAMIC_WATCHING":
      return await handleDynamicWatching(ctx);
    case "STOP_LOSS":
      return await handleStopLoss(ctx);
    case "DONE":
      return await handleDone(ctx);
    default:
      console.error("Unknown state:", ctx.state);
      return "START";
  }
}

// ============================================================================
// MAIN BOT LOOP
// ============================================================================
async function main() {
  const client = await initializeClient();
  const ctx: BotContext = {
    client,
    market: null,
    conditionId: "",
    lastConditionId: "", // Track last market to prevent reinvestment
    yesTokenId: "",
    noTokenId: "",
    trapOrders: [],
    filledOrder: null,
    filledTokenId: null,
    oppositeTokenId: null,
    hedgeOrderId: null,
    hedgeSize: 0,
    hedgePrice: 0,
    state: "START",
    // WebSocket for real-time price updates
    priceWs: null,
    priceCache: {},
    // Dynamic flipping tracking
    totalInvested: 0,
    yesShares: 0,
    noShares: 0,
    currentWinningSide: null,
    flipCount: 0,
    yesSellOrderId: null,
    noSellOrderId: null,
    exitOrderId: null,
    exitOrderSide: null,
  };

  console.log("=".repeat(80));
  console.log("TRAP & CHASE HEDGING BOT INITIALIZED");
  console.log("=".repeat(80));
  console.log("Configuration:");
  console.log(`  Trap Price: $${CONFIG.TRAP_PRICE}`);
  console.log(`  Base Size: ${CONFIG.BASE_SIZE} shares`);
  console.log(`  Min Profit: $${CONFIG.MIN_PROFIT_USD}`);
  console.log(`  Max Hedge Price: $${CONFIG.MAX_HEDGE_PRICE}`);
  console.log(`  Exit Price: $${CONFIG.EXIT_PRICE}`);
  console.log(`  Flip Trigger Price: $${CONFIG.FLIP_TOKEN_BUY_PRICE}`);
  console.log(`  Max Flips Per Market: ${CONFIG.MAX_FLIPS_PER_MARKET}`);
  console.log("=".repeat(80));

  // Main bot loop
  let cycleCount = 0;

  while (true) {
    cycleCount++;
    console.log(`\n${"=".repeat(80)}`);
    console.log(`CYCLE #${cycleCount}`);
    console.log(`${"=".repeat(80)}`);

    try {
      // Execute state transitions until DONE
      while (ctx.state !== "DONE") {
        ctx.state = await executeStateMachine(ctx);
      }

      // Clean up WebSocket connection
      stopPriceWebSocket(ctx);

      // Reset for next cycle
      ctx.conditionId = "";
      ctx.state = "START";
      ctx.trapOrders = [];
      ctx.filledOrder = null;
      ctx.filledTokenId = null;
      ctx.oppositeTokenId = null;
      ctx.hedgeOrderId = null;
      ctx.hedgeSize = 0;
      ctx.hedgePrice = 0;
      ctx.priceCache = {}; // Clear price cache for new market
      // Reset dynamic flipping tracking
      ctx.totalInvested = 0;
      ctx.yesShares = 0;
      ctx.noShares = 0;
      ctx.currentWinningSide = null;
      ctx.flipCount = 0;
      ctx.yesSellOrderId = null;
      ctx.noSellOrderId = null;
      ctx.exitOrderId = null;
      ctx.exitOrderSide = null;

      // Wait before starting next cycle
      console.log("\nWaiting for next cycle...");
      await sleep(10000);
    } catch (error) {
      console.error("Unexpected error in bot loop:", error);
      stopPriceWebSocket(ctx); // Clean up on error too
      ctx.state = "START";
      ctx.priceCache = {};
      // Reset dynamic flipping tracking on error
      ctx.totalInvested = 0;
      ctx.yesShares = 0;
      ctx.noShares = 0;
      ctx.currentWinningSide = null;
      ctx.flipCount = 0;
      ctx.yesSellOrderId = null;
      ctx.noSellOrderId = null;
      ctx.exitOrderId = null;
      ctx.exitOrderSide = null;
      await sleep(10000);
    }
  }
}

main().catch(console.error);
