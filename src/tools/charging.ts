/**
 * plan_charging: when to draw a given amount of energy between plug-in and
 * departure (e.g. an electric car), cheapest, greenest or balanced, in
 * quarter-hours that need not be contiguous, compared with charging right
 * away, with the savings in euros.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HOUR } from "../analysis.js";
import { ATTRIBUTION, type Region } from "../catalog.js";
import type { SmardClient } from "../smard.js";
import { berlinLocalToUtc, formatBerlin, parseTime } from "../time.js";
import { CRITERIA, GREEN_DEFINITION, WHOLESALE_NOTE, loadRows, scores, type Row } from "./best-hours.js";
import { InputError, READ_ONLY_REMOTE, commonFields, fmt1, guarded, round1, round2, toolResult } from "./common.js";
import { MIX_REGIONS } from "./generation-mix.js";

type Criterion = (typeof CRITERIA)[number];
type Resolution = "hour" | "quarterhour";

const STEP_MS: Record<Resolution, number> = { hour: HOUR, quarterhour: HOUR / 4 };

/** A bare `from` time this far in the past still counts as today's plug-in. */
const PLUGGED_IN_MS = 12 * HOUR;

/** Longest plug-in window; day-ahead prices reach at most to the end of tomorrow. */
export const MAX_WINDOW_MS = 48 * HOUR;

const CLOCK = /^(\d{1,2}):(\d{2})$/;

/**
 * Parses an ISO date-time, or a bare clock time "HH:MM" meaning its next
 * occurrence (Berlin) after `after`, so "18:00" to "07:00" spans midnight.
 */
export function parseMoment(input: string, after: number): number {
  const m = CLOCK.exec(input.trim());
  if (!m) return parseTime(input);
  const [h, mi] = [Number(m[1]), Number(m[2])];
  if (h > 23 || mi > 59) throw new Error(`Invalid time: ${input}`);
  const [y, mo, d] = formatBerlin(after).slice(0, 10).split("-").map(Number) as [number, number, number];
  for (let i = 0; i < 3; i++) {
    const t = berlinLocalToUtc(y, mo, d + i, h, mi);
    if (t > after) return t;
  }
  throw new Error(`Invalid time: ${input}`);
}

export interface Slot {
  timestamp: number;
  kwh: number;
}

/**
 * How much energy goes into each interval. Full intervals at `kwhPerSlot`
 * and, if the amount does not divide evenly, one partial interval: for the
 * plan the worst of the chosen ones, for charging right away the last.
 */
export function fill(order: readonly number[], energyKwh: number, kwhPerSlot: number): Slot[] {
  const slots: Slot[] = [];
  let left = energyKwh;
  for (const t of order) {
    if (left <= 1e-9) break;
    const kwh = Math.min(kwhPerSlot, left);
    slots.push({ timestamp: t, kwh });
    left -= kwh;
  }
  return slots.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Scores are compared at a resolution below which differences do not matter
 * (0.1 ct/kWh, 1 % green share), so that near-equal intervals count as equal
 * and the earlier one wins instead of splitting the charge into many blocks.
 */
const SCORE_STEP: Record<Criterion, number> = { price: 1, green: 1, balanced: 0.01 };

/**
 * Intervals in the order they should be used: best score first; on equal
 * scores the earlier one, which keeps flat stretches in one block. Intervals
 * without a score (missing price or forecast) are not used.
 */
export function rankSlots(rows: readonly Row[], criterion: Criterion): number[] {
  const step = SCORE_STEP[criterion];
  const s = scores(rows, criterion).map((v) => (v === null ? null : Math.round(v / step) * step));
  return rows
    .map((r, i) => ({ t: r.timestamp, score: s[i] }))
    .filter((x): x is { t: number; score: number } => x.score !== null && x.score !== undefined)
    .sort((a, b) => b.score - a.score || a.t - b.t)
    .map((x) => x.t);
}

/** Best run of `count` consecutive scored intervals (earliest wins ties), charging from its start. */
export function bestRun(rows: readonly Row[], criterion: Criterion, count: number, stepMs: number): number[] | null {
  const s = scores(rows, criterion);
  let best: { score: number; start: number } | null = null;
  for (let i = 0; i + count <= rows.length; i++) {
    let total = 0;
    let ok = true;
    for (let j = i; j < i + count; j++) {
      const v = s[j];
      if (v === null || v === undefined || (j > i && rows[j]!.timestamp - rows[j - 1]!.timestamp !== stepMs)) {
        ok = false;
        break;
      }
      total += v;
    }
    if (ok && (!best || total / count > best.score)) best = { score: total / count, start: i };
  }
  return best ? rows.slice(best.start, best.start + count).map((r) => r.timestamp) : null;
}

const segmentSchema = z.object({
  start: z.string(),
  end: z.string().describe("Exclusive"),
  energy_kwh: z.number(),
  average_price_eur_mwh: z.number().nullable(),
});

const scheduleSchema = z.object({
  segments: z.array(segmentSchema).describe("Charging blocks; consecutive intervals are merged"),
  energy_kwh: z.number(),
  finishes_at: z.string().nullable(),
  average_price_eur_mwh: z.number().nullable().describe("Weighted by energy; null if a used interval has no price"),
  average_green_share_pct: z.number().nullable().describe("Weighted by energy"),
  cost_wholesale_eur: z.number().nullable().describe("Day-ahead price x energy, without VAT"),
  cost_retail_eur: z.number().nullable().describe("(Wholesale + surcharge) x (1 + VAT); only with surcharge_ct_kwh"),
});

const outputShape = {
  ...commonFields,
  from: z.string().describe("First interval considered"),
  to: z.string().describe("Departure (exclusive)"),
  energy_kwh: z.number().describe("Requested energy drawn from the grid"),
  power_kw: z.number(),
  hours_needed: z.number(),
  optimize: z.enum(CRITERIA),
  contiguous: z.boolean(),
  resolution: z.enum(["hour", "quarterhour"]),
  region: z.string().describe("Region of the green share"),
  bidding_zone: z.literal("DE-LU"),
  prices_until: z.string().nullable().describe("End of the last interval in the window with a day-ahead price"),
  forecasts_until: z.string().nullable().describe("End of the last interval in the window with a green share"),
  plan: scheduleSchema,
  charge_now: scheduleSchema.describe("Charging right from the start of the window, for comparison"),
  savings_eur: z
    .number()
    .nullable()
    .describe("charge_now minus plan, wholesale difference incl. VAT; only real with a dynamic tariff; null if either has an unpriced interval"),
  shortfall_kwh: z.number().describe("Energy that cannot be charged before departure even at full power the whole time"),
  unplanned_kwh: z
    .number()
    .describe("Energy left out because part of the window has no prices or forecasts yet; there is time for it, ask again once the data is published"),
  vat_pct: z.number(),
  surcharge_ct_kwh: z.number().nullable(),
  missing: z.array(z.string()),
  notes: z.array(z.string()),
  source: z.string(),
};

type Result = z.infer<z.ZodObject<typeof outputShape>>;
type Schedule = z.infer<typeof scheduleSchema>;

function schedule(slots: readonly Slot[], byTime: ReadonlyMap<number, Row>, stepMs: number, vat: number, surcharge: number | null): Schedule {
  const segments: Schedule["segments"] = [];
  let cur: { start: number; end: number; kwh: number; eur: number; priced: boolean } | null = null;
  const flush = () => {
    if (cur) segments.push({ start: formatBerlin(cur.start), end: formatBerlin(cur.end), energy_kwh: round2(cur.kwh), average_price_eur_mwh: cur.priced ? round2(cur.eur / cur.kwh) : null });
  };
  let kwh = 0;
  let eurMwhKwh = 0; // sum of price x kWh
  let greenKwh = 0;
  let priced = true;
  let green = true;
  for (const s of slots) {
    const row = byTime.get(s.timestamp)!;
    kwh += s.kwh;
    if (row.price === null) priced = false;
    else eurMwhKwh += row.price * s.kwh;
    if (row.green === null) green = false;
    else greenKwh += row.green * s.kwh;
    if (cur && cur.end === s.timestamp) {
      cur.end += stepMs;
      cur.kwh += s.kwh;
      cur.eur += (row.price ?? 0) * s.kwh;
      cur.priced &&= row.price !== null;
    } else {
      flush();
      cur = { start: s.timestamp, end: s.timestamp + stepMs, kwh: s.kwh, eur: (row.price ?? 0) * s.kwh, priced: row.price !== null };
    }
  }
  flush();
  const wholesale = priced && kwh > 0 ? eurMwhKwh / 1000 : null;
  const last = slots[slots.length - 1];
  return {
    segments,
    energy_kwh: round2(kwh),
    finishes_at: last ? formatBerlin(last.timestamp + stepMs) : null,
    average_price_eur_mwh: wholesale === null ? null : round2(eurMwhKwh / kwh),
    average_green_share_pct: green && kwh > 0 ? round1(greenKwh / kwh) : null,
    cost_wholesale_eur: wholesale === null ? null : round2(wholesale) + 0,
    cost_retail_eur: wholesale === null || surcharge === null ? null : round2((wholesale + (surcharge / 100) * kwh) * (1 + vat / 100)) + 0,
  };
}

export function registerPlanCharging(server: McpServer, client: SmardClient): void {
  server.registerTool(
    "plan_charging",
    {
      title: "Plan charging (electric car, battery)",
      description:
        "Plans when to draw a given amount of energy between plug-in and departure, e.g. charging an electric car or a home battery: " +
        "picks the cheapest (day-ahead price DE-LU), greenest (wind + solar share of consumption) or a balanced set of intervals, " +
        "which need not be contiguous (contiguous=true for chargers that cannot pause), " +
        "and compares it with charging right away, including the savings in euros. " +
        "Use it for questions like 'I plug in at 18:00 and leave at 7:00, need 40 kWh at 11 kW: when should I charge?'. " +
        "from/to accept a bare time like 18:00 (its next occurrence) so windows over midnight are easy. " +
        "Day-ahead prices for tomorrow are published around noon; before that the window may have no prices after midnight (see prices_until and missing). " +
        "Savings only apply with a dynamic electricity tariff. For appliances with a fixed run time (washing machine, dishwasher) use find_best_hours.",
      inputSchema: {
        energy_kwh: z.number().positive().max(500).describe("Energy to draw from the grid in kWh (charging losses included, not modelled)."),
        power_kw: z.number().positive().max(400).describe("Charging power in kW, e.g. 11 for a wallbox."),
        to: z.string().describe('Departure: "HH:MM" (next occurrence after from) or ISO 8601 date-time (Berlin time without offset).'),
        from: z.string().optional().describe('Plug-in: "HH:MM" (next occurrence) or ISO 8601 date-time. Default: now.'),
        optimize: z.enum(CRITERIA).default("price").describe("price = cheapest, green = most wind and solar, balanced = both equally."),
        contiguous: z.boolean().default(false).describe("true = one uninterrupted block."),
        resolution: z.enum(["quarterhour", "hour"]).default("quarterhour").describe("Planning step: 15 minutes (as day-ahead prices since Oct 2025) or whole hours."),
        surcharge_ct_kwh: z
          .number()
          .min(0)
          .max(200)
          .optional()
          .describe("Optional: everything paid per kWh on top of the wholesale price, net of VAT (grid fees, levies, supplier margin), as one flat amount; gives cost_retail_eur."),
        vat_pct: z.number().min(0).max(30).default(19).describe("VAT in % applied to savings and retail cost."),
        region: z.enum(MIX_REGIONS).default("DE").describe("Region for the green share (DE or a TSO zone). The price stays DE-LU."),
      },
      outputSchema: outputShape,
      annotations: { title: "Plan charging", ...READ_ONLY_REMOTE },
    },
    async ({ energy_kwh, power_kw, to, from, optimize, contiguous, resolution, surcharge_ct_kwh, vat_pct, region }) =>
      guarded(async () => {
        const now = Date.now();
        const step = STEP_MS[resolution];
        let fromMs: number;
        let toMs: number;
        try {
          // A bare plug-in time up to 12 hours ago means "plugged in already".
          fromMs = from ? parseMoment(from, now - PLUGGED_IN_MS) : now;
          toMs = parseMoment(to, Math.max(fromMs, now));
        } catch (err) {
          throw new InputError((err as Error).message);
        }
        if (toMs <= fromMs) throw new InputError('"to" (departure) must be after "from" (plug-in).');
        if (toMs - fromMs > MAX_WINDOW_MS) throw new InputError("The window may span at most 48 hours; day-ahead prices reach at most to the end of tomorrow.");
        if (toMs <= now) throw new InputError("The window lies in the past; plan_charging plans ahead.");
        // Whole intervals only, none that has already started.
        const start = Math.ceil(Math.max(fromMs, now) / step) * step;
        const end = Math.floor(toMs / step) * step;
        if (end <= start) throw new InputError(`The window contains no whole ${resolution === "hour" ? "hour" : "quarter-hour"} that has not started yet.`);

        const { rows, intradayIntervals } = await loadRows(client, start, end, "intraday", resolution, region as Region);
        const byTime = new Map(rows.map((r) => [r.timestamp, r]));
        const kwhPerSlot = (power_kw * step) / HOUR;
        const needed = Math.ceil(energy_kwh / kwhPerSlot - 1e-9);

        const missing: string[] = [];
        const notes: string[] = [];
        const lastWith = (pick: (r: Row) => unknown) => {
          const r = [...rows].reverse().find((x) => pick(x) !== null);
          return r ? r.timestamp + step : null;
        };
        const pricesUntil = lastWith((r) => r.price);
        const forecastsUntil = lastWith((r) => r.green);
        const unpriced = rows.filter((r) => r.price === null).length;
        if (pricesUntil === null) missing.push("No day-ahead prices for this window yet (published around noon for the next day).");
        else if (pricesUntil < end) {
          missing.push(
            `Day-ahead prices exist only until ${formatBerlin(pricesUntil)}; the rest of the window (until ${formatBerlin(end)}) has no price yet. ` +
              "Prices for the next day are published around noon; ask again after that for a plan over the whole window.",
          );
        } else if (unpriced > 0) missing.push(`Day-ahead prices are missing for ${unpriced} of ${rows.length} intervals.`);
        if (forecastsUntil === null) missing.push("No wind/solar or consumption forecast for this window yet.");
        else if (forecastsUntil < end) missing.push(`The green share (forecasts) is available only until ${formatBerlin(forecastsUntil)}.`);

        let criterion: Criterion = optimize;
        let order = contiguous ? null : rankSlots(rows, criterion);
        let run = contiguous ? longestRun(rows, criterion, Math.min(needed, rows.length), step) : null;
        if ((contiguous ? run : order)?.length === 0 || (contiguous && !run)) {
          const fallback = CRITERIA.find((c) => (contiguous ? longestRun(rows, c, 1, step) : rankSlots(rows, c).length > 0));
          if (!fallback) throw new InputError(`No plan can be computed: ${missing.join(" ")}`);
          notes.push(`"${optimize}" cannot be computed with the available data, so "${fallback}" is used instead.`);
          criterion = fallback;
          order = contiguous ? null : rankSlots(rows, criterion);
          run = contiguous ? longestRun(rows, criterion, Math.min(needed, rows.length), step) : null;
        }

        const planSlots = contiguous ? fill(run!, energy_kwh, kwhPerSlot) : fillWorstLast(order!, energy_kwh, kwhPerSlot, needed);
        const nowSlots = fill(
          rows.map((r) => r.timestamp),
          energy_kwh,
          kwhPerSlot,
        );
        const surcharge = surcharge_ct_kwh ?? null;
        const chargeNow = schedule(nowSlots, byTime, step, vat_pct, surcharge);
        let plan = schedule(planSlots, byTime, step, vat_pct, surcharge);
        if (!contiguous && plan.segments.length > 1 && hardlyBetter(plan, chargeNow, criterion, energy_kwh)) {
          plan = chargeNow;
          notes.push("Charging right away is practically as good (under 0.10 EUR or 1 percentage point green share difference), so the plan is one block from the start.");
        }
        // Physically too short a window, versus energy that only lacks prices or forecasts.
        const shortfall = Math.max(0, energy_kwh - rows.length * kwhPerSlot);
        const unplanned = Math.max(0, energy_kwh - plan.energy_kwh - shortfall);
        if (shortfall > 0.005) {
          missing.push(
            `${fmt1(shortfall)} of ${fmt1(energy_kwh)} kWh cannot be charged before departure: ${fmt1(power_kw)} kW over the window give at most ${fmt1(rows.length * kwhPerSlot)} kWh.`,
          );
        }
        if (unplanned > 0.005) {
          missing.push(
            `${fmt1(unplanned)} kWh are not planned because ${contiguous ? "no uninterrupted block of the needed length has" : "the rest of the window has no"} prices or forecasts yet. There is enough time for them; ask again once the data is published.`,
          );
        }
        const comparable = plan.cost_wholesale_eur !== null && chargeNow.cost_wholesale_eur !== null && Math.abs(plan.energy_kwh - chargeNow.energy_kwh) < 0.005;
        const savings = comparable ? round2((chargeNow.cost_wholesale_eur! - plan.cost_wholesale_eur!) * (1 + vat_pct / 100)) + 0 : null;

        if (region !== "DE") notes.push(`The green share refers to ${region}; prices are those of the DE-LU bidding zone.`);
        if (intradayIntervals > 0) notes.push("The green share uses SMARD's intraday forecast where available, else the day-ahead forecast.");
        if (start > fromMs) notes.push(`Planning starts at ${formatBerlin(start)}, the first whole interval that has not started yet.`);
        notes.push(GREEN_DEFINITION.replace(/ \(forecasts.*\)/, " (forecasts)"));
        if (criterion === "balanced") notes.push("Balanced: price and green share are each scaled to 0..1 over the intervals of the window and averaged with equal weight.");
        notes.push(WHOLESALE_NOTE);

        const result: Result = {
          from: formatBerlin(start),
          to: formatBerlin(toMs),
          energy_kwh,
          power_kw,
          hours_needed: round2(energy_kwh / power_kw),
          optimize: criterion,
          contiguous,
          resolution,
          region,
          bidding_zone: "DE-LU",
          prices_until: pricesUntil === null ? null : formatBerlin(pricesUntil),
          forecasts_until: forecastsUntil === null ? null : formatBerlin(forecastsUntil),
          plan,
          charge_now: chargeNow,
          savings_eur: savings,
          shortfall_kwh: round2(shortfall),
          unplanned_kwh: round2(unplanned),
          vat_pct,
          surcharge_ct_kwh: surcharge,
          missing,
          notes,
          source: ATTRIBUTION,
        };
        return toolResult(chargingText(result), result);
      }),
  );
}

/** Best run of `count` intervals, or of fewer if the data has no run that long; null if none. */
export function longestRun(rows: readonly Row[], criterion: Criterion, count: number, stepMs: number): number[] | null {
  for (let c = count; c >= 1; c--) {
    const run = bestRun(rows, criterion, c, stepMs);
    if (run) return run;
  }
  return null;
}

/** A split plan that gains less than 0.10 EUR (or 1 point green share) over one block from the start is not worth it. */
export function hardlyBetter(plan: Schedule, now: Schedule, criterion: Criterion, energyKwh: number): boolean {
  if (Math.abs(now.energy_kwh - energyKwh) > 0.005) return false;
  const cheaper = plan.cost_wholesale_eur !== null && now.cost_wholesale_eur !== null ? now.cost_wholesale_eur - plan.cost_wholesale_eur : null;
  const greener = plan.average_green_share_pct !== null && now.average_green_share_pct !== null ? plan.average_green_share_pct - now.average_green_share_pct : null;
  if (criterion === "price") return cheaper !== null && cheaper < 0.1;
  if (criterion === "green") return greener !== null && greener < 1;
  return cheaper !== null && greener !== null && cheaper < 0.1 && greener < 1;
}

/** Non-contiguous plan: the `needed` best intervals, the partial one being the worst of them. */
function fillWorstLast(order: readonly number[], energyKwh: number, kwhPerSlot: number, needed: number): Slot[] {
  const chosen = order.slice(0, needed);
  const slots: Slot[] = [];
  let left = energyKwh;
  for (const t of chosen) {
    const kwh = Math.min(kwhPerSlot, left);
    if (kwh <= 1e-9) break;
    slots.push({ timestamp: t, kwh });
    left -= kwh;
  }
  return slots.sort((a, b) => a.timestamp - b.timestamp);
}

function chargingText(r: Result): string {
  const hhmm = (s: string) => s.slice(11, 16);
  const day = (s: string) => s.slice(5, 10).split("-").reverse().join(".");
  const block = (s: Schedule) => s.segments.map((g) => `${day(g.start)} ${hhmm(g.start)} to ${hhmm(g.end)} (${fmt1(g.energy_kwh)} kWh)`).join(", ");
  const price = (s: Schedule) =>
    s.average_price_eur_mwh === null ? "price n/a" : `average ${s.average_price_eur_mwh.toFixed(2)} EUR/MWh (${(s.average_price_eur_mwh / 10).toFixed(2)} ct/kWh wholesale)`;
  const green = (s: Schedule) => (s.average_green_share_pct === null ? "" : `, green share ${fmt1(s.average_green_share_pct)} %`);
  const retail = (s: Schedule) => (s.cost_retail_eur === null ? "" : `, about ${s.cost_retail_eur.toFixed(2)} EUR incl. surcharge and VAT`);
  const lines: string[] = [];
  for (const m of r.missing) lines.push(`Attention: ${m}`);
  const until = (s: string | null) => (s !== null && s < r.to ? s : null);
  const limits = [r.optimize !== "green" ? until(r.prices_until) : null, r.optimize !== "price" ? until(r.forecasts_until) : null].filter((x): x is string => x !== null).sort();
  const partial = limits[0] ?? null;
  lines.push(
    `Charging plan for ${fmt1(r.energy_kwh)} kWh at ${fmt1(r.power_kw)} kW (${fmt1(r.hours_needed)} h) between ${day(r.from)} ${hhmm(r.from)} and ${day(r.to)} ${hhmm(r.to)}, optimized for ${r.optimize}${r.contiguous ? ", one block" : ""}:`,
    `Plan${partial ? ` (only within the part with data, until ${day(partial)} ${hhmm(partial)})` : ""}: ${block(r.plan) || "no interval"}; ${price(r.plan)}${green(r.plan)}${retail(r.plan)}.`,
    `Charging right away: ${block(r.charge_now) || "no interval"}; ${price(r.charge_now)}${green(r.charge_now)}${retail(r.charge_now)}.`,
    r.savings_eur === null
      ? "Savings: n/a (not every interval used has a price)."
      : `Savings with a dynamic tariff${partial ? " (within the part with data only)" : ""}: ${r.savings_eur.toFixed(2)} EUR incl. ${fmt1(r.vat_pct)} % VAT (with a fixed tariff: none).`,
  );
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
