interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


// Reusable entity-resolution helpers for MCP packs. SELF-CONTAINED — no internal
// imports — so publish-pack.sh can inline it into standalone pack builds the same
// way it inlines the McpToolExport type.
//
// Recurring failure mode across financial packs: callers pass a company NAME
// ("Apple", "apple inc") where a ticker / CIK / provider symbol is expected, and
// the pack 404s or throws "not found". `rankMatches` is a generic name-ranker any
// pack can run over its OWN list (US tickers, B3 tickers, drug names, airports…);
// `resolveSecEntity` wraps it around the SEC company_tickers.json universe, shared
// by the packs that key on CIK (edgar, sec).

type MatchKind = 'exact' | 'prefix' | 'word' | 'substring';

interface RankedMatch<T> {
  item: T;
  kind: MatchKind;
  score: number;
}

const normalize = (s: string): string =>
  s.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Rank `items` by how well their name matches `query`:
 * exact (4) > prefix (3) > whole-word (2) > substring (1). Ties break by shortest
 * name — the primary entity (e.g. "Apple Inc." over "Apple Hospitality REIT").
 * Returns only items that match at all, best first. Pure (no I/O).
 */
function rankMatches<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
): RankedMatch<T>[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { item: T; kind: MatchKind; score: number; len: number }[] = [];
  for (const item of items) {
    const name = getName(item);
    const n = normalize(name);
    let kind: MatchKind | null = null;
    let score = 0;
    if (n === q) { kind = 'exact'; score = 4; }
    else if (n.startsWith(q)) { kind = 'prefix'; score = 3; }
    else if (n.includes(` ${q} `) || n.endsWith(` ${q}`)) { kind = 'word'; score = 2; }
    else if (n.includes(q)) { kind = 'substring'; score = 1; }
    if (kind) scored.push({ item, kind, score, len: name.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored.map(({ item, kind, score }) => ({ item, kind, score }));
}

interface SecTickerRow { cik_str: number; ticker: string; title: string }

interface SecEntity {
  ticker: string;
  cik: string;
  cik_padded: string;
  company_name: string;
  matched_by: 'ticker' | 'company_name';
  alternatives?: { ticker: string; company_name: string; cik: string }[];
}

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/**
 * Resolve a ticker OR company name to its SEC identity (CIK + canonical name).
 * Exact ticker first (the common, unambiguous case), then fuzzy company-name
 * fallback so "Apple" / "APPLE" → AAPL's CIK. Throws if nothing matches.
 *
 * `headers` lets callers pass their pack's SEC User-Agent — www.sec.gov requires
 * a UA. `fetchImpl` defaults to global fetch (override in tests).
 */
async function resolveSecEntity(
  query: string,
  opts: { fetchImpl?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<SecEntity> {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Required argument is missing or empty. Pass a ticker like "AAPL" or a company name like "Apple".');
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(SEC_TICKERS_URL, { headers: opts.headers });
  if (!res.ok) throw new Error(`SEC ticker lookup error: ${res.status}`);
  const data = (await res.json()) as Record<string, SecTickerRow>;
  const rows = Object.values(data);

  // 1) Exact ticker match — the common, unambiguous case.
  const q = query.toUpperCase().trim();
  for (const r of rows) {
    if (r.ticker === q) return toEntity(r, 'ticker');
  }

  // 2) Company-name fallback.
  const ranked = rankMatches(query, rows, (r) => r.title);
  if (ranked.length) {
    const best = toEntity(ranked[0].item, 'company_name');
    const alts = ranked.slice(1, 4).map((m) => ({
      ticker: m.item.ticker,
      company_name: m.item.title,
      cik: String(m.item.cik_str),
    }));
    if (alts.length) best.alternatives = alts;
    return best;
  }

  throw new Error(`No SEC company matches "${query}". Pass a US-listed ticker ("AAPL") or the exact listed-company name ("Apple Inc."). If this is a clinical-trial sponsor, an operating subsidiary (e.g. "Merck Sharp & Dohme" → Merck & Co), or a foreign/private entity, call sponsor_to_filer({sponsor}) instead — it resolves subsidiaries to the listed parent and honestly reports when no US-listed filer exists.`);
}

function toEntity(r: SecTickerRow, matched_by: 'ticker' | 'company_name'): SecEntity {
  return {
    ticker: r.ticker,
    cik: String(r.cik_str),
    cik_padded: String(r.cik_str).padStart(10, '0'),
    company_name: r.title,
    matched_by,
  };
}

const GENERIC_CORP_WORDS = new Set([
  'THE', 'A', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED',
  'LLC', 'LP', 'PLC', 'SA', 'AG', 'NV', 'GMBH', 'AB', 'AS', 'OY', 'SPA',
  'GROUP', 'HOLDINGS', 'HOLDING', 'AND', 'OF', 'US', 'USA', 'INTERNATIONAL',
  'GLOBAL',
]);

/**
 * Split a corporate/organization name into its SIGNIFICANT tokens — words
 * that aren't generic corporate boilerplate (Inc, Co, Ltd, Group, ...) or
 * punctuation — sorted LONGEST FIRST. Built for cross-registry name joins
 * where the two registries anchor on different words of the same name: SEC
 * lists Eli Lilly as "ELI LILLY & Co", but Drugs@FDA's sponsor_name field
 * uses "LILLY" — the longer, more distinctive token, not the first one
 * ("ELI" alone is short and matches too loosely). Pure (no I/O); callers
 * typically try tokens in order until one call to their OWN registry
 * returns a result.
 */
function significantNameTokens(name: string): string[] {
  const tokens = name
    .toUpperCase()
    .replace(/[.,&/()-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !GENERIC_CORP_WORDS.has(t));
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}


/**
 * Pick "the most recent annual value" out of SEC companyfacts XBRL data —
 * the one operation every company-facts tool does, and the one that shipped
 * wrong twice (sec + edgar packs, identical code) for the largest filers.
 *
 * Two traps in the raw companyfacts feed, both confirmed live 2026-08-28
 * (fleet #594):
 *
 *   1. `fy` is the fiscal year of the FILING, not of the reported period. A
 *      10-K carries two or three prior years as comparatives, and every one of
 *      them is stamped with the filing's fy. Amazon's FY2020 net income
 *      ($21.3B, period 2020-01-01..2020-12-31) appears with fy=2022 because it
 *      was restated in the FY2022 10-K — and Amazon's actual FY2022 figure is a
 *      $2.7B LOSS. Sorting by fy therefore mislabels the year AND can pick a
 *      comparative over the current period. The period is `start`/`end`; the
 *      year has to be derived from `end`.
 *
 *   2. `frame` is assigned to the LAST-FILED fact for a calendar period, not to
 *      the 10-K that first reported it. Since proxies (DEF 14A) began carrying
 *      XBRL, Amazon's CY2021..CY2025 annual frames all sit on the 2026 proxy,
 *      so a `form === '10-K' && frame` filter sees no 10-K annual fact newer
 *      than CY2020 and confidently returns that.
 *
 * And one presentation trap: a concept the filer has RETIRED (Microsoft's
 * `Revenues` stops at FY2010 — it moved to
 * RevenueFromContractWithCustomerExcludingAssessedTax under ASC 606) is
 * accurate per-concept but wrong the moment it is presented under
 * "most recent" beside concepts that are genuinely current. The fix is
 * labelling and precedence, not deletion: a caller building a long series
 * legitimately wants the retired concept, so it stays — flagged `stale`,
 * sorted last, with the current concept surfaced in `latest_annual`.
 *
 * Kept dependency-free on purpose: publish-pack.sh inlines this file into the
 * standalone npm build of any pack that imports it.
 */

interface XbrlFactEntry {
  start?: string;
  end: string;
  val: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
}

interface XbrlConcept {
  label: string;
  description?: string;
  units: Record<string, XbrlFactEntry[]>;
}

type XbrlConceptMap = Record<string, XbrlConcept>;

interface AnnualValue {
  /** Fiscal year the period ENDS in (derived from period_end — see fiscalYearOf). */
  year: number;
  value: number;
  filed: string;
  /** Present for duration concepts (income statement); absent for instants (balance sheet). */
  period_start?: string;
  period_end: string;
  form: string;
  unit: string;
  concept: string;
}

interface KeyFinancial {
  label: string;
  most_recent_annual: Omit<AnnualValue, 'concept'> | null;
  /**
   * true when this concept's latest annual value ends before the filer's latest
   * annual report period — i.e. the filer stopped reporting it. The number is
   * real history, not the company's current figure.
   */
  stale: boolean;
  stale_note?: string;
}

/** Annual-report forms. 10-KT (transition period) is deliberately excluded. */
const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A']);
/** Preferred unit per concept, in order. Anything else falls back to the first unit present. */
const UNIT_PREFERENCE = ['USD', 'USD/shares', 'shares', 'pure'];
const DAY_MS = 86_400_000;

/**
 * Fiscal year a period belongs to, by the near-universal convention of naming
 * the year the period ENDS in (Apple FY2025 ends 2025-09-27, Walmart FY2026
 * ends 2026-01-31). The one exception handled: 52/53-week years that end in
 * the first days of January belong to the prior year (a year ending
 * 2027-01-02 is fiscal 2026).
 */
function fiscalYearOf(periodEnd: string): number {
  const y = Number(periodEnd.slice(0, 4));
  const m = Number(periodEnd.slice(5, 7));
  const d = Number(periodEnd.slice(8, 10));
  return m === 1 && d <= 7 ? y - 1 : y;
}

function preferredUnit(units: Record<string, XbrlFactEntry[]>): string | null {
  for (const u of UNIT_PREFERENCE) if (units[u]?.length) return u;
  const first = Object.keys(units).find((u) => units[u]?.length);
  return first ?? null;
}

function isAnnualPeriod(e: XbrlFactEntry): boolean {
  if (!e.start) return true; // instant (balance-sheet) fact
  const days = (Date.parse(e.end) - Date.parse(e.start)) / DAY_MS;
  return days >= 340 && days <= 380; // 52/53-week years included, quarters/YTD excluded
}

/**
 * The most recent annual value for one concept: latest period_end among
 * annual-report facts, ties broken by latest filed (a restated figure from a
 * later 10-K wins over the original).
 */
function latestAnnual(concepts: XbrlConceptMap, concept: string): AnnualValue | null {
  const fact = concepts[concept];
  if (!fact?.units) return null;
  const unit = preferredUnit(fact.units);
  if (!unit) return null;
  let best: XbrlFactEntry | null = null;
  for (const e of fact.units[unit]) {
    if (!e.form || !ANNUAL_FORMS.has(e.form) || !e.end || typeof e.val !== 'number') continue;
    if (!isAnnualPeriod(e)) continue;
    if (
      !best ||
      e.end > best.end ||
      (e.end === best.end && (e.filed ?? '') > (best.filed ?? ''))
    ) best = e;
  }
  if (!best) return null;
  return {
    year: fiscalYearOf(best.end),
    value: best.val,
    filed: best.filed ?? '',
    ...(best.start ? { period_start: best.start } : {}),
    period_end: best.end,
    form: best.form ?? '',
    unit,
    concept,
  };
}

/**
 * Among alternative concepts for the same line item (filers migrate tags —
 * Revenues → RevenueFromContractWithCustomerExcludingAssessedTax under ASC
 * 606), the one with the most recent period wins; ties go to list order.
 */
function freshestOf(concepts: XbrlConceptMap, candidates: string[]): AnnualValue | null {
  let best: AnnualValue | null = null;
  for (const c of candidates) {
    const hit = latestAnnual(concepts, c);
    if (hit && (!best || hit.period_end > best.period_end)) best = hit;
  }
  return best;
}

/** Canonical line items → the us-gaap concepts filers use for them, most-current-first. */
const LINE_ITEM_CONCEPTS: Record<string, string[]> = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueGoodsNet',
    'RevenuesNetOfInterestExpense',
  ],
  net_income: ['NetIncomeLoss', 'ProfitLoss'],
  operating_income: ['OperatingIncomeLoss'],
  gross_profit: ['GrossProfit'],
  total_assets: ['Assets'],
  total_liabilities: ['Liabilities'],
  stockholders_equity: [
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  ],
  cash_and_equivalents: [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    'Cash',
  ],
  eps_basic: ['EarningsPerShareBasic'],
  eps_diluted: ['EarningsPerShareDiluted'],
  shares_outstanding: ['CommonStockSharesOutstanding'],
  research_and_development: ['ResearchAndDevelopmentExpense'],
};

interface AnnualFinancialsSummary {
  /** Fiscal year of the filer's most recent annual report, across every concept examined. */
  latest_fiscal_year: number | null;
  latest_period_end: string | null;
  /** One entry per canonical line item, choosing whichever concept the filer currently reports under. */
  latest_annual: Record<string, AnnualValue | null>;
  /** Per-concept detail. Current concepts first, retired (stale) concepts last. */
  key_financials: Record<string, KeyFinancial>;
  /** Concepts the filer has stopped reporting — present in key_financials, flagged, never in latest_annual. */
  stale_concepts: string[];
  year_note: string;
}

/**
 * Build the whole "key financials" view: canonical line items resolved to the
 * concept the filer currently uses, plus per-concept detail with staleness
 * flagged at the point of use and stale concepts sorted last.
 */
function summarizeAnnualFinancials(concepts: XbrlConceptMap): AnnualFinancialsSummary {
  // Every concept any line item could draw from, in a stable order.
  const perConcept: { concept: string; label: string; value: AnnualValue | null }[] = [];
  const seen = new Set<string>();
  for (const candidates of Object.values(LINE_ITEM_CONCEPTS)) {
    for (const c of candidates) {
      if (seen.has(c) || !concepts[c]) continue;
      seen.add(c);
      perConcept.push({ concept: c, label: concepts[c].label, value: latestAnnual(concepts, c) });
    }
  }

  let latestEnd: string | null = null;
  for (const row of perConcept) {
    if (row.value && (!latestEnd || row.value.period_end > latestEnd)) latestEnd = row.value.period_end;
  }
  const latestFy = latestEnd ? fiscalYearOf(latestEnd) : null;

  // A concept whose latest annual period ends more than ~100 days before the
  // filer's latest annual period has been retired by the filer. (Instants and
  // durations in the same 10-K share an end date, so anything beyond a few
  // days is a genuinely older report.)
  const isStale = (v: AnnualValue | null) =>
    !!v && !!latestEnd && (Date.parse(latestEnd) - Date.parse(v.period_end)) / DAY_MS > 100;

  // Canonical line items: the freshest NON-STALE concept per item. A line the
  // filer only ever reported under a since-retired concept (Amazon's
  // GrossProfit stops at FY2009) is null here — the stale value stays in
  // key_financials, flagged, where it cannot be read as current.
  const latest_annual: Record<string, AnnualValue | null> = {};
  for (const [item, candidates] of Object.entries(LINE_ITEM_CONCEPTS)) {
    const v = freshestOf(concepts, candidates);
    latest_annual[item] = v && !isStale(v) ? v : null;
  }

  const itemOf = (concept: string) =>
    Object.entries(LINE_ITEM_CONCEPTS).find(([, cs]) => cs.includes(concept))?.[0];

  const current = perConcept.filter((r) => !isStale(r.value));
  const stale = perConcept.filter((r) => isStale(r.value));
  const key_financials: Record<string, KeyFinancial> = {};
  for (const r of [...current, ...stale]) {
    const entry: KeyFinancial = {
      label: r.label,
      most_recent_annual: r.value ? stripConcept(r.value) : null,
      stale: isStale(r.value),
    };
    if (entry.stale && r.value) {
      const item = itemOf(r.concept);
      const replacement = item ? latest_annual[item] : null;
      const successor =
        replacement && replacement.concept !== r.concept
          ? ` The filer now reports this line under ${replacement.concept} (FY${replacement.year}) — see latest_annual.${item}.`
          : ' No current concept for this line item was found in the filer\'s us-gaap facts.';
      entry.stale_note =
        `STALE: this concept's latest annual value is for FY${r.value.year} (period ending ${r.value.period_end}), ` +
        `but the filer's most recent annual report covers FY${latestFy}. The number is real history, not the company's current figure.` +
        successor;
    }
    key_financials[r.concept] = entry;
  }

  return {
    latest_fiscal_year: latestFy,
    latest_period_end: latestEnd,
    latest_annual,
    key_financials,
    stale_concepts: stale.map((r) => r.concept),
    year_note:
      '`year` is the fiscal year the reporting period ENDS in, derived from period_end. It is NOT the SEC `fy` field, ' +
      'which stamps prior-year comparatives with the year of the filing that restated them.',
  };
}

function stripConcept(v: AnnualValue): Omit<AnnualValue, 'concept'> {
  const { concept: _concept, ...rest } = v;
  return rest;
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


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'SEC');
}

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
      'Get recent SEC filings for a company by CIK number, ticker, or company name. Returns filing dates, form types, and accession numbers. Optionally filter by form type (e.g., "10-K", "10-Q", "8-K").',
    inputSchema: {
      type: 'object',
      properties: {
        cik: {
          type: 'string',
          description: 'Company CIK ("320193"), ticker ("AAPL"), or name ("Apple") — ticker/name are auto-resolved to a CIK',
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
      'Get XBRL financial facts for a company by CIK number, ticker, or company name. Returns latest_annual — revenue, net income, operating income, total assets, liabilities, equity, cash, EPS and shares for the most recent fiscal year (10-K), resolved to whichever XBRL concept the filer currently reports under — plus per-concept detail with the fiscal year and period end on every figure. Concepts the filer has retired (e.g. a pre-ASC-606 Revenues tag) are kept for history but flagged stale and sorted last.',
    inputSchema: {
      type: 'object',
      properties: {
        cik: {
          type: 'string',
          description: 'Company CIK ("320193"), ticker ("AAPL"), or name ("Apple") — ticker/name are auto-resolved to a CIK',
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

// Accept a raw CIK ("320193"), a ticker ("AAPL"), or a company name ("Apple")
// so callers don't have to call search_companies first. Pure-digit input is used
// as-is; anything else resolves through the shared SEC resolver.
async function resolveToCik(cikOrTickerOrName: string): Promise<string> {
  if (typeof cikOrTickerOrName !== 'string' || !cikOrTickerOrName.trim()) {
    throw new Error('Required argument is missing or empty. Pass a CIK ("320193"), a ticker ("AAPL"), or a company name ("Apple").');
  }
  // No letters → it's already a CIK (digits, maybe zero-padded). Otherwise it's a
  // ticker or company name and needs resolving.
  if (!/[a-z]/i.test(cikOrTickerOrName)) return cikOrTickerOrName;
  const entity = await resolveSecEntity(cikOrTickerOrName, { headers: SEC_HEADERS });
  return entity.cik;
}

async function searchCompanies(query: string) {
  const params = new URLSearchParams({ q: query });
  const res = await pwFetch(`${EFTS_BASE}/search-index?${params}`, {
    headers: SEC_HEADERS,
  });
  if (!res.ok) throw await httpError(res, 'SEC EDGAR search error');

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
  const paddedCik = padCik(await resolveToCik(cik));
  const res = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, {
    headers: SEC_HEADERS,
  });
  // Same bare-404 shape as get_company_facts; a 404 here means no filer has
  // this CIK at all (submissions is the index cikNotFound probes).
  if (res.status === 404) throw await cikNotFound(cik, paddedCik);
  if (!res.ok) throw await httpError(res, 'SEC EDGAR submissions error');

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

// data.sec.gov answers a bare 404 both when no filer has the CIK at all and when
// the filer exists but has never submitted XBRL financial data (investment funds,
// trusts, individuals, most pre-2011 foreign private issuers). "SEC EDGAR company
// facts error: 404" told the caller neither — nor that the CIK was the problem
// rather than the pack — and the non-numeric path already writes a good message
// (see resolveSecEntity), so a ticker miss and a CIK miss read as two different
// failures. This spends one extra request on the submissions index so the
// message can say which case it is. `not_found:` is the classifier token: the
// gateway books it as user_error and strips it before the caller sees it.
async function cikNotFound(input: string, paddedCik: string): Promise<Error> {
  const lookup =
    'To look one up, call edgar_ticker_to_cik({ticker}) — or pass the ticker ("AAPL") or listed-company name ("Apple Inc.") here directly and it is resolved for you.';
  const sub = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS }).catch(
    () => null,
  );
  if (sub?.ok) {
    const filer = (await sub.json().catch(() => null)) as { name?: string } | null;
    const name = filer?.name ? `"${filer.name}"` : 'a filer';
    return new Error(
      `not_found: SEC EDGAR knows CIK ${input} as ${name}, but it has no XBRL financial facts — this filer does not submit XBRL financial statements (typical for investment funds, trusts and individuals). get_company_filings({cik: "${input}"}) lists what it does file. If you meant an operating company, look up its CIK first: ${lookup}`,
    );
  }
  return new Error(
    `not_found: SEC EDGAR has no company at CIK ${input}. EDGAR covers companies registered with the US SEC only — foreign listings (e.g. "603986.SS", "NESN") are absent unless the company also files in the US. Check the CIK: ${lookup}`,
  );
}

async function getCompanyFacts(cik: string) {
  const paddedCik = padCik(await resolveToCik(cik));
  const res = await pwFetch(`${DATA_BASE}/api/xbrl/companyfacts/CIK${paddedCik}.json`, {
    headers: SEC_HEADERS,
  });
  if (res.status === 404) throw await cikNotFound(cik, paddedCik);
  if (!res.ok) throw await httpError(res, 'SEC EDGAR company facts error');

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

  // Most-recent annual value per concept, with the filer's CURRENT concept
  // leading and retired concepts flagged stale — see shared/src/xbrl.ts for the
  // three traps this replaces (fy = filing year, frame on the last filer, and
  // Microsoft's FY2010 `Revenues` presented as "most recent"). Fleet #594.
  const usGaap = data.facts?.['us-gaap'] ?? {};
  const summary = summarizeAnnualFinancials(usGaap);

  return {
    cik: String(data.cik),
    company_name: data.entityName,
    latest_fiscal_year: summary.latest_fiscal_year,
    latest_period_end: summary.latest_period_end,
    latest_annual: summary.latest_annual,
    key_financials: summary.key_financials,
    stale_concepts: summary.stale_concepts,
    year_note: summary.year_note,
    available_concepts: Object.keys(usGaap).length,
  };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
