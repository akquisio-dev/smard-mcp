/**
 * Catalogue of SMARD time series exposed by this server.
 *
 * The numeric ids are SMARD's internal "filter" ids used by
 * https://www.smard.de/app/chart_data/{filter}/{region}/...
 * Names are kept stable because clients refer to series by `key`.
 */

import { BORDERS, NET_EXPORT_FILTER } from "./borders.js";

export type Category = "generation" | "consumption" | "price" | "forecast_generation" | "forecast_consumption" | "cross_border";

export interface SeriesInfo {
  key: string;
  filter: number;
  category: Category;
  name: string;
  unit: "MWh" | "EUR/MWh";
  /** Generation only: counts as renewable (SMARD's definition, pumped storage is not). */
  renewable?: boolean;
  /** Prices only: bidding zone. SMARD returns the same zone price for every region. */
  zone?: string;
}

const g = (key: string, filter: number, name: string, renewable: boolean): SeriesInfo => ({
  key,
  filter,
  category: "generation",
  name,
  unit: "MWh",
  renewable,
});
const p = (key: string, filter: number, name: string, zone: string): SeriesInfo => ({
  key,
  filter,
  category: "price",
  name,
  unit: "EUR/MWh",
  zone,
});

export const SERIES: readonly SeriesInfo[] = [
  // Actual generation
  g("generation_lignite", 1223, "Generation: lignite", false),
  g("generation_nuclear", 1224, "Generation: nuclear", false),
  g("generation_wind_offshore", 1225, "Generation: wind offshore", true),
  g("generation_hydro", 1226, "Generation: hydropower", true),
  g("generation_other_conventional", 1227, "Generation: other conventional", false),
  g("generation_other_renewable", 1228, "Generation: other renewables", true),
  g("generation_biomass", 4066, "Generation: biomass", true),
  g("generation_wind_onshore", 4067, "Generation: wind onshore", true),
  g("generation_solar", 4068, "Generation: photovoltaics", true),
  g("generation_hard_coal", 4069, "Generation: hard coal", false),
  g("generation_pumped_storage", 4070, "Generation: pumped storage", false),
  g("generation_natural_gas", 4071, "Generation: natural gas", false),

  // Actual consumption
  { key: "consumption_total", filter: 410, category: "consumption", name: "Consumption: total (grid load)", unit: "MWh" },
  { key: "consumption_residual_load", filter: 4359, category: "consumption", name: "Consumption: residual load", unit: "MWh" },
  { key: "consumption_pumped_storage", filter: 4387, category: "consumption", name: "Consumption: pumped storage", unit: "MWh" },

  // Day-ahead market prices
  p("price_de_lu", 4169, "Day-ahead price: Germany/Luxembourg", "DE-LU"),
  p("price_de_lu_neighbours", 5078, "Day-ahead price: average of DE/LU neighbours", "DE-LU neighbours"),
  p("price_at", 4170, "Day-ahead price: Austria", "AT"),
  p("price_be", 4996, "Day-ahead price: Belgium", "BE"),
  p("price_ch", 259, "Day-ahead price: Switzerland", "CH"),
  p("price_cz", 261, "Day-ahead price: Czech Republic", "CZ"),
  p("price_dk1", 252, "Day-ahead price: Denmark 1", "DK1"),
  p("price_dk2", 253, "Day-ahead price: Denmark 2", "DK2"),
  p("price_fr", 254, "Day-ahead price: France", "FR"),
  p("price_hu", 262, "Day-ahead price: Hungary", "HU"),
  p("price_it_north", 255, "Day-ahead price: Italy (North)", "IT-North"),
  p("price_nl", 256, "Day-ahead price: Netherlands", "NL"),
  p("price_no2", 4997, "Day-ahead price: Norway 2", "NO2"),
  p("price_pl", 257, "Day-ahead price: Poland", "PL"),
  // 258 is Sweden 4, not Poland as some third-party docs say (checked against SMARD's CSV export).
  p("price_se4", 258, "Day-ahead price: Sweden 4", "SE4"),
  p("price_si", 260, "Day-ahead price: Slovenia", "SI"),

  // Forecasts
  { key: "forecast_generation_total", filter: 122, category: "forecast_generation", name: "Forecast generation: total", unit: "MWh" },
  { key: "forecast_generation_wind_onshore", filter: 123, category: "forecast_generation", name: "Forecast generation: wind onshore", unit: "MWh" },
  { key: "forecast_generation_solar", filter: 125, category: "forecast_generation", name: "Forecast generation: photovoltaics", unit: "MWh" },
  { key: "forecast_generation_other", filter: 715, category: "forecast_generation", name: "Forecast generation: other", unit: "MWh" },
  { key: "forecast_generation_wind_offshore", filter: 3791, category: "forecast_generation", name: "Forecast generation: wind offshore", unit: "MWh" },
  { key: "forecast_generation_wind_and_solar", filter: 5097, category: "forecast_generation", name: "Forecast generation: wind and photovoltaics", unit: "MWh" },
  { key: "forecast_consumption_total", filter: 411, category: "forecast_consumption", name: "Forecast consumption: total", unit: "MWh" },
  { key: "forecast_consumption_residual_load", filter: 4362, category: "forecast_consumption", name: "Forecast consumption: residual load", unit: "MWh" },

  // Cross-border flows across all borders of the region: exports minus imports
  // (positive = net export). For TSO zones only borders to other countries.
  { key: "flow_physical_net_export", filter: NET_EXPORT_FILTER.physical, category: "cross_border", name: "Cross-border physical flow: net export", unit: "MWh" },
  { key: "flow_commercial_net_export", filter: NET_EXPORT_FILTER.commercial, category: "cross_border", name: "Cross-border commercial exchange: net export", unit: "MWh" },
];

export const SERIES_KEYS = SERIES.map((s) => s.key) as [string, ...string[]];

/**
 * Per-country flow series, used by get_cross_border_flows. Not listed in
 * list_series: their SMARD id depends on the region, so each one belongs to
 * exactly one region (see borders.ts).
 */
export const BORDER_SERIES: readonly SeriesInfo[] = BORDERS.flatMap((b) =>
  (["physical", "commercial"] as const).flatMap((kind) =>
    (["export", "import"] as const).map((direction) => ({
      key: borderSeriesKey(b.region, b.code, kind, direction),
      filter: b[kind][direction],
      category: "cross_border" as const,
      name: `${kind === "physical" ? "Physical flow" : "Commercial exchange"}: ${direction} ${direction === "export" ? "to" : "from"} ${b.name} (${b.region})`,
      unit: "MWh" as const,
    })),
  ),
);

export function borderSeriesKey(region: string, code: string, kind: "physical" | "commercial", direction: "export" | "import"): string {
  return `flow_${kind}_${region}_${code}_${direction}`;
}

const ALL_SERIES = new Map([...SERIES, ...BORDER_SERIES].map((s) => [s.key, s]));

export function findSeries(key: string): SeriesInfo | undefined {
  return ALL_SERIES.get(key);
}

export const GENERATION_SERIES = SERIES.filter((s) => s.category === "generation");

/** Regions accepted for price series; the zone itself is chosen by the series key. */
export const PRICE_REGIONS: readonly Region[] = ["DE", "DE-LU"];

export const REGIONS = ["DE", "DE-LU", "AT", "LU", "50Hertz", "Amprion", "TenneT", "TransnetBW"] as const;
export type Region = (typeof REGIONS)[number];

export const RESOLUTIONS = ["quarterhour", "hour", "day", "week", "month", "year"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const ATTRIBUTION = "Bundesnetzagentur | SMARD.de (CC BY 4.0)";
