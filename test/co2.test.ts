import { describe, expect, it } from "vitest";
import { GENERATION_SERIES } from "../src/catalog.js";
import { EMISSION_FACTORS, co2Intensity, co2Tonnes } from "../src/co2.js";

describe("emission factors", () => {
  it("cover every generation series", () => {
    for (const s of GENERATION_SERIES) expect(EMISSION_FACTORS[s.key], s.key).toBeDefined();
  });

  it("are zero for renewables, nuclear and pumped storage", () => {
    for (const s of GENERATION_SERIES) {
      if (s.renewable || s.key === "generation_nuclear" || s.key === "generation_pumped_storage") {
        expect(EMISSION_FACTORS[s.key]!.gPerKwh, s.key).toBe(0);
      }
    }
  });

  it("follow the UBA primary-energy factors and efficiencies", () => {
    expect(EMISSION_FACTORS.generation_lignite!.gPerKwh).toBe(Math.round(394.95 / 0.398));
    expect(EMISSION_FACTORS.generation_hard_coal!.gPerKwh).toBe(Math.round(338.82 / 0.437));
    expect(EMISSION_FACTORS.generation_natural_gas!.gPerKwh).toBe(Math.round(202.77 / 0.56));
    expect(EMISSION_FACTORS.generation_other_conventional!.uncertain).toBe(true);
  });
});

describe("co2Intensity / co2Tonnes", () => {
  it("weights the factors by generation", () => {
    const mix = new Map([
      ["generation_lignite", 1000],
      ["generation_solar", 3000],
    ]);
    expect(co2Intensity(mix)).toBe(992 / 4);
    expect(co2Tonnes(mix)).toBe(992); // 1000 MWh x 992 g/kWh = 992 t
  });

  it("is null without generation", () => {
    expect(co2Intensity(new Map())).toBeNull();
  });
});
