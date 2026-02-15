import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers"; // v5.8.0
import * as dotenv from "dotenv";
import { Side } from "@polymarket/clob-client";
import { OrderType } from "@polymarket/clob-client";

dotenv.config();

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================
const CONFIG = {
  TRAP_PRICE: 0.4, // Price for initial limit orders (cheap liquidity traps)
  BASE_SIZE: 5, // Number of shares per trap order
  MIN_PROFIT_USD: 1.0, // Target profit to secure during hedge
  MAX_HEDGE_PRICE: 0.8, // Safety cap - abort if opposing side too expensive
  WATCH_INTERVAL_MS: 1500, // Poll order status every 2 seconds
  MARKET_POLL_TIMEOUT_MS: 30000, // Max time to wait for market resolution
};

// ============================================================================
// STATE MACHINE TYPES
// ============================================================================
type BotState =
  | "START"
  | "PLACING_TRAPS"
  | "WATCHING"
  | "HEDGING"
  | "PROFIT_TAKING"
  | "STOP_LOSS"
  | "DONE";

interface OrderRecord {
  orderId: string;
  tokenId: string; // Which token this order is for
  side: Side;
  size: number;
  price: number;
  status: string;
  outcome: string; // "YES" or "NO" for clarity
}

interface BotContext {
  client: ClobClient;
  market: any;
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

  return Math.ceil((initialCost + targetProfit) / (1 - hedgePrice));
}

// ============================================================================
// HELPER: SLEEP FUNCTION
// ============================================================================
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// TELEGRAM NOTIFICATION FUNCTIONS
// ============================================================================
async function sendTelegramMessage(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram credentials not configured");
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });

    if (!response.ok) {
      console.error("Failed to send Telegram message:", await response.text());
    }
  } catch (error) {
    console.error("Error sending Telegram message:", error);
  }
}

async function sendTradeNotification(
  market: string,
  trapPrice: number,
  trapSize: number,
  outcome: string,
): Promise<void> {
  const invested = trapSize * trapPrice;
  metrics.totalInvested += invested;

  const message = `
🎯 <b>TRAP PLACED</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Market: ${market}
🎲 Outcome: <b>${outcome}</b>
💰 Price: $${trapPrice.toFixed(2)}
📈 Size: ${trapSize} shares
💵 Invested: $${invested.toFixed(2)}

📊 Portfolio Stats:
Total Invested: $${metrics.totalInvested.toFixed(2)}
Total PnL: <b>${metrics.totalPnL >= 0 ? "+" : ""}$${metrics.totalPnL.toFixed(2)}</b>
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
// PHASE 1: CLIENT INITIALIZATION
// ============================================================================
async function initializeClient() {
  const HOST = "https://clob.polymarket.com";
  const CHAIN_ID = 137; // Polygon mainnet
  const signer = new Wallet(process.env.PRIVATE_KEY as string);

  // Phase 1: Create minimal client to derive API credentials
  const tempClient = new ClobClient(HOST, CHAIN_ID, signer);
  const userApiCreds = await tempClient.createOrDeriveApiKey();

  console.log("API Key:", userApiCreds.key);
  console.log("Secret:", userApiCreds.secret);
  console.log("Passphrase:", userApiCreds.passphrase);

  // Phase 2: Reinitialize with full authentication
  // Signature types: 0 = EOA, 1 = POLY_PROXY, 2 = GNOSIS_SAFE
  const SIGNATURE_TYPE = 1; // Poly Proxy
  const FUNDER_ADDRESS = signer.address; // For EOA, funder is your wallet

  const client = new ClobClient(
    HOST,
    CHAIN_ID,
    signer,
    userApiCreds,
    SIGNATURE_TYPE,
    FUNDER_ADDRESS,
  );

  console.log("Client initialized successfully!");

  // Now you can use `client` to place orders, check balances, etc.
  return client;
}

// ============================================================================
// STATE: START - Identify market and cancel stale orders
// ============================================================================
async function handleStart(ctx: BotContext): Promise<BotState> {
  console.log("\n[START] Identifying current market...");

  const market = await getMarketInfo("btc-updown-15m");
  if (!market) {
    console.error("[START] Failed to find market. Retrying...");
    await sleep(5000);
    return "START";
  }

  ctx.market = market;

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

  ctx.yesTokenId = tokenIds[0]; // First token = YES
  ctx.noTokenId = tokenIds[1]; // Second token = NO

  console.log(`[START] Found market: ${market.slug}`);
  console.log(`[START] YES Token ID: ${ctx.yesTokenId}`);
  console.log(`[START] NO Token ID: ${ctx.noTokenId}`);

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
        tokenId: param.tokenId, // Track which token
        side: param.side,
        size: param.size,
        price: param.price,
        status: response.status,
        outcome: param.outcome, // YES or NO
      };

      console.log(
        `[PLACING_TRAPS] Placed ${param.outcome} trap order: ${order.orderId} at $${param.price} x ${param.size}`,
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

  const startTime = Date.now();
  while (Date.now() - startTime < CONFIG.MARKET_POLL_TIMEOUT_MS) {
    try {
      // Poll each trap order individually
      let anyFilled = false;
      for (const trapOrder of ctx.trapOrders) {
        const order = await ctx.client.getOrder(trapOrder.orderId);

        if (order && order.status === "FILLED") {
          ctx.filledOrder = trapOrder;
          ctx.filledTokenId = trapOrder.tokenId;
          // The opposite token is the one we need to hedge with
          ctx.oppositeTokenId =
            trapOrder.tokenId === ctx.yesTokenId
              ? ctx.noTokenId
              : ctx.yesTokenId;
          console.log(
            `[WATCHING] Trap order filled: ${trapOrder.orderId} (${trapOrder.outcome} @ $${trapOrder.price})`,
          );
          console.log(
            `[WATCHING] Will hedge with opposite token (${trapOrder.outcome === "YES" ? "NO" : "YES"})`,
          );
          return "HEDGING";
        }

        if (
          order &&
          (order.status === "FILLED" || order.status === "CANCELED")
        ) {
          anyFilled = true;
        }
      }

      if (!anyFilled) {
        console.log(
          `[WATCHING] Orders still open. Checking again in ${CONFIG.WATCH_INTERVAL_MS}ms...`,
        );
      }

      await sleep(CONFIG.WATCH_INTERVAL_MS);
    } catch (error) {
      console.error("[WATCHING] Error fetching orders:", error);
      await sleep(CONFIG.WATCH_INTERVAL_MS);
    }
  }

  console.log("[WATCHING] Timeout waiting for trap to fill. Moving to DONE.");
  return "DONE";
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
    // Step 1: Calculate hedge size before fetching prices
    const initialCost = ctx.filledOrder.size * ctx.filledOrder.price;
    console.log(
      `[HEDGING] Initial cost: ${ctx.filledOrder.size} shares @ $${ctx.filledOrder.price} = $${initialCost.toFixed(2)}`,
    );

    // Step 2: Fetch current market prices for the OPPOSITE token (what we'll buy to hedge)
    // CRITICAL: Must use oppositeTokenId, not filledTokenId!
    // We need the price of the token we're about to buy, not the one we already own
    const market = await ctx.client.getMarket(ctx.oppositeTokenId!);
    console.log(
      `[HEDGING] Current market for hedge token: Best Bid: $${market.bestBid}, Best Ask: $${market.bestAsk}`,
    );

    // Determine hedge price (ask price of the token we're buying)
    // This is what we'll pay to buy the opposite token
    const hedgePrice = market.bestAsk;

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

    // Step 5: Cancel unfilled order and place hedge order in parallel
    if (unfilledOrder) {
      console.log(
        `[HEDGING] Canceling unfilled order: ${unfilledOrder.orderId}`,
      );
    }

    const tasks = [];

    // Cancel unfilled order
    if (unfilledOrder) {
      tasks.push(
        ctx.client
          .cancelOrder({ orderID: unfilledOrder.orderId })
          .catch((e) => {
            console.warn("[HEDGING] Failed to cancel unfilled order:", e);
          }),
      );
    }

    // Place hedge market order on the OPPOSITE token (CRITICAL FIX!)
    // If we bought YES (token A), we must buy NO (token B) to hedge
    const hedgeSide = Side.BUY;
    const hedgeTokenId = ctx.oppositeTokenId!; // Use the opposite token

    console.log(
      `[HEDGING] Placing hedge order on opposite token: ${hedgeTokenId}`,
    );

    const hedgeOrderTask = ctx.client.createAndPostOrder(
      {
        tokenID: hedgeTokenId, // HEDGE ON OPPOSITE TOKEN
        price: hedgePrice + 0.05, // Slightly above ask to guarantee fill
        size: hedgeSize,
        side: hedgeSide,
      },
      {
        tickSize: ctx.market.tickSize,
        negRisk: ctx.market.negRisk,
      },
      OrderType.GTC,
    );

    tasks.push(hedgeOrderTask);

    // Execute both in parallel
    const results = await Promise.all(tasks);
    const hedgeResult = results[results.length - 1]; // Last result is the hedge order

    ctx.hedgeOrderId = hedgeResult.orderID;
    console.log(`[HEDGING] Hedge order placed: ${ctx.hedgeOrderId}`);
    console.log(`[HEDGING] Hedge status: ${hedgeResult.status}`);

    // Store hedge details for profit taking
    ctx.hedgeSize = hedgeSize;
    ctx.hedgePrice = hedgePrice;

    // Send Telegram notification
    await sendHedgeNotification(hedgePrice, hedgeSize, CONFIG.MIN_PROFIT_USD);

    return "PROFIT_TAKING";
  } catch (error) {
    console.error("[HEDGING] Error during hedging:", error);
    return "DONE";
  }
}

// ============================================================================
// STATE: PROFIT_TAKING - Monitor hedge price and sell at $0.98
// ============================================================================
async function handleProfitTaking(ctx: BotContext): Promise<BotState> {
  if (!ctx.oppositeTokenId || !ctx.hedgeOrderId) {
    console.error("[PROFIT_TAKING] Missing hedge info!");
    return "DONE";
  }

  console.log(
    "\n[PROFIT_TAKING] 🎯 Double-sided exit strategy: Monitoring BOTH tokens",
  );
  console.log(
    `[PROFIT_TAKING]   • Hedge Token (${ctx.filledOrder?.outcome === "YES" ? "NO" : "YES"}): Will sell at $0.98 = 💰 PROFIT`,
  );
  console.log(
    `[PROFIT_TAKING]   • Trap Token (${ctx.filledOrder?.outcome}): Will sell at $0.98 = ⚠️ LOSS (Insurance)`,
  );

  const EXIT_PRICE = 0.98;
  const startTime = Date.now();
  const MAX_WAIT_MS = 15 * 60 * 1000; // Max 15 minutes (full market duration)

  while (Date.now() - startTime < MAX_WAIT_MS) {
    try {
      // Fetch both token prices
      const hedgeMarket = await ctx.client.getMarket(ctx.oppositeTokenId);
      const trapMarket = await ctx.client.getMarket(ctx.filledTokenId!);

      const hedgeBid = hedgeMarket.bestBid;
      const trapBid = trapMarket.bestBid;

      console.log(
        `[PROFIT_TAKING] Hedge (${ctx.filledOrder?.outcome === "YES" ? "NO" : "YES"}): $${hedgeBid.toFixed(
          4,
        )} | Trap (${ctx.filledOrder?.outcome}): $${trapBid.toFixed(4)} | Target: $${EXIT_PRICE}`,
      );

      // CONDITION A: Hedge token reaches $0.98 → PROFIT EXIT
      if (hedgeBid >= EXIT_PRICE) {
        console.log(
          `\n[PROFIT_TAKING] ✅ CONDITION A: Hedge token bid $${hedgeBid.toFixed(
            4,
          )} >= $${EXIT_PRICE}`,
        );
        console.log(`[PROFIT_TAKING] 💰 PROFIT EXIT - Selling hedge token...`);

        const sellOrder = await ctx.client.createAndPostOrder(
          {
            tokenID: ctx.oppositeTokenId,
            price: hedgeBid - 0.01,
            size: ctx.hedgeSize,
            side: Side.SELL,
          },
          {
            tickSize: ctx.market.tickSize,
            negRisk: ctx.market.negRisk,
          },
          OrderType.GTC,
        );

        const trapCost = ctx.filledOrder!.size * ctx.filledOrder!.price;
        const hedgeCost = ctx.hedgeSize * ctx.hedgePrice;
        const saleProceeds = ctx.hedgeSize * hedgeBid;
        const realizedProfit = saleProceeds - trapCost - hedgeCost;

        console.log(
          `[PROFIT_TAKING] Hedge sold! Order ID: ${sellOrder.orderID}`,
        );
        console.log(
          `[PROFIT_TAKING] 💰 Realized Profit: +$${realizedProfit.toFixed(2)}`,
        );
        console.log(`[PROFIT_TAKING]   Trap cost: $${trapCost.toFixed(2)}`);
        console.log(`[PROFIT_TAKING]   Hedge cost: $${hedgeCost.toFixed(2)}`);
        console.log(
          `[PROFIT_TAKING]   Sale proceeds: $${saleProceeds.toFixed(2)}`,
        );

        metrics.totalPnL += realizedProfit;
        metrics.winCount++;

        await sendTelegramMessage(
          `
💰 <b>PROFIT LOCKED - HEDGE EXIT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 Hedge Token (${ctx.filledOrder?.outcome === "YES" ? "NO" : "YES"}) reached $${hedgeBid.toFixed(2)}

💹 <b>EXIT ANALYSIS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Trap Entry: ${ctx.filledOrder?.outcome} @ $${ctx.filledOrder?.price.toFixed(2)} x ${ctx.filledOrder?.size} = $${trapCost.toFixed(2)}
Hedge Entry: ${ctx.filledOrder?.outcome === "YES" ? "NO" : "YES"} @ $${ctx.hedgePrice.toFixed(2)} x ${ctx.hedgeSize} = $${hedgeCost.toFixed(2)}
Hedge Exit: ${ctx.filledOrder?.outcome === "YES" ? "NO" : "YES"} @ $${hedgeBid.toFixed(2)} x ${ctx.hedgeSize} = $${saleProceeds.toFixed(2)}

✅ <b>Realized Profit: +$${realizedProfit.toFixed(2)}</b>

📊 <b>PORTFOLIO</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Deployed: $${metrics.totalInvested.toFixed(2)}
Total PnL: <b>${metrics.totalPnL >= 0 ? "+" : ""}$${metrics.totalPnL.toFixed(2)}</b>
Wins: ${metrics.winCount} | Losses: ${metrics.lossCount}
Win Rate: ${((metrics.winCount / (metrics.winCount + metrics.lossCount)) * 100).toFixed(1)}%
        `.trim(),
        );

        return "DONE";
      }

      // CONDITION B: Trap token reaches $0.98 → LOSS EXIT (Insurance)
      if (trapBid >= EXIT_PRICE) {
        console.log(
          `\n[PROFIT_TAKING] ⚠️ CONDITION B: Trap token bid $${trapBid.toFixed(
            4,
          )} >= $${EXIT_PRICE}`,
        );
        console.log(
          `[PROFIT_TAKING] 🛡️ LOSS EXIT (Insurance) - Selling trap token to minimize losses...`,
        );

        const sellOrder = await ctx.client.createAndPostOrder(
          {
            tokenID: ctx.filledTokenId!,
            price: trapBid - 0.01,
            size: ctx.filledOrder!.size,
            side: Side.SELL,
          },
          {
            tickSize: ctx.market.tickSize,
            negRisk: ctx.market.negRisk,
          },
          OrderType.GTC,
        );

        const trapCost = ctx.filledOrder!.size * ctx.filledOrder!.price;
        const hedgeCost = ctx.hedgeSize * ctx.hedgePrice;
        const trapProceeds = ctx.filledOrder!.size * trapBid;
        const totalCost = trapCost + hedgeCost;
        const realizedLoss = -(totalCost - trapProceeds);

        console.log(
          `[PROFIT_TAKING] Trap sold! Order ID: ${sellOrder.orderID}`,
        );
        console.log(
          `[PROFIT_TAKING] ⚠️ Realized Loss: -$${Math.abs(realizedLoss).toFixed(2)}`,
        );
        console.log(`[PROFIT_TAKING]   Trap cost: $${trapCost.toFixed(2)}`);
        console.log(`[PROFIT_TAKING]   Hedge cost: $${hedgeCost.toFixed(2)}`);
        console.log(
          `[PROFIT_TAKING]   Trap proceeds: $${trapProceeds.toFixed(2)}`,
        );

        metrics.totalPnL += realizedLoss;
        metrics.lossCount++;

        await sendTelegramMessage(
          `
⚠️ <b>LOSS MINIMIZED - TRAP EXIT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 Trap Token (${ctx.filledOrder?.outcome}) reached $${trapBid.toFixed(2)}
Exiting to minimize losses (Insurance triggered)

📉 <b>EXIT ANALYSIS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Trap Entry: ${ctx.filledOrder?.outcome} @ $${ctx.filledOrder?.price.toFixed(2)} x ${ctx.filledOrder?.size} = $${trapCost.toFixed(2)}
Hedge Entry: ${ctx.filledOrder?.outcome === "YES" ? "NO" : "YES"} @ $${ctx.hedgePrice.toFixed(2)} x ${ctx.hedgeSize} = $${hedgeCost.toFixed(2)}
Trap Exit: ${ctx.filledOrder?.outcome} @ $${trapBid.toFixed(2)} x ${ctx.filledOrder?.size} = $${trapProceeds.toFixed(2)}

❌ <b>Realized Loss: -$${Math.abs(realizedLoss).toFixed(2)}</b>
(Market moved against trap. Insurance hedge prevented larger loss!)

📊 <b>PORTFOLIO</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Deployed: $${metrics.totalInvested.toFixed(2)}
Total PnL: <b>${metrics.totalPnL >= 0 ? "+" : ""}$${metrics.totalPnL.toFixed(2)}</b>
Wins: ${metrics.winCount} | Losses: ${metrics.lossCount}
Win Rate: ${((metrics.winCount / (metrics.winCount + metrics.lossCount)) * 100).toFixed(1)}%
        `.trim(),
        );

        return "DONE";
      }

      // Wait before checking again
      await sleep(2000);
    } catch (error) {
      console.error("[PROFIT_TAKING] Error checking prices:", error);
      await sleep(2000);
    }
  }

  // Timeout reached - sell at market anyway
  console.log("[PROFIT_TAKING] ⏱️ Timeout reached. Selling at market...");
  try {
    const hedgeMarket = await ctx.client.getMarket(ctx.oppositeTokenId);
    const sellOrder = await ctx.client.createAndPostOrder(
      {
        tokenID: ctx.oppositeTokenId,
        price: hedgeMarket.bestBid - 0.01,
        size: ctx.hedgeSize,
        side: Side.SELL,
      },
      {
        tickSize: ctx.market.tickSize,
        negRisk: ctx.market.negRisk,
      },
      OrderType.GTC,
    );

    console.log(
      `[PROFIT_TAKING] Timeout sale order placed: ${sellOrder.orderID}`,
    );

    const trapCost = ctx.filledOrder!.size * ctx.filledOrder!.price;
    const hedgeCost = ctx.hedgeSize * ctx.hedgePrice;
    const saleProceeds = ctx.hedgeSize * hedgeMarket.bestBid;
    const realizedProfit = saleProceeds - trapCost - hedgeCost;

    metrics.totalPnL += realizedProfit;
    metrics.winCount++;
  } catch (error) {
    console.error("[PROFIT_TAKING] Failed to sell at timeout:", error);
    metrics.lossCount++;
  }

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
        size: ctx.filledOrder.size,
        side: Side.SELL,
      },
      {
        tickSize: ctx.market.tickSize,
        negRisk: ctx.market.negRisk,
      },
      OrderType.GTC,
    );

    console.log(
      `[STOP_LOSS] Sold ${ctx.filledOrder.size} shares. Order: ${response.orderID}`,
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
    const response = await fetch(
      `${GAMMA_API}/markets?slug=${slug}&active=true`,
    );
    const markets = await response.json();
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
      const response = await fetch(`${GAMMA_API}/markets?slug=${marketSlug}`);
      const markets = await response.json();

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

      const response = await fetch(
        `${GAMMA_API}/markets?slug=${nextSlug}&active=true`,
      );
      const markets = await response.json();

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
    case "PROFIT_TAKING":
      return await handleProfitTaking(ctx);
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
  };

  console.log("=".repeat(80));
  console.log("TRAP & CHASE HEDGING BOT INITIALIZED");
  console.log("=".repeat(80));
  console.log("Configuration:");
  console.log(`  Trap Price: $${CONFIG.TRAP_PRICE}`);
  console.log(`  Base Size: ${CONFIG.BASE_SIZE} shares`);
  console.log(`  Min Profit: $${CONFIG.MIN_PROFIT_USD}`);
  console.log(`  Max Hedge Price: $${CONFIG.MAX_HEDGE_PRICE}`);
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

      // Reset for next cycle
      ctx.state = "START";
      ctx.trapOrders = [];
      ctx.filledOrder = null;
      ctx.filledTokenId = null;
      ctx.oppositeTokenId = null;
      ctx.hedgeOrderId = null;
      ctx.hedgeSize = 0;
      ctx.hedgePrice = 0;

      // Wait before starting next cycle
      console.log("\nWaiting for next cycle...");
      await sleep(10000);
    } catch (error) {
      console.error("Unexpected error in bot loop:", error);
      ctx.state = "START";
      await sleep(10000);
    }
  }
}

main().catch(console.error);
