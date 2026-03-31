interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * SEC MCP — SEC EDGAR public APIs (free, no auth)
 *
 * Tools:
 * - search_companies: full-text search for companies by name or ticker, returns CIK numbers
 * - get_company_filings: recent SEC filings for a company by CIK
 * - get_company_facts: XBRL financial facts (revenue, assets, etc.) for a company by CIK
 *
 * Note: SEC requires a descriptive User-Agent header per their guidelines.
 */


const EFTS_BASE = 'https://efts.sec.gov/LATEST';
const DATA_BASE = 'https://data.sec.gov';
const SEC_HEADERS = {
  'User-Agent': 'Pipeworx contact@pipeworx.io',
  Accept: 'application/json',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'search_companies',
    description:
      'Search SEC EDGAR for companies by name or ticker symbol. Returns matching company names and their CIK numbers, which are needed for other SEC tools.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Company name or ticker to search for (e.g., "Apple", "TSLA", "Microsoft")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_company_filings',
    description:
      'Get recent SEC filings for a company using its CIK number. Returns filing dates, form types, and accession numbers. Optionally filter by form type (e.g., "10-K", "10-Q", "8-K").',
    inputSchema: {
      type: 'object',
      properties: {
        cik: {
          type: 'string',
          description: 'Company CIK number (digits only, e.g., "320193" for Apple)',
        },
        form_type: {
          type: 'string',
          description: 'Filter by SEC form type (e.g., "10-K", "10-Q", "8-K", "DEF 14A"). Omit to return all recent filings.',
        },
      },
      required: ['cik'],
    },
  },
  {
    name: 'get_company_facts',
    description:
      'Get XBRL financial facts for a company using its CIK number. Returns structured financial data including revenue, net income, total assets, and other reported metrics over time.',
    inputSchema: {
      type: 'object',
      properties: {
        cik: {
          type: 'string',
          description: 'Company CIK number (digits only, e.g., "320193" for Apple)',
        },
      },
      required: ['cik'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_companies':
      return searchCompanies(args.query as string);
    case 'get_company_filings':
      return getCompanyFilings(args.cik as string, args.form_type as string | undefined);
    case 'get_company_facts':
      return getCompanyFacts(args.cik as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function padCik(cik: string): string {
  return cik.replace(/\D/g, '').padStart(10, '0');
}

async function searchCompanies(query: string) {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`${EFTS_BASE}/search-index?${params}`, {
    headers: SEC_HEADERS,
  });
  if (!res.ok) throw new Error(`SEC EDGAR search error: ${res.status}`);

  const data = (await res.json()) as {
    hits: {
      hits: {
        _source: {
          entity_name: string;
          file_num: string;
          period_of_report: string;
          biz_location: string;
          inc_states: string;
          category: string;
          form_type: string;
          file_date: string;
          entity_id: string;
        };
      }[];
      total: { value: number };
    };
  };

  // Deduplicate by entity_id (CIK) to return unique companies
  const seen = new Set<string>();
  const companies: { cik: string; name: string; category: string }[] = [];

  for (const hit of hits(data)) {
    const src = hit._source;
    const cik = src.entity_id;
    if (!seen.has(cik)) {
      seen.add(cik);
      companies.push({
        cik,
        name: src.entity_name,
        category: src.category ?? '',
      });
    }
  }

  return {
    query,
    total_hits: data.hits?.total?.value ?? 0,
    companies,
  };
}

function hits(data: {
  hits: {
    hits: {
      _source: {
        entity_name: string;
        file_num: string;
        period_of_report: string;
        biz_location: string;
        inc_states: string;
        category: string;
        form_type: string;
        file_date: string;
        entity_id: string;
      };
    }[];
    total: { value: number };
  };
}) {
  return data?.hits?.hits ?? [];
}

async function getCompanyFilings(cik: string, formType?: string) {
  const paddedCik = padCik(cik);
  const res = await fetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, {
    headers: SEC_HEADERS,
  });
  if (!res.ok) throw new Error(`SEC EDGAR submissions error: ${res.status}`);

  const data = (await res.json()) as {
    cik: string;
    name: string;
    sic: string;
    sicDescription: string;
    stateOfIncorporation: string;
    fiscalYearEnd: string;
    filings: {
      recent: {
        accessionNumber: string[];
        filingDate: string[];
        form: string[];
        primaryDocument: string[];
        items: string[];
        size: number[];
      };
    };
  };

  const recent = data.filings.recent;
  const filings: {
    accession_number: string;
    filing_date: string;
    form: string;
    primary_document: string;
    document_url: string;
  }[] = [];

  for (let i = 0; i < recent.accessionNumber.length; i++) {
    const form = recent.form[i];
    if (formType && form !== formType) continue;

    const accession = recent.accessionNumber[i];
    const accessionPath = accession.replace(/-/g, '');
    filings.push({
      accession_number: accession,
      filing_date: recent.filingDate[i],
      form,
      primary_document: recent.primaryDocument[i],
      document_url: `https://www.sec.gov/Archives/edgar/data/${data.cik}/${accessionPath}/${recent.primaryDocument[i]}`,
    });

    if (filings.length >= 20) break;
  }

  return {
    cik: data.cik,
    company_name: data.name,
    sic_description: data.sicDescription,
    state_of_incorporation: data.stateOfIncorporation,
    fiscal_year_end: data.fiscalYearEnd,
    filter_form_type: formType ?? 'all',
    filings,
  };
}

async function getCompanyFacts(cik: string) {
  const paddedCik = padCik(cik);
  const res = await fetch(`${DATA_BASE}/api/xbrl/companyfacts/CIK${paddedCik}.json`, {
    headers: SEC_HEADERS,
  });
  if (!res.ok) throw new Error(`SEC EDGAR company facts error: ${res.status}`);

  const data = (await res.json()) as {
    cik: number;
    entityName: string;
    facts: {
      'us-gaap'?: Record<
        string,
        {
          label: string;
          description: string;
          units: Record<
            string,
            {
              end: string;
              val: number;
              accn: string;
              fy: number;
              fp: string;
              form: string;
              filed: string;
              frame?: string;
            }[]
          >;
        }
      >;
    };
  };

  // Extract a curated set of key financial metrics with the most recent annual values
  const usGaap = data.facts?.['us-gaap'] ?? {};
  const KEY_METRICS = [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'NetIncomeLoss',
    'Assets',
    'Liabilities',
    'StockholdersEquity',
    'CashAndCashEquivalentsAtCarryingValue',
    'EarningsPerShareBasic',
    'EarningsPerShareDiluted',
    'CommonStockSharesOutstanding',
    'OperatingIncomeLoss',
    'GrossProfit',
    'ResearchAndDevelopmentExpense',
  ];

  const metrics: Record<
    string,
    { label: string; most_recent_annual: { year: number; value: number; filed: string } | null }
  > = {};

  for (const key of KEY_METRICS) {
    const fact = usGaap[key];
    if (!fact) continue;

    // Find the most recent 10-K (annual) USD value
    const usdEntries = fact.units['USD'] ?? fact.units['shares'] ?? [];
    const annual = usdEntries
      .filter((e) => e.form === '10-K' && e.frame !== undefined)
      .sort((a, b) => (b.fy ?? 0) - (a.fy ?? 0));

    metrics[key] = {
      label: fact.label,
      most_recent_annual: annual[0]
        ? { year: annual[0].fy, value: annual[0].val, filed: annual[0].filed }
        : null,
    };
  }

  return {
    cik: String(data.cik),
    company_name: data.entityName,
    key_financials: metrics,
    available_concepts: Object.keys(usGaap).length,
  };
}

export default { tools, callTool } satisfies McpToolExport;
