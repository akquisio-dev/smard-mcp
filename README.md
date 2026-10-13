# smard-mcp

An [MCP](https://modelcontextprotocol.io) server for German electricity market data from
[SMARD](https://www.smard.de), the market data platform of the Bundesnetzagentur.

It lets AI assistants query electricity generation by source, consumption, day-ahead prices
and forecasts directly, without having to know SMARD's internal ids or block layout.

## Hosted endpoint

```
https://energie.akquisio.eu/mcp
```

Streamable HTTP, no authentication. Add it as a remote MCP server in your client, for example in
Claude Code:

```sh
claude mcp add --transport http smard https://energie.akquisio.eu/mcp
```

## Run locally

Requires Node.js 22 or newer.

```sh
git clone https://github.com/akquisio-dev/smard-mcp.git
cd smard-mcp
npm ci
npm run build
```

As a stdio server (e.g. in Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "smard": {
      "command": "node",
      "args": ["/path/to/smard-mcp/dist/stdio.js"]
    }
  }
}
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

- "How was the German electricity market yesterday?"
- "When should I charge my electric car tomorrow?" / "When is power greenest today?"
- "How much CO2 did German power generation emit per kWh last week, and when was it cleanest?"
- "How much electricity came from solar and lignite in Germany yesterday?"
- "What was the renewable share in the TenneT zone in March 2026?"
- "Compare the generation mix of October 2025 and October 2026."
- "How many hours with negative prices were there in the last 12 months, and when was power cheapest?"
- "Show the wind onshore forecast for tomorrow."

## Tools

All tools are read-only. Times are Europe/Berlin; a date without time means midnight Berlin, and a
date-time without offset is read as Berlin local time. Every result names the period, the region,
the resolution used, how far the data reaches (`covered_until`, the end of the last included
interval), whether it covers the whole requested range (`complete`), notes, and the source.
Energy is given in GWh (TWh added in texts from 10,000 GWh), load in GW, prices in EUR/MWh with
two decimals, shares in %.

### Analysis

| Tool                  | Purpose                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_market_overview` | One day in one call: mix, renewable share, CO2 intensity, consumption, DE-LU price statistics with 30-day context, and the next day's wind/solar/consumption forecasts and prices when published.                                                                      |
| `find_best_hours`     | Best contiguous window of a day (1 to 12 hours, hourly or 15-minute steps) by price, green share (wind + solar in % of consumption, for DE or a TSO zone) or both, the worst window for comparison and a table per interval. Defaults to tomorrow once prices are out. |
| `get_co2_intensity`   | Estimated CO2 intensity per hour, weighted mean, cleanest and dirtiest hours, total emissions and breakdown by source. See [CO2 methodology](#co2-methodology).                                                                                                        |
| `get_generation_mix`  | Generation per source in GWh and %, renewable share, consumption (grid load), average load in GW, hours covered, generation in % of and minus consumption, CO2 intensity. Regions: DE and the four TSO zones.                                                          |
| `compare_periods`     | Two periods side by side with all of the above and (DE) the mean price; differences are the change from A to B. Put the baseline, usually the older period, in A.                                                                                                      |
| `analyze_prices`      | DE-LU day-ahead prices: mean, median, min/max with time and ties, negative prices, the N cheapest and most expensive intervals (or all of them for short ranges), daily means, and the mean of the 30 days before.                                                     |

For periods without any data, for example in the future, the analysis tools return an error that
names the newest available data; use `get_series` with a `forecast_*` series or `price_de_lu`
instead.

`get_generation_mix` and `compare_periods` use hourly values for periods up to 8 weeks and daily
values above (daily values are published up to the previous day). Week, month and year values are
never used for totals, because SMARD leaves the running period empty. All series of one result are
cut at their newest common data point, so shares never mix different time horizons; a series
that ended long before the others (nuclear, last value January 2024) is reported in the notes
instead of holding the others back. Pumped storage does not count as renewable, as on SMARD.
Generation minus consumption is an indicator for net exports, not the exact physical exchange
(pumped storage and grid losses are included).

`analyze_prices` works on hourly prices for up to one year, or on quarter-hour prices for up to
8 weeks (15-minute day-ahead prices exist since 1 October 2025). Its context comparison with the
30 days before can be switched off with `context: false`.

`find_best_hours` uses forecasts (wind + solar generation, consumption) for today and later days
and actual values for past days; intervals that have already started are left out. `balanced`
scales price and green share each to 0..1 over the intervals of the day (cheapest = 1, greenest =

1. and weighs them equally. `region` only changes the green share; the price is always that of the
   DE-LU bidding zone. Its prices are wholesale day-ahead prices without taxes, levies
   and grid fees, so for households they matter directly only with a dynamic tariff.

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
direct emissions only (no upstream chain, no other greenhouse gases).

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
resolutions and the current server time. Optional `category` filter: `generation`, `consumption`,
`price`, `forecast_generation`, `forecast_consumption`.

#### `get_series`

Fetches the values of one series.

| Argument         | Default | Description                                                                                         |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `series`         |         | Series key from `list_series`, e.g. `price_de_lu`, `generation_solar`                               |
| `region`         | `DE`    | `DE`, `DE-LU`, `AT`, `LU`, `50Hertz`, `Amprion`, `TenneT`, `TransnetBW`; price series: `DE`/`DE-LU` |
| `resolution`     | `hour`  | `quarterhour`, `hour`, `day`, `week`, `month`, `year`                                               |
| `from`           | now−24h | `YYYY-MM-DD` or ISO 8601 date-time                                                                  |
| `to`             | now+24h | Exclusive; a plain `YYYY-MM-DD` includes that whole day. If only `from` is given: `from` + 48h      |
| `include_points` | `true`  | `false` returns only the summary (count, min, max, mean, sum)                                       |

Generation and consumption are energy per interval in MWh, prices are in EUR/MWh. Price series
belong to a bidding zone chosen by the series key and are the same for every region, so they only
accept `DE` or `DE-LU`. With `week`, `month` or `year` a value is only returned if the period
starts inside the range, and the running period is missing. A single call returns at most 2000
points.

## Privacy

What happens when you use the hosted endpoint `https://energie.akquisio.eu/mcp`:

- **Cloudflare** sits in front of the server as a proxy (TLS, DDoS protection) and therefore
  processes your IP address and the request, under
  [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- **Web server (nginx) access log:** shortened IP address (IPv4 without the last octet, IPv6 only
  the first three blocks), time, method, path without query string, status, response size and
  duration. No user agent, no referrer, no request bodies. Deleted after 7 days.
- **Web server error log:** only real server errors; nginx writes the full IP address into such
  entries. Requests rejected by the rate limit are not logged. Deleted after 7 days.
- **Rate limit:** counts requests per IP address in memory only (no file, no database).
- **The MCP server itself** does not log requests, tool arguments or IP addresses (it does not even
  receive your IP address). Tool arguments are processed in memory for the duration of the
  request.
- **SMARD:** to answer a tool call the server fetches data files from smard.de. These requests
  contain only the series, region, resolution and time block, nothing about you. The fetched SMARD
  data is cached in memory for up to 24 hours.
- No cookies, no accounts, no analytics, no data is passed on to anyone else.

If you prefer, run the server yourself (see [Run locally](#run-locally)); with stdio nothing leaves
your machine except the requests to smard.de. Questions: please open a
[GitHub issue](https://github.com/akquisio-dev/smard-mcp/issues).

## Operations

- `GET /health` reports name and version; `GET /health?deep=1` also checks that SMARD answers (at
  most every 5 minutes, otherwise the last result is returned; HTTP 503 if SMARD is unreachable).
- `npm run smoke` checks the live SMARD API (core series: shape, plausible values, newest value at
  most 48 hours old). A GitHub Action runs it daily, because SMARD's API is unofficial and may
  change.
- Dependabot keeps npm packages and GitHub Actions up to date (weekly).

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
npm test
```
