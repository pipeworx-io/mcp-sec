# @pipeworx/sec

SEC EDGAR company lookup, filing lists, and XBRL financial facts for US public companies — keyless, straight from the SEC's own APIs.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `search_companies(query)` — full-text company search over EDGAR; returns matching entities with CIKs.
- `get_company_filings(cik, form_type?)` — recent filings (10-K, 10-Q, 8-K, …) for a company by CIK, ticker, or name.
- `get_company_facts(cik)` — annual financial snapshot from XBRL companyfacts. `latest_annual` gives revenue, net income, operating income, gross profit, assets, liabilities, equity, cash, EPS and shares for the most recent fiscal year, each resolved to whichever us-gaap concept the filer currently reports under. `key_financials` has the per-concept detail, current concepts first; concepts the filer has retired are kept (a historical series still needs them) but flagged `stale: true` with a `stale_note` naming the replacement.

Not-found is a message, not a status code: a CIK EDGAR has never issued says so and points at `edgar_ticker_to_cik`; a CIK that exists but files no XBRL (funds, trusts, individuals) is named and pointed at `get_company_filings`; a ticker or name that resolves to nothing says what a valid one looks like. EDGAR covers US-registered filers only — foreign listings (`603986.SS`, `NESN`) are absent unless the company also files in the US.

## Auth

Keyless. The SEC requires a descriptive `User-Agent` on every request; the pack sends one.

## Data sources

- <https://efts.sec.gov/LATEST/search-index> — full-text company search.
- <https://data.sec.gov/submissions/CIK##########.json> — filing history.
- <https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json> — XBRL facts.

Three traps in companyfacts, all handled in `shared/src/xbrl.ts` (fleet #594, 2026-08-28):

- **`fy` is the fiscal year of the FILING, not the period.** A 10-K carries prior years as comparatives, all stamped with the filing's `fy`. Amazon's FY2020 net income shows `fy=2022` because the FY2022 10-K restated it. The pack derives `year` from `period_end` and never sorts by `fy`.
- **`frame` sits on the LAST-FILED fact for a period.** Since proxies (DEF 14A) started carrying XBRL, a filer's recent annual frames can all live on the proxy, so "10-K with a frame" silently stops years early. The pack ignores `frame` and picks the latest `period_end` among annual-report forms, tie-broken by latest `filed` (a restated figure wins).
- **Retired concepts look current per-concept.** Microsoft's `Revenues` stops at FY2010 (ASC 606 moved it to `RevenueFromContractWithCustomerExcludingAssessedTax`). Every figure carries its fiscal year, stale concepts are flagged and sorted last, and `latest_annual` always leads with the concept the filer uses now.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "sec": {
      "url": "https://gateway.pipeworx.io/sec/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/sec/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/sec_search_companies \
  -H 'Content-Type: application/json' \
  -d '{"query":"Apple"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/sec_search_companies`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "sec": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-sec"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-sec
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Sec data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
