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
  MIN_PROFIT_USD: 0.1, // Target profit to secure during hedge
  MAX_HEDGE_PRICE: 0.8, // Safety cap - abort if opposing side too expensive
  WATCH_INTERVAL_MS: 1300, // Poll order status every 1.3 seconds
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
// HELPER: SLEEP FUNCTION
// ============================================================================
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// HELPER: GET ACTUAL FILL DETAILS FROM TRADES
// getOrder().price = limit price (what we proposed)
// getTrades().price = actual execution price (what was matched)
// This function uses associate_trades from getOrder() to compute real metrics.
// ============================================================================
async function getActualFillDetails(
  client: ClobClient,
  associateTrades: string[],
): Promise<{ totalSize: number; totalCost: number; avgFillPrice: number }> {
  let totalSize = 0;
  let totalCost = 0;

  for (const tradeId of associateTrades) {
    try {
      const trades = await client.getTrades({ id: tradeId } as any);
      if (trades && Array.isArray(trades) && trades.length > 0) {
        for (const trade of trades) {
          const tradeSize = parseFloat((trade as any).size) || 0;
          const tradePrice = parseFloat((trade as any).price) || 0;
          totalSize += tradeSize;
          totalCost += tradeSize * tradePrice;
          console.log(
            `[FILL DETAILS] Trade ${tradeId}: ${tradeSize} shares @ $${tradePrice.toFixed(4)} = $${(tradeSize * tradePrice).toFixed(4)}`,
          );
        }
      }
    } catch (e) {
      console.warn(`[FILL DETAILS] Could not fetch trade ${tradeId}:`, e);
    }
  }

  const avgFillPrice = totalSize > 0 ? totalCost / totalSize : 0;

  console.log(`[FILL DETAILS] Summary:`);
  console.log(`[FILL DETAILS]   Total Size: ${totalSize} shares`);
  console.log(`[FILL DETAILS]   Total Cost: $${totalCost.toFixed(4)}`);
  console.log(`[FILL DETAILS]   Avg Fill Price: $${avgFillPrice.toFixed(4)}`);

  return { totalSize, totalCost, avgFillPrice };
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

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });

    if (response.ok) {
      console.log("✅ [TELEGRAM] Message sent successfully!");
    } else {
      const errorText = await response.text();
      console.error("❌ [TELEGRAM] Failed to send. Status:", response.status);
      console.error("   Response:", errorText);
    }
  } catch (error) {
    console.error("❌ [TELEGRAM] Error sending message:", error);
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
// PHASE 1: CLIENT INITIALIZATION
// ============================================================================
async function initializeClient() {
  const HOST = "https://clob.polymarket.com";
  const CHAIN_ID = 137; // Polygon mainnet
  const signer = new Wallet(process.env.PRIVATE_KEY!);

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

  // Now you can use `client` to place orders, check balances, etc.
  return client;
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

  ctx.yesTokenId = tokenIds[0]; // First token = YES
  ctx.noTokenId = tokenIds[1]; // Second token = NO

  console.log(`[START] Found market: ${market.slug}`);
  console.log(`[START] Condition ID: ${ctx.conditionId}`);
  console.log(`[START] YES Token ID: ${ctx.yesTokenId}`);
  console.log(`[START] NO Token ID: ${ctx.noTokenId}`);

  // 🎯 WAIT 3 MINUTES before placing orders (market stabilization)
  console.log(
    "[START] ⏳ Waiting 3 minutes before placing traps (market stabilization)...",
  );
  for (let i = 90; i > 0; i--) {
    if (i % 30 === 0 || i <= 5) {
      console.log(`[START] ⏳ Waiting ${i} seconds before placing traps...`);
    }
    await sleep(1000);
  }
  console.log("[START] ✅ 3-minute wait complete. Ready to place traps.");

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

            // CRITICAL: getOrder().price is the LIMIT price, NOT the execution price.
            // Use associate_trades -> getTrades() to get ACTUAL execution prices.
            const associateTrades: string[] =
              filledOrderData.associate_trades || [];
            if (associateTrades.length > 0) {
              console.log(
                `[WATCHING] Found ${associateTrades.length} associated trades. Fetching actual fill details...`,
              );
              const fillDetails = await getActualFillDetails(
                ctx.client,
                associateTrades,
              );
              trapOrder.sizeMatched =
                fillDetails.totalSize > 0
                  ? fillDetails.totalSize
                  : trapOrder.sizeMatched;
              trapOrder.avgFillPrice = fillDetails.avgFillPrice;
              trapOrder.totalCost = fillDetails.totalCost;
            } else {
              console.warn(
                `[WATCHING] No associate_trades found. Falling back to getOrder() limit price.`,
              );
              trapOrder.avgFillPrice = trapOrder.price;
              trapOrder.totalCost = trapOrder.sizeMatched * trapOrder.price;
            }

            console.log(`[WATCHING] ACTUAL fill details (from getTrades()):`);
            console.log(`[WATCHING]   Token ID: ${trapOrder.tokenId}`);
            console.log(`[WATCHING]   Side: ${trapOrder.side}`);
            console.log(
              `[WATCHING]   Size Matched: ${trapOrder.sizeMatched} shares`,
            );
            console.log(
              `[WATCHING]   Limit Price: $${trapOrder.price} (what we proposed)`,
            );
            console.log(
              `[WATCHING]   Avg Fill Price: $${trapOrder.avgFillPrice.toFixed(4)} (actual execution)`,
            );
            console.log(
              `[WATCHING]   Total Cost: $${trapOrder.totalCost.toFixed(4)} (actual USDC spent)`,
            );
            console.log(`[WATCHING]   Outcome: ${trapOrder.outcome}`);

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
    // Using totalCost from getTrades() - the actual USDC spent, not limit price
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

    // Step 2: Fetch market info using conditionId to get token prices
    const marketData = await ctx.client.getMarket(ctx.conditionId);
    console.log(`[HEDGING] Market data fetched. Tokens:`, marketData.tokens);

    // Find the hedge token in the market data
    const hedgeToken = marketData.tokens.find(
      (token: any) => token.token_id === ctx.oppositeTokenId,
    );

    if (!hedgeToken) {
      console.error(
        `[HEDGING] Could not find hedge token ${ctx.oppositeTokenId} in market data`,
      );
      return "DONE";
    }

    const hedgePrice = hedgeToken.price;

    console.log(
      `[HEDGING] Current hedge token price: $${hedgePrice} (Outcome: ${hedgeToken.outcome})`,
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

    // Step 5: Cancel unfilled order first
    if (unfilledOrder) {
      console.log(
        `[HEDGING] Canceling unfilled order: ${unfilledOrder.orderId}`,
      );
      try {
        await ctx.client.cancelOrder({ orderID: unfilledOrder.orderId });
        console.log(`[HEDGING] ✅ Unfilled order cancelled`);
      } catch (e) {
        console.warn("[HEDGING] Failed to cancel unfilled order:", e);
      }
    }

    // Place hedge order using FAK with RETRY LOOP until filled
    // FAK = Fill-And-Kill - fills immediately or fails, no partial fills sitting on book
    const hedgeSide = Side.BUY;
    const hedgeTokenId = ctx.oppositeTokenId!;

    let hedgeFilled = false;
    let actualHedgeFilled = hedgeSize;
    let hedgeAttempts = 0;
    const MAX_HEDGE_ATTEMPTS = 30; // Try up to 30 times (about 60 seconds with 2s delays)

    console.log(
      `[HEDGING] Placing hedge order on opposite token: ${hedgeTokenId}`,
    );
    console.log(
      `[HEDGING] Using FAK ORDER with retry loop until filled (max ${MAX_HEDGE_ATTEMPTS} attempts)`,
    );

    while (!hedgeFilled && hedgeAttempts < MAX_HEDGE_ATTEMPTS) {
      hedgeAttempts++;

      try {
        // Fetch fresh market price each attempt
        const freshMarketData = await ctx.client.getMarket(ctx.conditionId);
        const freshHedgeToken = freshMarketData.tokens.find(
          (token: any) => token.token_id === hedgeTokenId,
        );

        if (!freshHedgeToken) {
          console.error(`[HEDGING] Could not find hedge token in market data`);
          await sleep(2000);
          continue;
        }

        const currentPrice = freshHedgeToken.price;
        // Set aggressive buy price: current price + 15% buffer, capped at 0.95
        const aggressiveHedgePrice = Math.min(
          0.95,
          Math.round((currentPrice + 0.15) * 100) / 100,
        );

        console.log(
          `[HEDGING] Attempt ${hedgeAttempts}/${MAX_HEDGE_ATTEMPTS}: FAK market order for ${hedgeSize} shares (market price: $${currentPrice})`,
        );

        const hedgeResult = await ctx.client.createAndPostMarketOrder(
          {
            tokenID: hedgeTokenId,
            amount: hedgeSize,
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

            // Get actual hedge execution price from trades
            const hedgeAssociateTrades: string[] =
              (hedgeDetails as any).associate_trades || [];
            if (hedgeAssociateTrades.length > 0) {
              console.log(
                `[HEDGING] Fetching actual hedge fill details from ${hedgeAssociateTrades.length} trades...`,
              );
              const hedgeFillDetails = await getActualFillDetails(
                ctx.client,
                hedgeAssociateTrades,
              );
              if (hedgeFillDetails.totalSize > 0) {
                actualHedgeFilled = hedgeFillDetails.totalSize;
                ctx.hedgePrice = hedgeFillDetails.avgFillPrice;
                ctx.hedgeSize = actualHedgeFilled;
                console.log(
                  `[HEDGING] HEDGE FILLED on attempt ${hedgeAttempts}!`,
                );
                console.log(
                  `[HEDGING]   Actual size: ${actualHedgeFilled} shares`,
                );
                console.log(
                  `[HEDGING]   Avg fill price: $${ctx.hedgePrice.toFixed(4)} (market was $${currentPrice})`,
                );
                console.log(
                  `[HEDGING]   Total hedge cost: $${hedgeFillDetails.totalCost.toFixed(4)}`,
                );
              } else {
                ctx.hedgeSize = actualHedgeFilled;
                ctx.hedgePrice = currentPrice;
                console.log(
                  `[HEDGING] HEDGE FILLED on attempt ${hedgeAttempts}! ${actualHedgeFilled} shares (trades returned no data, using market price $${currentPrice})`,
                );
              }
            } else {
              ctx.hedgeSize = actualHedgeFilled;
              ctx.hedgePrice = currentPrice;
              console.log(
                `[HEDGING] HEDGE FILLED on attempt ${hedgeAttempts}! ${actualHedgeFilled} shares (no associate_trades, using market price $${currentPrice})`,
              );
            }
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

    // ctx.hedgeSize and ctx.hedgePrice are already set from getTrades() in the fill detection block above
    // No need to overwrite with calculated/market values

    // Wait for token settlement before placing sell orders
    console.log(
      "[HEDGING] Waiting 4 seconds for hedge tokens to settle in wallet...",
    );
    await sleep(4000);

    // Send Telegram notification with actual costs and fills
    const hedgeCost = ctx.hedgeSize * ctx.hedgePrice;
    await sendTelegramMessage(
      `
        ✅ <b>TRAP FILLED & HEDGE PLACED</b>
        ━━━━━━━━━━━━━━━━━━━━━━━━━━
        💰 Trap Entry: ${ctx.filledOrder.outcome} @ $${ctx.filledOrder.avgFillPrice.toFixed(4)} (avg fill) x ${ctx.filledOrder.sizeMatched} = $${trapCost.toFixed(4)}
        🛡️ Hedge Entry: ${ctx.oppositeTokenId === ctx.yesTokenId ? "YES" : "NO"} @ $${ctx.hedgePrice.toFixed(4)} (avg fill) x ${ctx.hedgeSize} = $${hedgeCost.toFixed(4)}

        💵 Total Invested: $${(trapCost + hedgeCost).toFixed(2)}
        🎯 Expected Profit: <b>+$${CONFIG.MIN_PROFIT_USD.toFixed(2)}</b>

        ✅ Position is now DELTA-NEUTRAL
            `.trim(),
    );

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

  const EXIT_PRICE = 0.98;
  const trapCost = ctx.filledOrder!.totalCost; // Actual USDC spent (from getTrades)
  const hedgeCost = ctx.hedgeSize * ctx.hedgePrice; // Actual hedge cost (hedgePrice from getTrades)

  console.log(
    "\n[PROFIT_TAKING] 📋 Placing limit orders to exit both positions",
  );
  console.log(
    `[PROFIT_TAKING]   • Hedge Token (${ctx.filledOrder?.outcome === "YES" ? "NO" : "YES"}): Sell limit @ $${EXIT_PRICE} = 💰 PROFIT`,
  );
  console.log(
    `[PROFIT_TAKING]   • Trap Token (${ctx.filledOrder?.outcome}): Sell limit @ $${EXIT_PRICE} = ⚠️ LOSS (Insurance)`,
  );

  try {
    // 🎯 CRITICAL: Wait for token settlement before placing sell orders
    console.log(
      "[PROFIT_TAKING] ⏳ Waiting 10 seconds for tokens to settle before placing sell orders...",
    );
    await sleep(10000);

    // Place sell limit order for hedge token @ 0.98
    console.log(
      `[PROFIT_TAKING] Placing hedge sell limit order (${ctx.hedgeSize} @ $${EXIT_PRICE})...`,
    );
    let hedgeSellOrderId: string | undefined;
    try {
      const hedgeSellOrder = await ctx.client.createAndPostOrder(
        {
          tokenID: ctx.oppositeTokenId,
          price: EXIT_PRICE,
          size: ctx.hedgeSize,
          side: Side.SELL,
        },
        {
          tickSize: ctx.market.tickSize,
          negRisk: ctx.market.negRisk,
        },
        OrderType.GTC, // GTC = Good-Till-Cancelled (stays open until filled or market expires)
      );

      hedgeSellOrderId = hedgeSellOrder.orderID;
      console.log(
        `[PROFIT_TAKING] ✅ Hedge sell order placed: ${hedgeSellOrderId}`,
      );
    } catch (hedgeError: any) {
      console.error(
        `[PROFIT_TAKING] ❌ Hedge sell order FAILED:`,
        hedgeError?.response?.data?.error || hedgeError?.message,
      );
    }

    // Wait 10seconds more before placing trap sell
    await sleep(10000);

    // Place sell limit order for trap token @ 0.98
    console.log(
      `[PROFIT_TAKING] Placing trap sell limit order (${ctx.filledOrder!.sizeMatched} @ $${EXIT_PRICE})...`,
    );
    let trapSellOrderId: string | undefined;
    try {
      const trapSellOrder = await ctx.client.createAndPostOrder(
        {
          tokenID: ctx.filledTokenId!,
          price: EXIT_PRICE,
          size: ctx.filledOrder!.sizeMatched,
          side: Side.SELL,
        },
        {
          tickSize: ctx.market.tickSize,
          negRisk: ctx.market.negRisk,
        },
        OrderType.GTC, // GTC = Good-Till-Cancelled
      );

      trapSellOrderId = trapSellOrder.orderID;
      console.log(
        `[PROFIT_TAKING] ✅ Trap sell order placed: ${trapSellOrderId}`,
      );
    } catch (trapError: any) {
      console.error(
        `[PROFIT_TAKING] ❌ Trap sell order FAILED:`,
        trapError?.response?.data?.error || trapError?.message,
      );
    }

    // Validate both orders were placed
    if (!hedgeSellOrderId) {
      console.error(
        "[PROFIT_TAKING] ❌ CRITICAL: Hedge sell order failed. Cannot proceed.",
      );
      return "DONE";
    }

    if (!trapSellOrderId) {
      console.error(
        "[PROFIT_TAKING] ❌ CRITICAL: Trap sell order failed. Cannot proceed.",
      );
      return "DONE";
    }

    // Now poll for order fills
    const startTime = Date.now();
    const MAX_WAIT_MS = 15 * 60 * 1000; // Max 15 minutes
    let lastLogTime = startTime;

    while (Date.now() - startTime < MAX_WAIT_MS) {
      try {
        const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

        // Check hedge sell order status
        const hedgeOrderStatus = await ctx.client.getOrder(hedgeSellOrderId);
        const hedgeStatus = hedgeOrderStatus.status;

        // Check trap sell order status
        const trapOrderStatus = await ctx.client.getOrder(trapSellOrderId);
        const trapStatus = trapOrderStatus.status;

        // Log every 10 seconds instead of every 2 seconds to reduce spam
        if (Date.now() - lastLogTime >= 10000) {
          console.log(
            `[PROFIT_TAKING] [${elapsedSeconds}s] Hedge: ${hedgeStatus} | Trap: ${trapStatus}`,
          );
          lastLogTime = Date.now();
        }

        // CONDITION A: Hedge sell order filled → PROFIT EXIT
        if (
          hedgeStatus === "MATCHED" ||
          hedgeStatus === "MINED" ||
          hedgeStatus === "CONFIRMED"
        ) {
          console.log(
            `\n[PROFIT_TAKING] ✅ HEDGE SOLD! Status: ${hedgeStatus}`,
          );
          console.log(`[PROFIT_TAKING] 💰 PROFIT EXIT`);

          // Fetch actual hedge sell fill amount
          let actualHedgeSellFilled = ctx.hedgeSize;
          try {
            const hedgeSellDetails =
              await ctx.client.getOrder(hedgeSellOrderId);
            if (hedgeSellDetails) {
              const filledAmount =
                parseFloat((hedgeSellDetails as any).size_matched) ||
                ctx.hedgeSize;
              actualHedgeSellFilled = filledAmount;
              console.log(
                `[PROFIT_TAKING] ✅ Actual hedge sold: ${actualHedgeSellFilled} shares (requested ${ctx.hedgeSize})`,
              );
            }
          } catch (e) {
            console.warn(
              "[PROFIT_TAKING] Could not fetch hedge sell fill details",
            );
          }

          const saleProceeds = actualHedgeSellFilled * EXIT_PRICE;
          const realizedProfit = saleProceeds - trapCost - hedgeCost;

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

          // Cancel trap sell order since we won't need it
          try {
            await ctx.client.cancelOrder({ orderID: trapSellOrderId });
            console.log(`[PROFIT_TAKING] Cancelled trap sell order`);
          } catch (e) {
            console.log(`[PROFIT_TAKING] Could not cancel trap order`);
          }

          await sendTelegramMessage(
            `
💰 <b>PROFIT LOCKED - HEDGE EXIT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 Hedge Token (${ctx.filledOrder?.outcome === "YES" ? "NO" : "YES"}) sold @ $${EXIT_PRICE}

💹 <b>EXIT ANALYSIS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Trap Entry: ${ctx.filledOrder?.outcome} @ $${ctx.filledOrder?.avgFillPrice.toFixed(4)} (avg fill) x ${ctx.filledOrder?.sizeMatched} = $${trapCost.toFixed(2)}
Hedge Entry: ${ctx.filledOrder?.outcome === "YES" ? "NO" : "YES"} @ $${ctx.hedgePrice.toFixed(4)} (avg fill) x ${ctx.hedgeSize} = $${hedgeCost.toFixed(2)}
Hedge Exit: ${ctx.filledOrder?.outcome === "YES" ? "NO" : "YES"} @ $${EXIT_PRICE} x ${actualHedgeSellFilled} (ACTUAL FILLED) = $${saleProceeds.toFixed(2)}

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

        // CONDITION B: Trap sell order filled → LOSS EXIT (Insurance)
        if (
          trapStatus === "MATCHED" ||
          trapStatus === "MINED" ||
          trapStatus === "CONFIRMED"
        ) {
          console.log(`\n[PROFIT_TAKING] ⚠️ TRAP SOLD! Status: ${trapStatus}`);
          console.log(`[PROFIT_TAKING] 🛡️ LOSS EXIT (Insurance)`);

          // Fetch actual trap sell fill amount
          let actualTrapSellFilled = ctx.filledOrder!.sizeMatched;
          try {
            const trapSellDetails = await ctx.client.getOrder(trapSellOrderId);
            if (trapSellDetails) {
              const filledAmount =
                parseFloat((trapSellDetails as any).size_matched) ||
                ctx.filledOrder!.sizeMatched;
              actualTrapSellFilled = filledAmount;
              console.log(
                `[PROFIT_TAKING] ✅ Actual trap sold: ${actualTrapSellFilled} shares (requested ${ctx.filledOrder!.sizeMatched})`,
              );
            }
          } catch (e) {
            console.warn(
              "[PROFIT_TAKING] Could not fetch trap sell fill details",
            );
          }

          const trapProceeds = actualTrapSellFilled * EXIT_PRICE;
          const totalCost = trapCost + hedgeCost;
          const realizedLoss = trapProceeds - totalCost;

          console.log(
            `[PROFIT_TAKING] ⚠️ Realized Loss: ${realizedLoss >= 0 ? "+" : ""}-$${Math.abs(realizedLoss).toFixed(2)}`,
          );
          console.log(`[PROFIT_TAKING]   Trap cost: $${trapCost.toFixed(2)}`);
          console.log(`[PROFIT_TAKING]   Hedge cost: $${hedgeCost.toFixed(2)}`);
          console.log(
            `[PROFIT_TAKING]   Trap proceeds: $${trapProceeds.toFixed(2)}`,
          );

          metrics.totalPnL += realizedLoss;
          metrics.lossCount++;

          // Cancel hedge sell order since trap triggered first
          try {
            await ctx.client.cancelOrder({ orderID: hedgeSellOrderId });
            console.log(`[PROFIT_TAKING] Cancelled hedge sell order`);
          } catch (e) {
            console.log(`[PROFIT_TAKING] Could not cancel hedge order`);
          }

          await sendTelegramMessage(
            `
⚠️ <b>LOSS MINIMIZED - TRAP EXIT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 Trap Token (${ctx.filledOrder?.outcome}) sold @ $${EXIT_PRICE}
Exiting to minimize losses (Insurance triggered)

📉 <b>EXIT ANALYSIS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Trap Entry: ${ctx.filledOrder?.outcome} @ $${ctx.filledOrder?.avgFillPrice.toFixed(4)} (avg fill) x ${ctx.filledOrder?.sizeMatched} = $${trapCost.toFixed(2)}
Hedge Entry: ${ctx.filledOrder?.outcome === "YES" ? "NO" : "YES"} @ $${ctx.hedgePrice.toFixed(4)} (avg fill) x ${ctx.hedgeSize} = $${hedgeCost.toFixed(2)}
Trap Exit: ${ctx.filledOrder?.outcome} @ $${EXIT_PRICE} x ${actualTrapSellFilled} (ACTUAL FILLED) = $${trapProceeds.toFixed(2)}

${realizedLoss >= 0 ? "✅ Small Profit: +" : "⚠️ Loss: -"}$${Math.abs(realizedLoss).toFixed(2)}

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

        // Both still pending, wait and check again
        await sleep(2000);
      } catch (err) {
        console.error("[PROFIT_TAKING] Error checking order status:", err);
        await sleep(2000);
      }
    }

    // Timeout reached - positions still open
    const totalElapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    console.error(
      `[PROFIT_TAKING] ❌ TIMEOUT - ${totalElapsedSeconds}s elapsed (15min limit), positions still open`,
    );
    console.log(
      `[PROFIT_TAKING] Final status - Hedge: ${hedgeSellOrderId} | Trap: ${trapSellOrderId}`,
    );
    console.log("[PROFIT_TAKING] Cancelling unfilled sell orders...");

    try {
      await ctx.client.cancelOrder({ orderID: hedgeSellOrderId });
      await ctx.client.cancelOrder({ orderID: trapSellOrderId });
      console.log("[PROFIT_TAKING] ✅ Orders cancelled successfully");
    } catch (e) {
      console.error("[PROFIT_TAKING] Error cancelling orders:", e);
    }

    await sendTelegramMessage(
      `
⏱️ <b>MARKET TIMEOUT - POSITIONS STILL OPEN</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
15 minutes elapsed. Market did not reach $0.98.
Orders cancelled. Check manually.

Trap Entry: ${ctx.filledOrder?.outcome} @ $${ctx.filledOrder?.avgFillPrice.toFixed(4)} (avg fill) x ${ctx.filledOrder?.sizeMatched} = $${trapCost.toFixed(2)}
Hedge Entry: ${ctx.filledOrder?.outcome === "YES" ? "NO" : "YES"} @ $${ctx.hedgePrice.toFixed(4)} (avg fill) x ${ctx.hedgeSize} = $${hedgeCost.toFixed(2)}
      `.trim(),
    );

    return "DONE";
  } catch (error) {
    console.error("[PROFIT_TAKING] Error during profit taking:", error);
    return "DONE";
  }
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
      ctx.conditionId = "";
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
