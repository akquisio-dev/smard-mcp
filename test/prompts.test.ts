import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMonth, resolveWeek } from "../src/prompts.js";
import { connect } from "./helpers.js";

const noFetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;

async function prompt(name: string, args: Record<string, string> = {}) {
  const client = await connect(noFetch);
  const res = await client.getPrompt({ name, arguments: args });
  const msg = res.messages[0]!;
  return msg.content.type === "text" ? msg.content.text : "";
}

afterEach(() => {
  vi.useRealTimers();
});

describe("prompts", () => {
  it("are all listed with German names without umlauts", async () => {
    const client = await connect(noFetch);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["beste_stunden", "monatsvergleich", "region_vergleich", "strom_uebersicht", "wochen_bericht"]);
    for (const p of prompts) expect(p.name).toMatch(/^[a-z_]+$/);
  });

  it("strom_uebersicht fills in date, weekday and the tool call", async () => {
    const text = await prompt("strom_uebersicht", { datum: "12.10.2026", region: "tennet" });
    expect(text).toMatch(/get_market_overview mit date = "2026-10-12" und region = "TenneT"/);
    expect(text).toMatch(/^## ⚡ Strommarkt TenneT \| Montag, 12\.10\.2026$/m);
    expect(text).toMatch(/keine regionalen Preise/);
    expect(text).toMatch(/_Quelle: Bundesnetzagentur \| SMARD\.de \(CC BY 4\.0\)_/);
    expect(text).toMatch(/Antworte auf Deutsch, außer der Nutzer schreibt Englisch\./);
    expect(text).not.toMatch(/ – |—/);
  });

  it("strom_uebersicht defaults to yesterday and DE", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T08:00:00Z"));
    const text = await prompt("strom_uebersicht");
    expect(text).toMatch(/date = "2026-10-12" und region = "DE"/);
    expect(text).toMatch(/30-Tage-Mittel/);
  });

  it("rejects unknown regions and invalid dates", async () => {
    await expect(prompt("strom_uebersicht", { region: "Bayern" })).rejects.toThrow(/Unbekannte Region/);
    await expect(prompt("strom_uebersicht", { datum: "31.02.2026" })).rejects.toThrow(/Ungültiges Datum/);
  });

  it("wochen_bericht compares with the previous week", async () => {
    const text = await prompt("wochen_bericht", { woche: "2026-W41" });
    expect(text).toMatch(/KW 41\/2026 \(05\.10\.2026 bis 11\.10\.2026\)/);
    expect(text).toMatch(/period_a_from = "2026-09-28", period_a_to = "2026-10-04", period_b_from = "2026-10-05", period_b_to = "2026-10-11"/);
    expect(text).toMatch(/analyze_prices mit from = "2026-10-05", to = "2026-10-11"/);
  });

  it("monatsvergleich uses the same month of the previous year as baseline", async () => {
    const text = await prompt("monatsvergleich", { monat: "Februar 2024", region: "50Hertz" });
    expect(text).toMatch(/period_a_from = "2023-02-01", period_a_to = "2023-02-28" \(Vorjahr, Basis\), period_b_from = "2024-02-01", period_b_to = "2024-02-29"/);
    expect(text).toMatch(/## 📊 Strommarkt 50Hertz \| Februar 2024 im Vergleich zu Februar 2023/);
    expect(text).not.toMatch(/Ø-Preis/);
  });

  it("region_vergleich asks for all four zones", async () => {
    const text = await prompt("region_vergleich", { von: "2026-10-01", bis: "2026-10-07" });
    expect(text).toMatch(/from = "2026-10-01", to = "2026-10-07" einmal je Region auf: 50Hertz, Amprion, TenneT, TransnetBW/);
    await expect(prompt("region_vergleich", { von: "2026-10-07", bis: "2026-10-01" })).rejects.toThrow(/vor/);
  });

  it("beste_stunden maps German goals and checks the duration", async () => {
    expect(await prompt("beste_stunden", { dauer: "4", ziel: "grün" })).toMatch(/duration_hours = 4 und optimize = "green"/);
    expect(await prompt("beste_stunden")).toMatch(/duration_hours = 3 und optimize = "balanced"/);
    await expect(prompt("beste_stunden", { dauer: "20" })).rejects.toThrow(/Ungültige Dauer/);
    await expect(prompt("beste_stunden", { ziel: "billig!" })).rejects.toThrow(/Unbekanntes Ziel/);
  });
});

describe("resolveWeek / resolveMonth", () => {
  it("handles ISO week 1 across the year boundary", () => {
    const w = resolveWeek("2026-W01");
    expect(w.monday).toEqual({ y: 2025, m: 12, d: 29 });
    expect(w.sunday).toEqual({ y: 2026, m: 1, d: 4 });
    expect(resolveWeek("KW 53 2020").monday).toEqual({ y: 2020, m: 12, d: 28 });
  });

  it("finds the week of a date and the last full week", () => {
    expect(resolveWeek("2026-10-14").week).toBe(42);
    const last = resolveWeek("", Date.parse("2026-10-13T08:00:00Z"));
    expect(last).toMatchObject({ week: 41, monday: { y: 2026, m: 10, d: 5 } });
  });

  it("parses months and defaults to the last full month", () => {
    expect(resolveMonth("09.2026")).toEqual({ y: 2026, m: 9 });
    expect(resolveMonth("", Date.parse("2026-01-15T08:00:00Z"))).toEqual({ y: 2025, m: 12 });
    expect(() => resolveMonth("2026-13")).toThrow();
  });
});
