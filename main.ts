// Pump.fun Replay Sprint — Paper Bot, Real Ranking
//
// A momentum bot for the agent-fun/replay/v2 harness. It trades 10 SOL of
// paper money on a replay of pump.fun bonding-curve activity and is scored
// on net PnL over the final 24h window. Nothing is traded for real.
//
// The idea, from first principles about bonding curves: a coin's price only
// moves when trades happen, so a coin nobody buys stays flat and a coin
// people keep buying runs up. The dev window's own data says the shape of
// it: of 1,222 coins, only 8% end below their creation price, 23% reach
// twice it and 6% reach ten times it — the money is in the fat right tail.
// The bot therefore buys every coin as early as the size cap allows, one
// 0.05 SOL stake per coin and at most 5 open positions, and manages each
// position with a 2x take-profit, a -20% stop, a trailing stop that arms
// at 2x and sells at 60% of the peak, and a time exit that only frees the
// slot of a coin still flat after 150,000 slots. The parameters were tuned
// on an offline replay of the kit's dev data, where this shape came out
// closest to breakeven while still trading far more than the 20 coins the
// guardrail needs: tighter stops churn more coins and bleed on fees, while
// no time exit at all leaves too few coins to qualify.
//
// Determinism: every decision comes from the harness state and the current
// batch only — no clock, no environment, no randomness — so the two grading
// runs produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from "./vendor/makefun-bot.ts";

// One stake per coin: 0.05 SOL. A round trip on it costs about 2.5% in
// curve fees plus two tx fees, so exits need moves well past that to pay.
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n;
// A buy only counts when the size cap lets it spend at least this much:
// the cap is 1% of the coin's real SOL reserve, so this also means the
// coin has attracted at least 2 SOL of real buying.
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 50n;
// No momentum filter and no minimum trade count: the entry is as early
// as the size cap allows. The dev data says why: of 1,222 coins, only 8%
// end below their creation price, while 23% reach 2x and 6% reach 10x —
// the money is in the fat right tail, so the entry must be cheap and the
// exits must not cap it. v1/v2 bought after a +10% run and sold at a
// fixed take-profit, which threw the tail away and bled on fees.
// Exits, as multiples of the filled entry price. Tuned on an offline
// replay of the dev window (the kit's own data): the take-profit at 2x
// banks the common winners, the -20% stop cuts real dumps, the trailing
// stop arms at 2x and sells at 60% of the peak so a 10x runner that
// retraces still banks a multiple, and the time exit only fires for a
// position held 150,000 slots while still flat — it exists to turn the
// slot over, because the guardrail needs a round trip on at least 20
// coins, and without it the bot holds too few coins to qualify.
const TAKE_PROFIT_NUM = 2; // sell everything at +100%
const TAKE_PROFIT_DEN = 1;
const STOP_LOSS_NUM = 4; // sell everything at -20%
const STOP_LOSS_DEN = 5;
const TRAIL_ARM_NUM = 2; // trailing stop arms once the price doubles
const TRAIL_ARM_DEN = 1;
const TRAIL_DROP_NUM = 3; // then sell when it falls to 60% of the peak
const TRAIL_DROP_DEN = 5;
// A dud ties up one of 5 slots: after this many slots, sell it unless it
// is already running (at least 10% up), so the slot turns over to a fresh
// coin. Winners keep their slot.
const MAX_HOLD_SLOTS = 150_000;
const TIME_EXIT_NUM = 11; // time exit only below +10%
const TIME_EXIT_DEN = 10;
// Fills land 2 slots after the decision; allow the price to move 10%
// in that time before refusing the fill.
const MAX_SLIPPAGE_BPS = 1000;

interface Track {
  /** Price (SOL per token) at the coin's CreateEvent. */
  createdPrice: number;
  /** Highest price seen since the coin appeared. */
  peak: number;
  /** A buy decision has been made for this coin (bought, or dropped). */
  decided: boolean;
  /** Filled entry price, 0 while not holding. */
  buyPrice: number;
  /** Slot the buy filled at. */
  buySlot: number;
  /** Highest price since the buy filled. */
  peakSinceBuy: number;
}

const tracks = new Map<string, Track>();

function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

await runBot({
  onBatch(state: BotState, batch: Batch): Array<BuyInput | SellInput> {
    // Fold this batch's fills in first: a buy fill sets the true entry
    // price (quote spent over tokens received), which the exits measure
    // against. The state already holds the post-fill account.
    for (const fill of batch.fills) {
      const track = tracks.get(fill.mint);
      if (track === undefined) continue;
      if (fill.status === "filled" && fill.side === "buy") {
        const tokens = BigInt(fill.token_amount);
        const quote = BigInt(fill.quote_lamports);
        if (tokens > 0n) {
          track.buyPrice = Number(quote) / Number(tokens);
          track.buySlot = fill.slot;
          track.peakSinceBuy = track.buyPrice;
        }
      }
    }
    // A position the account no longer holds has no entry price anymore:
    // it was closed by a sell, by the curve completing, or by flattening.
    for (const [mint, track] of tracks) {
      if (track.buyPrice !== 0 && !state.positions.has(mint)) {
        track.buyPrice = 0;
        track.buySlot = 0;
        track.peakSinceBuy = 0;
      }
    }

    // Refresh peaks from the curves' latest reserves, and register new
    // coins from this batch's CreateEvents.
    for (const event of batch.events) {
      if (event.event === "CreateEvent") {
        if (!tracks.has(event.mint)) {
          const price = priceOf(
            BigInt(event.virtual_quote_reserves),
            BigInt(event.virtual_token_reserves),
          );
          tracks.set(event.mint, {
            createdPrice: price,
            peak: price,
            decided: false,
            buyPrice: 0,
            buySlot: 0,
            peakSinceBuy: 0,
          });
        }
      } else if (event.event === "CompleteEvent") {
        tracks.delete(event.mint);
      }
    }
    for (const [mint, curve] of state.curves) {
      const track = tracks.get(mint);
      if (track === undefined || curve.complete) continue;
      const price = priceOf(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
      );
      if (price > track.peak) track.peak = price;
      if (track.buyPrice !== 0 && price > track.peakSinceBuy) {
        track.peakSinceBuy = price;
      }
    }

    const orders: Array<BuyInput | SellInput> = [];
    const caps = state.hello.caps;

    // Sells first: exits free the position slot before buys are sized.
    for (const [mint, holding] of state.positions) {
      let track = tracks.get(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
      );
      if (track === undefined) {
        // A holding whose creation we never saw (first seen via a mark):
        // treat the current price as its entry so it can still be exited.
        track = {
          createdPrice: price,
          peak: price,
          decided: true,
          buyPrice: price,
          buySlot: state.slot,
          peakSinceBuy: price,
        };
        tracks.set(mint, track);
      }
      if (track.buyPrice === 0) continue;
      // Never send two sells for one mint: one is already in flight.
      let sellPending = false;
      for (const pending of state.pending.values()) {
        if (pending.order.side === "sell" && pending.order.mint === mint) {
          sellPending = true;
          break;
        }
      }
      if (sellPending) continue;
      const entry = track.buyPrice;
      const heldSlots = state.slot - track.buySlot;
      const takeProfit =
        price * TAKE_PROFIT_DEN >= entry * TAKE_PROFIT_NUM;
      const stopLoss =
        price * STOP_LOSS_DEN <= entry * STOP_LOSS_NUM;
      const trailing =
        track.peakSinceBuy * TRAIL_ARM_DEN >= entry * TRAIL_ARM_NUM &&
        price * TRAIL_DROP_DEN <= track.peakSinceBuy * TRAIL_DROP_NUM;
      const timedOut =
        heldSlots > MAX_HOLD_SLOTS &&
        price * TIME_EXIT_DEN < entry * TIME_EXIT_NUM;
      if (takeProfit || stopLoss || trailing || timedOut) {
        orders.push({
          side: "sell",
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }

    // Buys: walk this batch's events in order, deciding each candidate
    // coin once, on the first batch where its size cap allows a real buy.
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const event of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const mint = event.mint;
      const track = tracks.get(mint);
      if (track === undefined || track.decided) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        track.decided = true;
        continue;
      }
      if (state.positions.has(mint)) {
        track.decided = true;
        continue;
      }
      // A buy already in flight for this mint decides it too.
      let buyPending = false;
      for (const pending of state.pending.values()) {
        if (pending.order.side === "buy" && pending.order.mint === mint) {
          buyPending = true;
          break;
        }
      }
      if (buyPending) {
        track.decided = true;
        continue;
      }
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (slots <= 0 || free < amount + tx) continue;
      orders.push({
        side: "buy",
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      track.decided = true;
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },
});
