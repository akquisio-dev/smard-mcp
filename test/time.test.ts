import { describe, expect, it } from "vitest";
import { formatBerlin, parseTime } from "../src/time.js";

describe("parseTime", () => {
  it("reads a plain date as midnight in Berlin (summer time)", () => {
    expect(parseTime("2026-07-01")).toBe(Date.parse("2026-06-30T22:00:00Z"));
  });

  it("reads a plain date as midnight in Berlin (winter time)", () => {
    expect(parseTime("2026-01-15")).toBe(Date.parse("2026-01-14T23:00:00Z"));
  });

  it("moves a plain end date to the start of the next day", () => {
    expect(parseTime("2026-07-01", true)).toBe(Date.parse("2026-07-01T22:00:00Z"));
  });

  it("handles the DST switch days", () => {
    // 2026-03-29 has 23 hours, 2026-10-25 has 25 hours in Berlin.
    expect(parseTime("2026-03-29", true) - parseTime("2026-03-29")).toBe(23 * 3_600_000);
    expect(parseTime("2026-10-25", true) - parseTime("2026-10-25")).toBe(25 * 3_600_000);
  });

  it("accepts ISO date-times with offset", () => {
    expect(parseTime("2026-10-01T12:00:00+02:00")).toBe(Date.parse("2026-10-01T10:00:00Z"));
    expect(parseTime("2026-10-01T10:00:00Z")).toBe(Date.parse("2026-10-01T10:00:00Z"));
  });

  it("reads date-times without offset as Berlin local time", () => {
    expect(parseTime("2026-10-12T14:00:00")).toBe(Date.parse("2026-10-12T12:00:00Z"));
    expect(parseTime("2026-01-12T14:00")).toBe(Date.parse("2026-01-12T13:00:00Z"));
    expect(parseTime("2026-03-29T03:00")).toBe(Date.parse("2026-03-29T01:00:00Z"));
    expect(parseTime("2026-03-29T01:00")).toBe(Date.parse("2026-03-29T00:00:00Z"));
  });

  it("rejects invalid input", () => {
    expect(() => parseTime("2026-10-01T25:00:00")).toThrow();
    expect(() => parseTime("yesterday")).toThrow();
    expect(() => parseTime("2026-02-30")).toThrow(/Invalid date/);
  });
});

describe("formatBerlin", () => {
  it("formats with the Berlin offset", () => {
    expect(formatBerlin(Date.parse("2026-07-01T10:00:00Z"))).toBe("2026-07-01T12:00:00+02:00");
    expect(formatBerlin(Date.parse("2026-01-01T10:00:00Z"))).toBe("2026-01-01T11:00:00+01:00");
  });
});
