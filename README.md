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

- "How much electricity came from solar and lignite in Germany yesterday?"
- "What was the renewable share in the TenneT zone in March 2026?"
- "Compare the generation mix of October 2025 and October 2026."
- "How many hours with negative prices were there in the last 12 months, and when was power cheapest?"
- "What will electricity cost tomorrow between 17:00 and 20:00?"
- "Show the wind onshore forecast for tomorrow."

## Tools

All tools are read-only. Times are Europe/Berlin; a date without time means midnight Berlin, and a
date-time without offset is read as Berlin local time. Every result names the period, the region,
the resolution used, the newest data point (`data_until`), notes on incomplete data, and the
source.

### Analysis

| Tool                 | Purpose                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_generation_mix` | Generation per source in GWh and %, renewable share, consumption (grid load), average load in GW and generation in % of consumption. Regions: DE and the four TSO zones. |
| `compare_periods`    | Two periods side by side: mix, renewable share, consumption and (DE) mean price, with differences B minus A in GWh, percentage points and EUR/MWh.                       |
| `analyze_prices`     | DE-LU day-ahead prices: mean, median, min/max with time, negative prices, the N cheapest and most expensive intervals, daily means.                                      |

`get_generation_mix` and `compare_periods` use hourly values for periods up to 8 weeks and daily
values above (daily values are published up to the previous day). Week, month and year values are
never used for totals, because SMARD leaves the running period empty. All series of one result are
cut at their newest common data point, so shares never mix different time horizons. Pumped storage
does not count as renewable, as on SMARD.

`analyze_prices` works on hourly prices for up to one year, or on quarter-hour prices for up to
8 weeks (15-minute day-ahead prices exist since 1 October 2025).

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
