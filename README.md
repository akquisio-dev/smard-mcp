# smard-mcp

An [MCP](https://modelcontextprotocol.io) server for German electricity market data from
[SMARD](https://www.smard.de), the market data platform of the Bundesnetzagentur.

It lets AI assistants answer questions about electricity generation by source, consumption,
day-ahead prices, cross-border flows, forecasts and estimated CO2 intensity, and find the cheapest
or greenest hours of a day, without having to know SMARD's internal ids or block layout.

## Hosted endpoint

```
https://energie.akquisio.eu/mcp
```

Streamable HTTP, no authentication. In claude.ai add it under Settings → Connectors → Add custom
connector; in Claude Code:

```sh
claude mcp add --transport http smard https://energie.akquisio.eu/mcp
```

## Run locally

Requires Node.js 22 or newer. The package is on npm as
[`smard-mcp`](https://www.npmjs.com/package/smard-mcp) and listed in the
[MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.akquisio-dev/smard-mcp`.

As a stdio server, e.g. in Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "smard": {
      "command": "npx",
      "args": ["-y", "smard-mcp"]
    }
  }
}
```

In Claude Code: `claude mcp add smard -- npx -y smard-mcp`.

From source:

```sh
git clone https://github.com/akquisio-dev/smard-mcp.git
cd smard-mcp
npm ci
npm run build
node dist/stdio.js
```

As an HTTP server:

```sh
PORT=8450 npm start   # serves http://127.0.0.1:8450/mcp and /health
```

| Variable   | Default     | Meaning                  |
| ---------- | ----------- | ------------------------ |
| `PORT`     | `8450`      | HTTP port                |
| `HOST`     | `127.0.0.1` | Bind address             |
| `MCP_PATH` | `/mcp`      | Path of the MCP endpoint |

## Example questions

- "How much solar and wind power is Germany producing right now, and what does power cost?"
- "How was the German electricity market yesterday?"
- "I plug in my car at 18:00 and leave at 7:00, I need 40 kWh at 11 kW: when should I charge, and what do I save?"
- "When should I run the washing machine tomorrow?" / "When is power greenest today?"
- "How much CO2 did German power generation emit per kWh last week, and when was it cleanest?"
- "How much electricity came from solar and lignite in Germany yesterday?"
- "What was the renewable share in the TenneT zone in March 2026?"
- "Compare the generation mix of October 2025 and October 2026."
- "How many hours with negative prices were there in the last 12 months, and when was power cheapest?"
- "Show the wind onshore forecast for tomorrow."
- "How much electricity did Germany import yesterday, and from which countries?"

## Tools

All tools are read-only. Times are Europe/Berlin; a date without time means midnight Berlin, and a
date-time without offset is read as Berlin local time. Every result names the period, the region,
the resolution used, how far the data reaches (`covered_until`, the end of the last included
interval), whether it covers the whole requested range (`complete`), notes, the source and the
time of the call (`server_time`).
Energy is given in GWh (TWh added in texts from 10,000 GWh), load in GW, prices in EUR/MWh with
two decimals, shares in %. If SMARD does not answer, the server retries and, if needed, serves cached data
up to 7 days old; the result then carries `warnings`.

### Analysis

| Tool                     | Purpose                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_current_status`     | Right now in one call: power per source in GW, renewable share, consumption, net export and CO2 intensity for the newest quarter-hour all series share (`as_of`, `data_age_minutes`), the current 15-minute price and an hourly outlook (price, wind and solar forecast, consumption forecast).             |
| `get_market_overview`    | One day in one call: mix, renewable share, CO2 intensity, consumption, DE-LU price statistics with 30-day context, and the next day's wind/solar/consumption forecasts and prices when published.                                                                                                           |
| `plan_charging`          | Charging plan between plug-in and departure (also over midnight) for a given energy (kWh) and power (kW): the cheapest, greenest or balanced quarter-hours, not necessarily contiguous, compared with charging right away, with the savings in EUR incl. VAT and optionally a retail cost.                  |
| `find_best_hours`        | Best contiguous window of a day for appliances with a fixed run time (1 to 12 hours, hourly or 15-minute steps) by price, green share (wind + solar in % of consumption, for DE or a TSO zone) or both, the worst window for comparison and a table per interval. Defaults to tomorrow once prices are out. |
| `get_co2_intensity`      | Estimated CO2 intensity per hour, weighted mean, cleanest and dirtiest hours, total emissions and breakdown by source. See [CO2 methodology](#co2-methodology).                                                                                                                                             |
| `get_cross_border_flows` | Electricity exchanged with neighbouring countries: net export or import, total exports and imports, per country and the hours with the largest net import/export. Physical (measured) or commercial (scheduled trades).                                                                                     |
| `get_generation_mix`     | Generation per source in GWh and %, renewable share, consumption (grid load), average load in GW, hours covered, generation in % of consumption, measured cross-border net export, CO2 intensity. Regions: DE and the four TSO zones.                                                                       |
| `compare_periods`        | Two periods side by side with all of the above and (DE) the mean price; differences are the change from A to B. Put the baseline, usually the older period, in A.                                                                                                                                           |
| `analyze_prices`         | DE-LU day-ahead prices: mean, median, min/max with time and ties, negative prices, the N cheapest and most expensive intervals (or all of them for short ranges), daily means, and the mean of the 30 days before.                                                                                          |

For periods without any data the analysis tools return an error: for the future it names the
newest available data and points to `get_series` with a `forecast_*` series or `price_de_lu`; for
the past it says when SMARD's data begins.

**Data coverage.** Generation, consumption and cross-border flows per country from January 2015,
day-ahead prices of the DE-LU bidding zone from October 2018, SMARD's physical net export series
from September 2020 (earlier, the net export is summed from the country series), 15-minute
day-ahead prices from October 2025.

`get_generation_mix`, `compare_periods`, `get_co2_intensity` and `get_cross_border_flows` use
hourly values for periods up to 8 weeks and daily values above (daily values are published up to the previous day). Week, month and year values are
never used for totals, because SMARD leaves the running period empty. All series of one result are
cut at their newest common data point, so shares never mix different time horizons; a series
that ended long before the others (nuclear, last value January 2024) is reported in the notes
instead of holding the others back. Pumped storage does not count as renewable, as on SMARD.
Cross-border flows come from SMARD in two kinds: physical flows (measured, about 1 to 2 hours behind
real time) and commercial exchanges (scheduled trades, available until the end of the current day).
Exports are positive, imports negative. For a TSO zone only its borders to other countries count,
so the four zones add up to Germany. `get_generation_mix`, `compare_periods` and
`get_market_overview` report the measured physical net export as `net_export_gwh`.

`get_current_status` reads quarter-hour values of the last 6 hours and takes the newest
quarter-hour that generation, consumption and the physical net export have in common; SMARD
publishes them about 30 to 60 minutes after real time. A series more than an hour behind the others
is left out and named in `lagging` instead of holding the snapshot back. The outlook uses the
intraday wind and solar forecast where available, else the day-ahead forecast.

`analyze_prices` works on hourly prices for up to one year, or on quarter-hour prices for up to
8 weeks (15-minute day-ahead prices exist since 1 October 2025). Its context comparison with the
30 days before can be switched off with `context: false`.

`plan_charging` takes `from` and `to` as ISO date-times or bare times like `18:00` (the next
occurrence, so a window over midnight needs no date) and plans in 15-minute steps (`resolution:
"hour"` for whole hours). It uses the best intervals until `energy_kwh` at `power_kw` is reached; if
the amount does not divide evenly, the worst chosen interval is filled partially. A plan that would
split the charge but gain less than 0.10 EUR (or one percentage point of green share) over charging
right away is replaced by one block from the start. Before the day-ahead auction around noon, the
part of the window after midnight has no prices yet: the result says so first (`prices_until`,
`missing`) and plans only within the priced part; the energy left out is `unplanned_kwh`, while
`shortfall_kwh` is only energy that does not fit before departure even at full power. A bare `from`
time up to 12 hours ago means the car is plugged in already, so planning starts now. Savings are the wholesale difference times
(1 + VAT) and only apply with a dynamic tariff; `surcharge_ct_kwh` (grid fees, levies and margin as
one flat net amount) only adds an absolute retail cost. `energy_kwh` is energy drawn from the grid;
charging losses are not modelled.

`find_best_hours` uses actual values for past days, the intraday forecast (updated during the day,
with the day-ahead forecast where it is missing) for today and the day-ahead forecast for later
days; intervals that have already started are left out. `balanced` scales price and green share
each to the range 0 to 1 over the intervals of the day, where the cheapest and the greenest interval
get 1, and weighs both equally. `region` only changes the green share; the price is always that of
the DE-LU bidding zone. Its prices are wholesale day-ahead prices without taxes, levies and grid
fees, so for households they matter directly only with a dynamic tariff.

### Prompts

Ready-made report templates in German (the answer switches to English if the user writes
English). The server fills in dates, weekdays and the exact tool calls.

| Prompt             | Arguments                                                        | Report                                        |
| ------------------ | ---------------------------------------------------------------- | --------------------------------------------- |
| `strom_uebersicht` | `datum` (default yesterday), `region`                            | Day overview via `get_market_overview`        |
| `wochen_bericht`   | `woche` (`2026-W41`, `KW 41 2026` or a date), `region`           | Week report compared with the previous week   |
| `monatsvergleich`  | `monat` (`2026-09`, `September 2026`), `region`                  | Month compared with the same month a year ago |
| `region_vergleich` | `von`, `bis`                                                     | The four TSO zones side by side               |
| `beste_stunden`    | `dauer` (1 to 12 hours), `ziel` (`preis`, `gruen`, `ausgewogen`) | Best time window via `find_best_hours`        |

### CO2 methodology

CO2 intensity = sum over sources of (generation x emission factor) / total generation. The
factors are **direct CO2 emissions from combustion per kWh of electricity**, derived from
Umweltbundesamt, [Climate Change 03/2025](https://www.umweltbundesamt.de/system/files/medien/11850/publikationen/03_2025_cc_emissionsbilanz_erneuerbarer_energien_2023.pdf)
"Emissionsbilanz erneuerbarer Energieträger" (data year 2023): direct CO2 per kWh of primary
energy from the national emission inventory (table 6) divided by the mean gross efficiency of
the plants (table 5).

| Source              | g CO2/kWh | Basis                                                                                                                |
| ------------------- | --------: | -------------------------------------------------------------------------------------------------------------------- |
| Lignite             |       992 | 394.95 g/kWh primary energy / 39.8 %                                                                                 |
| Hard coal           |       775 | 338.82 g/kWh / 43.7 %                                                                                                |
| Natural gas         |       362 | 202.77 g/kWh / 56.0 %                                                                                                |
| Other conventional  |       707 | **Uncertain.** Mix of oil, blast-furnace and mine gas, waste; oil value (266.47 g/kWh / 37.7 %), likely conservative |
| Renewables, biomass |         0 | No combustion, or biogenic CO2 (counted as climate-neutral)                                                          |
| Nuclear             |         0 | No combustion                                                                                                        |
| Pumped storage      |         0 | Stored electricity was generated and counted before (no double count)                                                |

The result is an **estimate**: based on generation in the region, without imports and exports,
direct emissions only (no upstream chain, no other greenhouse gases). It is the **average**
intensity of the generation mix, not the marginal emissions of additional consumption: which power
plant reacts to an extra load (for example charging a car now) cannot be read from SMARD's data,
so this server does not estimate it.

**Plausibility check.** For Germany this server estimates 282 g/kWh for 2024 (123.4 Mt CO2 for
437.7 TWh) and 275 g/kWh for 2025 (120.5 Mt for 437.9 TWh). The Umweltbundesamt
[reports](https://www.umweltbundesamt.de/themen/co2-emissionen-pro-kilowattstunde-strom-2025-nur)
353 g/kWh for 2024 and 344 g/kWh for 2025 (as of March 2026). Both series fall by about 2.5 %
from 2024 to 2025, but this server's values are about 20 % lower. The main reasons are
methodological:

- UBA divides the emissions of all German power generation by **consumption** (449 TWh in 2025),
  this server divides by SMARD's **net generation**.
- UBA's emissions cover all power plants including industrial ones; SMARD's generation data
  probably does not contain all of them, so this server's total emissions (about 120 Mt) are lower than
  UBA's (about 154 Mt implied by 344 g/kWh x 449 TWh).
- The factors use gross efficiencies, but SMARD reports net generation; per net kWh, coal plants
  emit a few percent more.
- "Other conventional" includes blast-furnace gas, which emits far more than the oil value used
  here, so that factor is likely conservative.

Use the values for comparisons (hour to hour, day to day, region to region, year to year), not
as official emission figures.

### Raw data

#### `list_series`

Lists all available series with key, name, unit, category and (prices) bidding zone, plus regions,
resolutions, the server version and the current server time. Optional `category` filter:
`generation`, `consumption`, `price`, `forecast_generation`, `forecast_consumption`, `cross_border`.

#### `get_series`

Fetches the values of one series.

| Argument         | Default | Description                                                                                         |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `series`         |         | Series key from `list_series`, e.g. `price_de_lu`, `generation_solar`                               |
| `region`         | `DE`    | `DE`, `DE-LU`, `AT`, `LU`, `50Hertz`, `Amprion`, `TenneT`, `TransnetBW`; price series: `DE`/`DE-LU` |
| `resolution`     | `hour`  | `quarterhour`, `hour`, `day`, `week`, `month`, `year`                                               |
| `from`           | now−24h | `YYYY-MM-DD` or ISO 8601 date-time                                                                  |
| `to`             | now+24h | Exclusive; a plain `YYYY-MM-DD` includes that whole day. If only `from` is given: `from` + 48h      |
| `unit`           | `MWh`   | Energy series: `MWh` per interval, or `MW` = average power over each interval                       |
| `include_points` | `true`  | `false` returns only the summary (count, min, max, mean, sum)                                       |

Generation and consumption are energy per interval in MWh (or average power with `unit: "MW"`,
divided by the real interval length, so DST days come out right), prices are in EUR/MWh. For
measured series whose range reaches the present, `data_age_minutes` says how old the newest value
is. Price series
belong to a bidding zone chosen by the series key and are the same for every region, so they only
accept `DE` or `DE-LU`. With `week`, `month` or `year` a value is only returned if the period
starts inside the range, and the running period is missing. A single call returns at most 2000
points.

## Privacy

What happens when you use the hosted endpoint `https://energie.akquisio.eu/mcp`:

- **Cloudflare** sits in front of the server as a proxy (TLS, DDoS protection) and therefore
  processes your IP address and the request, under
  [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- **Web server (nginx) access log:** shortened IP address (IPv4 without the last octet, IPv6 at most
  the first three blocks), time, method, path without query string, status, response size and
  duration. No user agent, no referrer, no request bodies. Deleted after 7 days.
- **Web server error log:** only real server errors; nginx writes the full IP address into such
  entries. Requests rejected by the rate limit are not logged. Deleted after 7 days.
- **Rate limit:** counts requests per IP address in memory only (no file, no database): 5 requests per
  second (burst 20) per address, 30 per second (burst 100) for Anthropic's published outbound range,
  which carries the requests of many claude.ai users.
- **The MCP server itself** does not log requests, tool arguments or IP addresses (it does not even
  receive your IP address). Tool arguments are processed in memory for the duration of the
  request.
- **SMARD:** to answer a tool call the server fetches data files from smard.de. These requests
  contain only the series, region, resolution and time block, nothing about you. The fetched SMARD
  data is cached in memory (fresh for up to 24 hours, kept up to 7 days as a fallback when SMARD
  does not answer).
- No cookies, no accounts, no analytics, no data is passed on to anyone else.

If you prefer, run the server yourself (see [Run locally](#run-locally)); with stdio nothing leaves
your machine except the requests to smard.de. Questions: please open a
[GitHub issue](https://github.com/akquisio-dev/smard-mcp/issues).

## Operations

- `GET /health` reports name and version; `GET /health?deep=1` also checks that SMARD answers (at
  most every 5 minutes, otherwise the last result is returned; HTTP 503 if SMARD is unreachable).
- `npm run smoke` checks the live SMARD API (core series: shape, plausible values, newest value at
  most 48 hours old) and that every series id of the catalog is still listed in SMARD's module
  configuration; with `SMOKE_ENDPOINT` it also checks a running server (health, MCP handshake,
  tools, one call). A GitHub Action runs it daily against `energie.akquisio.eu`, because SMARD's
  API is unofficial and may change.
- Dependabot keeps npm packages and GitHub Actions up to date (weekly).
- `npm run deploy` deploys the current, pushed commit to a server set up like `deploy/` describes
  (settings in `deploy/deploy.env`, see `deploy/deploy.env.example`). It runs typecheck, lint,
  tests and build, keeps a copy of the running version, restarts the service and rolls back automatically if
  `/health` does not report the new version afterwards.

## Data source and license

Data: **Bundesnetzagentur | SMARD.de**, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Please keep this attribution when
you publish data obtained through this server. This project is not affiliated with the
Bundesnetzagentur.

The code in this repository is licensed under the [MIT License](LICENSE).

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and, for reporting vulnerabilities, [SECURITY.md](SECURITY.md).
Changes are listed in [CHANGELOG.md](CHANGELOG.md).
