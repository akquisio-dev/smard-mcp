/**
 * MCP prompts: ready-made German report templates. The server resolves
 * dates (yesterday, ISO weeks, previous-year month, weekday) itself, so the
 * model only has to call the named tools and fill in the format.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { berlinDayFloor, berlinMidnight, formatBerlin } from "./time.js";
import { MIX_REGIONS } from "./tools/generation-mix.js";

const SOURCE_LINE = "_Quelle: Bundesnetzagentur | SMARD.de (CC BY 4.0)_";
const LANGUAGE = "Antworte auf Deutsch, außer der Nutzer schreibt Englisch.";
const HONESTY =
  "Nenne nur, was die Daten belegen. Weise auf unvollständige Daten hin (complete = false) und kennzeichne CO2-Werte als Schätzung (erzeugungsbasiert, ohne Importe/Exporte, nur direkte Emissionen).";

const WOCHENTAGE = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

type Ymd = { y: number; m: number; d: number };

function ymdOf(ms: number): Ymd {
  const s = formatBerlin(ms);
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}

function iso({ y, m, d }: Ymd): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 12.10.2026 */
function german({ y, m, d }: Ymd): string {
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;
}

function weekday({ y, m, d }: Ymd): string {
  return WOCHENTAGE[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

function addDays(day: Ymd, n: number): Ymd {
  return ymdOf(berlinMidnight(day.y, day.m, day.d + n) + 12 * 3_600_000);
}

function yesterday(now = Date.now()): Ymd {
  return ymdOf(berlinDayFloor(now) - 12 * 3_600_000);
}

function parseDate(input: string | undefined, fallback: Ymd): Ymd {
  if (!input || input.trim() === "" || input.trim().toLowerCase() === "gestern") return fallback;
  const v = input.trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const deMatch = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  const parts = isoMatch
    ? { y: +isoMatch[1]!, m: +isoMatch[2]!, d: +isoMatch[3]! }
    : deMatch
      ? { y: +deMatch[3]!, m: +deMatch[2]!, d: +deMatch[1]! }
      : null;
  if (!parts) throw new Error(`Ungültiges Datum "${input}". Erwartet: JJJJ-MM-TT oder TT.MM.JJJJ.`);
  const check = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  if (check.getUTCMonth() !== parts.m - 1 || check.getUTCDate() !== parts.d) throw new Error(`Ungültiges Datum "${input}".`);
  return parts;
}

function parseRegion(input: string | undefined): string {
  if (!input || input.trim() === "") return "DE";
  const found = MIX_REGIONS.find((r) => r.toLowerCase() === input.trim().toLowerCase());
  if (!found) throw new Error(`Unbekannte Region "${input}". Möglich: ${MIX_REGIONS.join(", ")}.`);
  return found;
}

/** Monday of the ISO week containing `day`. */
function mondayOf(day: Ymd): Ymd {
  const dow = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/** ISO week number and week-year of a date. */
function isoWeek(day: Ymd): { year: number; week: number } {
  const thursday = addDays(mondayOf(day), 3);
  const jan1 = Date.UTC(thursday.y, 0, 1);
  const week = Math.floor((Date.UTC(thursday.y, thursday.m - 1, thursday.d) - jan1) / 86_400_000 / 7) + 1;
  return { year: thursday.y, week };
}

/** "2026-W41", "KW 41 2026", a date in the week, or empty for the last full week. */
export function resolveWeek(input: string | undefined, now = Date.now()): { monday: Ymd; sunday: Ymd; week: number; year: number } {
  let monday: Ymd;
  const v = input?.trim() ?? "";
  const isoW = /^(\d{4})-?W(\d{1,2})$/i.exec(v);
  const kw = /^KW\s*(\d{1,2})[\s/]+(\d{4})$/i.exec(v);
  if (isoW || kw) {
    const year = Number(isoW ? isoW[1] : kw![2]);
    const week = Number(isoW ? isoW[2] : kw![1]);
    if (week < 1 || week > 53) throw new Error(`Ungültige Kalenderwoche "${input}".`);
    // The ISO week 1 contains 4 January.
    monday = addDays(mondayOf({ y: year, m: 1, d: 4 }), (week - 1) * 7);
  } else if (v === "") {
    monday = addDays(mondayOf(ymdOf(now)), -7);
  } else {
    monday = mondayOf(parseDate(v, yesterday(now)));
  }
  const { year, week } = isoWeek(monday);
  return { monday, sunday: addDays(monday, 6), week, year };
}

/** "2026-09", "09.2026", "September 2026", or empty for the last full month. */
export function resolveMonth(input: string | undefined, now = Date.now()): { y: number; m: number } {
  const v = input?.trim() ?? "";
  if (v === "") {
    const t = ymdOf(now);
    return t.m === 1 ? { y: t.y - 1, m: 12 } : { y: t.y, m: t.m - 1 };
  }
  const a = /^(\d{4})-(\d{1,2})$/.exec(v);
  const b = /^(\d{1,2})[./](\d{4})$/.exec(v);
  const named = /^([A-Za-zÄÖÜäöü]+)\s+(\d{4})$/.exec(v);
  let y: number | undefined;
  let m: number | undefined;
  if (a) [y, m] = [Number(a[1]), Number(a[2])];
  else if (b) [y, m] = [Number(b[2]), Number(b[1])];
  else if (named) {
    const i = MONATE.findIndex((n) => n.toLowerCase() === named[1]!.toLowerCase());
    if (i >= 0) [y, m] = [Number(named[2]), i + 1];
  }
  if (y === undefined || m === undefined || m < 1 || m > 12) throw new Error(`Ungültiger Monat "${input}". Erwartet z. B. 2026-09 oder September 2026.`);
  return { y, m };
}

function lastDayOfMonth(y: number, m: number): Ymd {
  return ymdOf(berlinMidnight(y, m + 1, 1) - 12 * 3_600_000);
}

function message(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

const optionalText = (description: string) => z.string().optional().describe(description);

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "strom_uebersicht",
    {
      title: "Strommarkt-Übersicht für einen Tag",
      description: "Tagesübersicht mit Strommix, Ökostromanteil, CO2, Verbrauch, Preisen und Ausblick, in festem Format.",
      argsSchema: {
        datum: optionalText("Tag als JJJJ-MM-TT oder TT.MM.JJJJ; leer = gestern"),
        region: optionalText("DE (Standard), 50Hertz, Amprion, TenneT oder TransnetBW"),
      },
    },
    ({ datum, region }) => {
      const day = parseDate(datum, yesterday());
      const r = parseRegion(region);
      const priceRow =
        r === "DE"
          ? "Ø-Preis (Day-Ahead DE-LU) inkl. Vergleich zum 30-Tage-Mittel, Stunden mit negativen Preisen"
          : "Preis: keine regionalen Preise (nur Gebotszone DE-LU), Zeile mit diesem Hinweis";
      return message(
        [
          `Erstelle eine Strommarkt-Übersicht für den ${german(day)} in ${r}. Rufe get_market_overview mit date = "${iso(day)}" und region = "${r}" auf und halte dich exakt an dieses Format:`,
          "",
          `## ⚡ Strommarkt ${r} | ${weekday(day)}, ${german(day)}`,
          "**Kurzfassung:** ein Satz mit dem Wichtigsten des Tages.",
          "",
          "| Kennzahl | Wert |",
          "|---|---|",
          `Zeilen: Ökostromanteil, CO2-Intensität (Schätzung), Verbrauch, ${priceRow}.`,
          "",
          "### Strommix",
          "Tabelle der Quellen, absteigend, mit GWh und %.",
          "",
          "### Auffälligkeiten",
          "2 bis 3 Stichpunkte mit Ursachen, nur was die Daten belegen (z. B. Windflaute → Preisspitze um 19 Uhr).",
          "",
          "### Ausblick morgen",
          "Falls Prognosen oder Preise für den Folgetag vorliegen, kurz zusammenfassen; sonst ein Hinweis, dass sie noch nicht veröffentlicht sind.",
          "",
          SOURCE_LINE,
          "",
          HONESTY,
          LANGUAGE,
        ].join("\n"),
      );
    },
  );

  server.registerPrompt(
    "wochen_bericht",
    {
      title: "Wochenbericht Strommarkt",
      description: "Bericht über eine Kalenderwoche mit Vergleich zur Vorwoche, in festem Format.",
      argsSchema: {
        woche: optionalText("Kalenderwoche als 2026-W41, KW 41 2026 oder ein Datum in der Woche; leer = letzte volle Woche"),
        region: optionalText("DE (Standard), 50Hertz, Amprion, TenneT oder TransnetBW"),
      },
    },
    ({ woche, region }) => {
      const w = resolveWeek(woche);
      const prev = { monday: addDays(w.monday, -7), sunday: addDays(w.sunday, -7) };
      const r = parseRegion(region);
      const calls = [
        `compare_periods mit period_a_from = "${iso(prev.monday)}", period_a_to = "${iso(prev.sunday)}", period_b_from = "${iso(w.monday)}", period_b_to = "${iso(w.sunday)}", region = "${r}"`,
        `get_co2_intensity mit from = "${iso(w.monday)}", to = "${iso(w.sunday)}", region = "${r}"`,
        ...(r === "DE" ? [`analyze_prices mit from = "${iso(w.monday)}", to = "${iso(w.sunday)}"`] : []),
      ];
      return message(
        [
          `Erstelle einen Wochenbericht für KW ${w.week}/${w.year} (${german(w.monday)} bis ${german(w.sunday)}) in ${r}. Rufe auf:`,
          ...calls.map((c) => `- ${c}`),
          "Halte dich exakt an dieses Format:",
          "",
          `## 📅 Strommarkt ${r} | KW ${w.week}/${w.year} (${german(w.monday)} bis ${german(w.sunday)})`,
          "**Kurzfassung:** ein Satz mit dem Wichtigsten der Woche.",
          "",
          "| Kennzahl | Diese Woche | Vorwoche | Veränderung |",
          "|---|---|---|---|",
          `Zeilen: Ökostromanteil, Erzeugung, Verbrauch, CO2-Intensität (Schätzung)${r === "DE" ? ", Ø-Preis" : ""}.`,
          "",
          "### Strommix der Woche",
          "Tabelle der Quellen, absteigend, mit GWh, % und Veränderung zur Vorwoche in Prozentpunkten.",
          "",
          r === "DE" ? "### Preise\nØ, Minimum und Maximum mit Zeitpunkt, Anzahl negativer Stunden, günstigster und teuerster Tag.\n" : "",
          "### CO2",
          "Ø-Intensität, sauberste und schmutzigste Stunde, geschätzte Gesamtemissionen.",
          "",
          "### Auffälligkeiten",
          "2 bis 3 Stichpunkte mit Ursachen, nur was die Daten belegen.",
          "",
          SOURCE_LINE,
          "",
          HONESTY,
          LANGUAGE,
        ].join("\n"),
      );
    },
  );

  server.registerPrompt(
    "monatsvergleich",
    {
      title: "Monatsvergleich zum Vorjahr",
      description: "Vergleicht einen Monat mit demselben Monat des Vorjahres, in festem Format.",
      argsSchema: {
        monat: optionalText("Monat als 2026-09, 09.2026 oder September 2026; leer = letzter voller Monat"),
        region: optionalText("DE (Standard), 50Hertz, Amprion, TenneT oder TransnetBW"),
      },
    },
    ({ monat, region }) => {
      const { y, m } = resolveMonth(monat);
      const r = parseRegion(region);
      const name = `${MONATE[m - 1]} ${y}`;
      const prevName = `${MONATE[m - 1]} ${y - 1}`;
      const b = { from: iso({ y, m, d: 1 }), to: iso(lastDayOfMonth(y, m)) };
      const a = { from: iso({ y: y - 1, m, d: 1 }), to: iso(lastDayOfMonth(y - 1, m)) };
      return message(
        [
          `Vergleiche ${name} mit ${prevName} in ${r}. Rufe compare_periods mit period_a_from = "${a.from}", period_a_to = "${a.to}" (Vorjahr, Basis), period_b_from = "${b.from}", period_b_to = "${b.to}" und region = "${r}" auf und halte dich exakt an dieses Format:`,
          "",
          `## 📊 Strommarkt ${r} | ${name} im Vergleich zu ${prevName}`,
          "**Kurzfassung:** ein Satz mit der wichtigsten Veränderung.",
          "",
          `| Kennzahl | ${prevName} | ${name} | Veränderung |`,
          "|---|---|---|---|",
          `Zeilen: Ökostromanteil (Prozentpunkte), Erzeugung, Verbrauch, Ø-Last, CO2-Intensität (Schätzung), Erzeugung minus Verbrauch${r === "DE" ? ", Ø-Preis" : ""}.`,
          "",
          "### Strommix",
          "Tabelle aller Quellen mit GWh und Anteil in beiden Monaten und Veränderung in GWh und Prozentpunkten, nach größter Veränderung sortiert.",
          "",
          "### Einordnung",
          "2 bis 3 Stichpunkte: was hat sich verändert und warum, nur was die Daten belegen. Unterschiedliche Monatslängen oder unvollständige Daten erwähnen.",
          "",
          SOURCE_LINE,
          "",
          HONESTY,
          LANGUAGE,
        ].join("\n"),
      );
    },
  );

  server.registerPrompt(
    "region_vergleich",
    {
      title: "Vergleich der vier Regelzonen",
      description: "Vergleicht 50Hertz, Amprion, TenneT und TransnetBW in einem Zeitraum, in festem Format.",
      argsSchema: {
        von: optionalText("Beginn als JJJJ-MM-TT oder TT.MM.JJJJ; leer = gestern"),
        bis: optionalText("Ende (einschließlich) als JJJJ-MM-TT oder TT.MM.JJJJ; leer = gleich dem Beginn"),
      },
    },
    ({ von, bis }) => {
      const start = parseDate(von, yesterday());
      const end = bis ? parseDate(bis, start) : start;
      if (iso(end) < iso(start)) throw new Error('"bis" liegt vor "von".');
      const span = iso(start) === iso(end) ? german(start) : `${german(start)} bis ${german(end)}`;
      const zones = MIX_REGIONS.filter((z) => z !== "DE");
      return message(
        [
          `Vergleiche die vier deutschen Regelzonen für ${span}. Rufe get_generation_mix mit from = "${iso(start)}", to = "${iso(end)}" einmal je Region auf: ${zones.join(", ")}. Halte dich exakt an dieses Format:`,
          "",
          `## 🗺️ Regelzonen im Vergleich | ${span}`,
          "**Kurzfassung:** ein Satz, welche Zone am grünsten und welche am stärksten auf Importe angewiesen war.",
          "",
          "| Kennzahl | 50Hertz | Amprion | TenneT | TransnetBW |",
          "|---|---|---|---|---|",
          "Zeilen: Ökostromanteil, Erzeugung, Verbrauch, Erzeugung in % des Verbrauchs, CO2-Intensität (Schätzung), größte Quelle.",
          "",
          "### Strommix je Zone",
          "Je Zone die drei größten Quellen mit Anteil.",
          "",
          "### Auffälligkeiten",
          "2 bis 3 Stichpunkte, nur was die Daten belegen. Hinweis: Es gibt keine regionalen Preise (nur Gebotszone DE-LU); Erzeugung minus Verbrauch ist nur ein Indikator für Austausch zwischen den Zonen.",
          "",
          SOURCE_LINE,
          "",
          HONESTY,
          LANGUAGE,
        ].join("\n"),
      );
    },
  );

  server.registerPrompt(
    "beste_stunden",
    {
      title: "Beste Stunden für den Stromverbrauch",
      description: "Günstigstes oder grünstes Zeitfenster (z. B. zum Laden des E-Autos), in festem Format.",
      argsSchema: {
        dauer: optionalText("Dauer in Stunden, 1 bis 12; Standard 3"),
        ziel: optionalText("preis, gruen oder ausgewogen (Standard)"),
      },
    },
    ({ dauer, ziel }) => {
      const hours = dauer && dauer.trim() !== "" ? Number(dauer) : 3;
      if (!Number.isInteger(hours) || hours < 1 || hours > 12) throw new Error(`Ungültige Dauer "${dauer}". Erwartet: ganze Stunden von 1 bis 12.`);
      const goals: Record<string, "price" | "green" | "balanced"> = {
        preis: "price",
        price: "price",
        guenstig: "price",
        gruen: "green",
        grün: "green",
        green: "green",
        oeko: "green",
        ausgewogen: "balanced",
        balanced: "balanced",
      };
      const key = (ziel ?? "").trim().toLowerCase();
      const optimize = key === "" ? "balanced" : goals[key];
      if (!optimize) throw new Error(`Unbekanntes Ziel "${ziel}". Möglich: preis, gruen, ausgewogen.`);
      const label = { price: "am günstigsten", green: "am grünsten", balanced: "günstig und grün" }[optimize];
      return message(
        [
          `Finde das beste ${hours}-Stunden-Fenster (${label}). Rufe find_best_hours mit duration_hours = ${hours} und optimize = "${optimize}" auf (ohne date: morgen, falls die Preise schon veröffentlicht sind, sonst der Rest von heute). Halte dich exakt an dieses Format:`,
          "",
          `## 🔌 Beste ${hours} Stunden | <Wochentag>, <Datum aus der Antwort>`,
          "**Empfehlung:** Zeitfenster mit Ø-Preis und Ø-Grünanteil in einem Satz.",
          "",
          "| Kriterium | Zeitfenster | Ø-Preis | Ø-Grünanteil |",
          "|---|---|---|---|",
          "Zeilen: günstigstes, grünstes, ausgewogenes und zum Vergleich das schlechteste Fenster.",
          "",
          "### Stundenübersicht",
          "Kompakte Tabelle Stunde | Preis | Grünanteil, nur die Stunden des Tages, die in der Antwort stehen.",
          "",
          "### Hinweise",
          "Was fehlt (missing), dass es Großhandelspreise sind (für Haushalte nur mit dynamischem Tarif direkt relevant) und wie der Grünanteil definiert ist.",
          "",
          SOURCE_LINE,
          "",
          LANGUAGE,
        ].join("\n"),
      );
    },
  );
}

