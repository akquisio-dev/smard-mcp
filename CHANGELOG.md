# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, minor versions may contain breaking
changes; they are marked as such.

## [0.8.0] - 2026-10-13

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

[0.8.0]: https://github.com/akquisio-dev/smard-mcp/compare/443c24d...HEAD
[0.7.0]: https://github.com/akquisio-dev/smard-mcp/compare/5b7f972...443c24d
[0.6.0]: https://github.com/akquisio-dev/smard-mcp/compare/b28cd06...5b7f972
[0.5.0]: https://github.com/akquisio-dev/smard-mcp/compare/1456b61...b28cd06
[0.4.0]: https://github.com/akquisio-dev/smard-mcp/compare/1456b61...9eb3f69
[0.3.0]: https://github.com/akquisio-dev/smard-mcp/compare/0211d8a...1456b61
[0.2.0]: https://github.com/akquisio-dev/smard-mcp/compare/01eaf87...0211d8a
[0.1.0]: https://github.com/akquisio-dev/smard-mcp/commit/01eaf87
