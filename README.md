# @pipeworx/mcp-sec

MCP server for SEC filings — search company filings and disclosures via EDGAR.

## Tools

| Tool | Description |
|------|-------------|
| `search_companies` | Search SEC EDGAR for companies by name or ticker symbol |
| `get_company_filings` | Get recent SEC filings for a company by CIK number |
| `get_company_facts` | Get XBRL financial facts (revenue, assets, etc.) for a company by CIK |

## Quick Start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "sec": {
      "url": "https://gateway.pipeworx.io/sec/mcp"
    }
  }
}
```

## CLI Usage

```bash
npx pipeworx use sec
```

## License

MIT
