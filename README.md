# mcp-sec

SEC MCP — SEC EDGAR public APIs (free, no auth)

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `search_companies` | Search SEC EDGAR for companies by name or ticker symbol. Returns matching company names and their CIK numbers, which are needed for other SEC tools. |
| `get_company_filings` | Get recent SEC filings for a company by CIK number, ticker, or company name. Returns filing dates, form types, and accession numbers. Optionally filter by form type (e.g., "10-K", "10-Q", "8-K"). |
| `get_company_facts` | Get XBRL financial facts for a company by CIK number, ticker, or company name. Returns structured financial data including revenue, net income, total assets, and other reported metrics over time. |

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Sec data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
