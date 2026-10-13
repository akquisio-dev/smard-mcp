/**
 * Catalogue of SMARD time series exposed by this server.
 *
 * The numeric ids are SMARD's internal "filter" ids used by
 * https://www.smard.de/app/chart_data/{filter}/{region}/...
 * Names are kept stable because clients refer to series by `key`.
 */

export type Category = "generation" | "consumption" | "price" | "forecast_generation" | "forecast_consumption";

export interface SeriesInfo {
  key: string;
  filter: number;
  category: Category;
  name: string;
  unit: "MWh" | "EUR/MWh";
  note?: string;
}

const g = (key: string, filter: number, name: string): SeriesInfo => ({ key, filter, category: "generation", name, unit: "MWh" });
const p = (key: string, filter: number, name: string, note?: string): SeriesInfo => ({ key, filter, category: "price", name, unit: "EUR/MWh", ...(note ? { note } : {}) });

export const SERIES: readonly SeriesInfo[] = [
  // Actual generation
  g("generation_lignite", 1223, "Generation: lignite"),
  g("generation_nuclear", 1224, "Generation: nuclear"),
  g("generation_wind_offshore", 1225, "Generation: wind offshore"),
  g("generation_hydro", 1226, "Generation: hydropower"),
  g("generation_other_conventional", 1227, "Generation: other conventional"),
  g("generation_other_renewable", 1228, "Generation: other renewables"),
  g("generation_biomass", 4066, "Generation: biomass"),
  g("generation_wind_onshore", 4067, "Generation: wind onshore"),
  g("generation_solar", 4068, "Generation: photovoltaics"),
  g("generation_hard_coal", 4069, "Generation: hard coal"),
  g("generation_pumped_storage", 4070, "Generation: pumped storage"),
  g("generation_natural_gas", 4071, "Generation: natural gas"),

  // Actual consumption
  { key: "consumption_total", filter: 410, category: "consumption", name: "Consumption: total (grid load)", unit: "MWh" },
  { key: "consumption_residual_load", filter: 4359, category: "consumption", name: "Consumption: residual load", unit: "MWh" },
  { key: "consumption_pumped_storage", filter: 4387, category: "consumption", name: "Consumption: pumped storage", unit: "MWh" },

  // Day-ahead market prices
  p("price_de_lu", 4169, "Day-ahead price: Germany/Luxembourg"),
  p("price_de_lu_neighbours", 5078, "Day-ahead price: average of DE/LU neighbours"),
  p("price_at", 4170, "Day-ahead price: Austria"),
  p("price_be", 4996, "Day-ahead price: Belgium"),
  p("price_ch", 259, "Day-ahead price: Switzerland"),
  p("price_cz", 261, "Day-ahead price: Czech Republic"),
  p("price_dk1", 252, "Day-ahead price: Denmark 1"),
  p("price_dk2", 253, "Day-ahead price: Denmark 2"),
  p("price_fr", 254, "Day-ahead price: France"),
  p("price_hu", 262, "Day-ahead price: Hungary"),
  p("price_it_north", 255, "Day-ahead price: Italy (North)"),
  p("price_nl", 256, "Day-ahead price: Netherlands"),
  p("price_no2", 4997, "Day-ahead price: Norway 2"),
  p("price_pl", 257, "Day-ahead price: Poland"),
  // 258 is Sweden 4, not Poland as some third-party docs say (checked against SMARD's CSV export).
  p("price_se4", 258, "Day-ahead price: Sweden 4"),
  p("price_si", 260, "Day-ahead price: Slovenia"),

  // Forecasts
  { key: "forecast_generation_total", filter: 122, category: "forecast_generation", name: "Forecast generation: total", unit: "MWh" },
  { key: "forecast_generation_wind_onshore", filter: 123, category: "forecast_generation", name: "Forecast generation: wind onshore", unit: "MWh" },
  { key: "forecast_generation_solar", filter: 125, category: "forecast_generation", name: "Forecast generation: photovoltaics", unit: "MWh" },
  { key: "forecast_generation_other", filter: 715, category: "forecast_generation", name: "Forecast generation: other", unit: "MWh" },
  { key: "forecast_generation_wind_offshore", filter: 3791, category: "forecast_generation", name: "Forecast generation: wind offshore", unit: "MWh" },
  { key: "forecast_generation_wind_and_solar", filter: 5097, category: "forecast_generation", name: "Forecast generation: wind and photovoltaics", unit: "MWh" },
  { key: "forecast_consumption_total", filter: 411, category: "forecast_consumption", name: "Forecast consumption: total", unit: "MWh" },
  { key: "forecast_consumption_residual_load", filter: 4362, category: "forecast_consumption", name: "Forecast consumption: residual load", unit: "MWh" },
];

export const SERIES_KEYS = SERIES.map((s) => s.key) as [string, ...string[]];

export function findSeries(key: string): SeriesInfo | undefined {
  return SERIES.find((s) => s.key === key);
}

export const REGIONS = ["DE", "DE-LU", "AT", "LU", "50Hertz", "Amprion", "TenneT", "TransnetBW"] as const;
export type Region = (typeof REGIONS)[number];

export const RESOLUTIONS = ["quarterhour", "hour", "day", "week", "month", "year"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const ATTRIBUTION = "Bundesnetzagentur | SMARD.de (CC BY 4.0)";
