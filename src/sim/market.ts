// Markets: a station trades a handful of goods. Each has a stock, a base price and a base stock; the
// price follows the stock, what the player sells into it lowers it and what they buy raises it, and
// while the player is away the stock drifts back toward its base. Prices the player has seen are
// remembered with when, so the chart can show what a place paid the last time anyone looked.
import type { MarketEntry, PriceSeen, Station, World } from './world';

export const GOODS = ['ore', 'salvage'] as const;
export type Good = typeof GOODS[number];

/** How long a disturbed stock takes to mostly recover, in sector seconds. */
export const STOCK_RELAX_SECONDS = 600;

export function makeMarket(spec: Partial<Record<Good, { base: number; stock: number; buys?: boolean; sells?: boolean }>>): Record<string, MarketEntry> {
  const m: Record<string, MarketEntry> = {};
  for (const g of GOODS) {
    const e = spec[g];
    if (!e) continue;
    m[g] = { stock: e.stock, base: e.base, baseStock: e.stock, buys: e.buys ?? true, sells: e.sells ?? false };
  }
  return m;
}

/** The price of a good at a station right now: scarce is dear, glutted is cheap. */
export function priceOf(e: MarketEntry): number {
  const k = e.baseStock > 0 ? e.stock / (2 * e.baseStock) : 0.5;
  return Math.max(1, Math.round(e.base * Math.min(1.9, Math.max(0.55, 1.5 - k))));
}

/** What the station pays for one unit (it pays a little under its own price). */
export function bidOf(e: MarketEntry): number { return Math.max(1, Math.round(priceOf(e) * 0.9)); }

/** The player sells n units into the station. Returns credits paid. */
export function sellTo(st: Station, good: Good, n: number): number {
  const e = st.market?.[good];
  if (!e || !e.buys || n <= 0) return 0;
  let paid = 0;
  for (let i = 0; i < n; i++) { paid += bidOf(e); e.stock += 1; }
  return paid;
}

/** The player buys n units from the station. Returns credits charged, or the number actually bought via out. */
export function buyFrom(st: Station, good: Good, n: number, credits: number): { bought: number; cost: number } {
  const e = st.market?.[good];
  if (!e || !e.sells) return { bought: 0, cost: 0 };
  let bought = 0, cost = 0;
  for (let i = 0; i < n; i++) {
    if (e.stock <= 0) break;
    const p = priceOf(e);
    if (cost + p > credits) break;
    cost += p; e.stock -= 1; bought++;
  }
  return { bought, cost };
}

/** Stocks drift back toward base while nobody is trading. */
export function relaxMarket(st: Station, elapsed: number): void {
  if (!st.market || elapsed <= 0) return;
  const k = 1 - Math.exp(-elapsed / STOCK_RELAX_SECONDS);
  for (const e of Object.values(st.market)) e.stock = Math.round(e.stock + (e.baseStock - e.stock) * k);
}

/** Note what a station's prices are, for the chart. */
export function recordPrices(w: World, st: Station, sectorTime: number): void {
  if (!st.market) return;
  for (const [good, e] of Object.entries(st.market)) {
    const seen: PriceSeen = { system: w.systemId, station: st.name, good, price: priceOf(e), time: sectorTime };
    const i = w.pricesSeen.findIndex(q => q.station === st.name && q.good === good && q.system === w.systemId);
    if (i >= 0) w.pricesSeen[i] = seen; else w.pricesSeen.push(seen);
  }
}
