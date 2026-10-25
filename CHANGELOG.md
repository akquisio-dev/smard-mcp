# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, minor versions may contain breaking
changes; they are marked as such.

## [Unreleased]

### Security

- zod 4.6.5 -> 4.6.7 (CVE-2023-54404).
- body-parser 2.3.0 -> 2.4.0 (CVE-2026-111181), pulled in by express.

## [1.3.0] - 2026-10-14

### Added

- Installed capacity per generation source as series `capacity_*` (MW, one value per year since 2015) in `get_series` and `list_series` (category `capacity`).
- `get_current_status`: installed capacity and utilization per source. No utilization where the
  power exceeds SMARD's capacity value.
- `get_cross_border_flows`: `country` for one neighbour's values per hour (or day), and
  `include_intervals` for all borders per interval.

## [1.2.0] - 2026-10-14

### Added

- `plan_charging`: when to charge an electric car or battery between plug-in and departure, also
  over midnight (`from`/`to` accept bare times like `18:00`). Takes the energy in kWh and the power
  in kW, picks the cheapest, greenest or balanced quarter-hours (not necessarily contiguous, or one
  block with `contiguous`), compares with charging right away and gives the savings in EUR incl.
  VAT; with `surcharge_ct_kwh` also a retail cost. Says first when tomorrow's prices are not
  published yet and reports the energy that could not be planned for lack of data
  (`unplanned_kwh`) apart from energy that physically does not fit (`shortfall_kwh`).

### Changed

- `find_best_hours` and the server instructions now point car charging to `plan_charging`;
  `find_best_hours` is for appliances with a fixed run time.

## [1.1.0] - 2026-10-14

From feedback of an AI agent that used the connector.

### Added

- `get_current_status`: what is happening right now in one call. Power per source in GW,
  renewable share, consumption, net export and CO2 intensity for the newest quarter-hour all
  series share, how old it is (`data_age_minutes`), the current 15-minute price and an hourly
  outlook. Series lagging more than an hour are named in `lagging` instead of holding the rest back.
- `get_series`: `unit: "MW"` returns average power instead of energy per interval; `data_age_minutes`
  for measured series whose range reaches the present.
- `server_time` in every result.

### Changed

- CO2 texts say that the intensity is the average of the generation mix, not the marginal
  emissions of additional consumption.

## [1.0.1] - 2026-10-14

### Changed

- `@modelcontextprotocol/sdk` 1.32.1 (was 1.31.0).
- Development tools: eslint 10.12.0, typescript-eslint 8.71.1, vitest 5.0.3.

## [1.0.0] - 2026-10-13

First stable release. From now on, output fields and tool names only change in a backwards
compatible way until 2.0.

### Added

- Published on npm (`npx -y smard-mcp`) and prepared for the MCP Registry
  (`io.github.akquisio-dev/smard-mcp`, `server.json` with the npm package and the hosted endpoint).

## [0.9.0] - 2026-10-13

Bug hunt before 1.0: cross-checked all tools against each other and against SMARD's CSV export,
probed edge cases live (DST days, year boundary, leap day, range limits, data start, invalid
input).

### Fixed

- Cross-border net export before September 2020: SMARD's physical net series only starts on
  2020-09-24. `get_cross_border_flows` reported 0 for older periods; it now sums the country
  series. Mix, comparison and overview fall back to the country series when the net series is
  missing or starts inside the range.
- Daily values ending on a DST switch day: `covered_until`, `complete` and `hours` were off by one
  hour (the last day was assumed to have 24 hours).
- Periods before SMARD's data start now say when the data begins instead of pointing to
  forecasts.
- `get_cross_border_flows` text no longer repeats the net figure.
- README and the `compare_periods` description no longer mention the removed
  generation-minus-consumption value; README documents data coverage per series.

### Changed (breaking)

- `data_until` removed from all results; use `covered_until` (end of the last included interval)
  and `complete`.
- `balance_gwh` (generation minus consumption) removed from `get_generation_mix`,
  `compare_periods` and `get_market_overview`; the measured `net_export_gwh` replaces it.
- `find_best_hours`: `hours` renamed to `intervals` (it also holds quarter-hours), `price_zone`
  renamed to `bidding_zone`.
- CO2 intensity is called `co2_intensity_g_per_kwh` in every tool (was `mean_g_per_kwh` in
  `get_co2_intensity` and `intensity_g_per_kwh` in `get_market_overview`).
- `get_market_overview`: the price block carries the same `context` object as `analyze_prices`
  instead of `reference_mean_30d_eur_mwh` and `deviation_from_30d_pct`.

### Added

- Failed SMARD requests (network error, timeout, HTTP 5xx or 429) are retried; if SMARD stays
  unreachable, cached data up to 7 days old is served and the result carries `warnings`.
- `list_series` reports the server name and version.
- Daily smoke test also checks every catalog id against SMARD's module configuration and the
  public endpoint (health, MCP handshake, tools, one call).
- Load test (`LOAD_TEST=1 npx vitest run test/load.test.ts`), ESLint, CHANGELOG, SECURITY.md,
  CONTRIBUTING.md, issue templates and a release workflow (dry run until 1.0).

## [0.7.0] - 2026-10-13

### Added

- `get_cross_border_flows`: physical flows or commercial exchanges with neighbouring countries,
  net and per country, with peak hours; Germany and the four TSO zones.
- Measured physical net export (`net_export_gwh`) in `get_generation_mix`, `compare_periods` and
  `get_market_overview`.
- `find_best_hours` uses SMARD's intraday wind and solar forecast for today.
- Intraday forecast series and cross-border net export series in `get_series`.

## [0.6.0] - 2026-10-13

### Added

- `analyze_prices` compares with the same clock hours of the 30 days before
  (`same_hours_mean_eur_mwh`, `same_hours_deviation_pct`, `hours_compared`).
- Deploy script with checks and automatic rollback (`npm run deploy`).

### Changed

- Separate, higher rate limit for Anthropic's published outbound range on the hosted endpoint.

## [0.5.0] - 2026-10-13

### Added

- `find_best_hours`: `resolution` (hour or quarterhour) and `region` for the green share.
- `/health?deep=1`, daily smoke test against the live SMARD API, Dependabot.
- Privacy and operations documentation.

### Changed

- Version is read from package.json only.
- `get_market_overview`'s description no longer prescribes a report format; the
  `strom_uebersicht` prompt does.

## [0.4.0] - 2026-10-13

### Added

- `get_co2_intensity` with emission factors from the Umweltbundesamt; `co2_intensity_g_per_kwh` in
  the mix and the comparison.
- `find_best_hours` and `get_market_overview`.
- Prompts `strom_uebersicht`, `wochen_bericht`, `monatsvergleich`, `region_vergleich`,
  `beste_stunden`.

## [0.3.0] - 2026-10-13

### Added

- `covered_until` and `complete` in all results; errors instead of zeros for periods without data.
- Hours covered, TWh in texts, sources without generation, ties for price extremes, prices with
  two decimals, 30-day price context, full price list for short ranges.

## [0.2.0] - 2026-10-13

### Added

- `get_generation_mix`, `compare_periods` and `analyze_prices`.
- `get_series`: `sum`, `include_points`, price series restricted to their bidding zone.
- Date-times without offset are read as Europe/Berlin local time.

## [0.1.0] - 2026-10-13

### Added

- First version with `list_series` and `get_series`, stdio and Streamable HTTP.

[1.3.0]: https://github.com/akquisio-dev/smard-mcp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/akquisio-dev/smard-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/akquisio-dev/smard-mcp/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/akquisio-dev/smard-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/akquisio-dev/smard-mcp/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/akquisio-dev/smard-mcp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/akquisio-dev/smard-mcp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/akquisio-dev/smard-mcp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/akquisio-dev/smard-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/akquisio-dev/smard-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/akquisio-dev/smard-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/akquisio-dev/smard-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/akquisio-dev/smard-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/akquisio-dev/smard-mcp/releases/tag/v0.1.0
