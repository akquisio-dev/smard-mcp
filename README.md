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

## Tools

### `list_series`

Lists all available series with key, name, unit and category, plus supported regions and
resolutions. Optional `category` filter: `generation`, `consumption`, `price`,
`forecast_generation`, `forecast_consumption`.

### `get_series`

Fetches the values of one series.

| Argument     | Default | Description                                                                                    |
| ------------ | ------- | ---------------------------------------------------------------------------------------------- |
| `series`     |         | Series key from `list_series`, e.g. `price_de_lu`, `generation_solar`                          |
| `region`     | `DE`    | `DE`, `DE-LU`, `AT`, `LU`, `50Hertz`, `Amprion`, `TenneT`, `TransnetBW`                        |
| `resolution` | `hour`  | `quarterhour`, `hour`, `day`, `week`, `month`, `year`                                          |
| `from`       | now−24h | `YYYY-MM-DD` (midnight Europe/Berlin) or ISO 8601 date-time with offset                        |
| `to`         | now+24h | Exclusive; a plain `YYYY-MM-DD` includes that whole day. If only `from` is given: `from` + 48h |

Returns the points (Berlin local time with UTC offset) and a summary with count, min, max and
mean. Generation and consumption are energy per interval in MWh, prices are in EUR/MWh.
A single call returns at most 2000 points; use a coarser resolution for long ranges.

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
