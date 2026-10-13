/**
 * Estimated direct CO2 emissions of electricity generation.
 *
 * Method: generation per source x emission factor. The factors are direct
 * CO2 emissions from combustion per kWh of electricity, without upstream
 * chains (fuel extraction, transport) and without other greenhouse gases.
 *
 * Source: Umweltbundesamt, Climate Change 03/2025 "Emissionsbilanz
 * erneuerbarer Energieträger, Bestimmung der vermiedenen Emissionen im Jahr
 * 2023" (data year 2023, published 2025):
 * - Table 6: direct CO2 emission factors per kWh of primary energy, derived
 *   from the national emission inventory (lignite 394.95, hard coal 338.82,
 *   natural gas 202.77, light heating oil 266.47 g/kWh),
 * - Table 5: mean gross efficiency of conventional power generation,
 *   averaged over condensing and CHP operation (lignite 39.8 %, hard coal
 *   43.7 %, natural gas 56.0 %, oil 37.7 %).
 * Factor per kWh of electricity = primary-energy factor / efficiency.
 *
 * The efficiencies refer to gross generation while SMARD reports net
 * generation, and CHP plants also produce heat; both effects make this a
 * rough estimate (see README, "CO2 methodology").
 */

export const EMISSION_FACTORS_SOURCE =
  "Umweltbundesamt, Climate Change 03/2025 (data year 2023), tables 5 and 6: direct CO2 per kWh primary energy / mean gross efficiency";

export interface EmissionFactor {
  /** Direct CO2 in g per kWh of electricity. */
  gPerKwh: number;
  /** Why this value, especially where it is a judgement call. */
  basis: string;
  uncertain?: boolean;
}

export const EMISSION_FACTORS: Readonly<Record<string, EmissionFactor>> = {
  generation_lignite: { gPerKwh: 992, basis: "UBA: 394.95 g/kWh primary energy / 39.8 % efficiency" },
  generation_hard_coal: { gPerKwh: 775, basis: "UBA: 338.82 g/kWh primary energy / 43.7 % efficiency" },
  generation_natural_gas: { gPerKwh: 362, basis: "UBA: 202.77 g/kWh primary energy / 56.0 % efficiency" },
  generation_other_conventional: {
    gPerKwh: 707,
    basis:
      "Uncertain: a mix of oil, blast-furnace and mine gas, non-biogenic waste and others. Uses the UBA value for light heating oil (266.47 g/kWh / 37.7 %) as a middle estimate.",
    uncertain: true,
  },
  generation_nuclear: { gPerKwh: 0, basis: "No combustion" },
  generation_wind_onshore: { gPerKwh: 0, basis: "No combustion" },
  generation_wind_offshore: { gPerKwh: 0, basis: "No combustion" },
  generation_solar: { gPerKwh: 0, basis: "No combustion" },
  generation_hydro: { gPerKwh: 0, basis: "No combustion" },
  generation_biomass: { gPerKwh: 0, basis: "Biogenic CO2 counts as climate-neutral in emission inventories" },
  generation_other_renewable: { gPerKwh: 0, basis: "Mostly geothermal and biogenic gases" },
  generation_pumped_storage: {
    gPerKwh: 0,
    basis: "Stored electricity that was generated (and counted) before; counting it again would double-count",
  },
};

export const CO2_DISCLAIMER =
  "Estimate based on generation in this region and direct combustion emissions only; imports, exports and upstream emissions are not included.";

/** g CO2 per kWh for a set of generation amounts (MWh per series key); null if nothing was generated. */
export function co2Intensity(generationMWh: ReadonlyMap<string, number>): number | null {
  let total = 0;
  let weighted = 0;
  for (const [key, mwh] of generationMWh) {
    total += mwh;
    weighted += mwh * (EMISSION_FACTORS[key]?.gPerKwh ?? 0);
  }
  return total > 0 ? weighted / total : null;
}

/** Tonnes of CO2 for a set of generation amounts (MWh per series key). */
export function co2Tonnes(generationMWh: ReadonlyMap<string, number>): number {
  let tonnes = 0;
  // MWh x g/kWh = kg; / 1000 = t
  for (const [key, mwh] of generationMWh) tonnes += (mwh * (EMISSION_FACTORS[key]?.gPerKwh ?? 0)) / 1000;
  return tonnes;
}
