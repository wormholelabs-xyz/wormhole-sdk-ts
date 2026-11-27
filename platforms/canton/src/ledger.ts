// JSON Ledger API v2 client for one participant. The acting or reading party is an argument of
// each call, not state of the client.
import type { DisclosureSource } from "./disclosure.js";
import {
  DAML_DECIMAL_SCALE,
  LEDGER_REQUEST_MAX_ATTEMPTS,
  LEDGER_REQUEST_TIMEOUT_MS,
  LEDGER_RESPONSE_MAX_BYTES,
  LEDGER_SUBMIT_TIMEOUT_MS,
} from "./constants.js";

/** Options of one token request */
export interface TokenRequest {
  /** The ledger rejected the previous token (HTTP 401); a cached token must not be returned */
  forceRefresh: boolean;
}

/**
 * Supplies the bearer token of each request. A plain `() => Promise<string>` is a valid provider;
 * a caching provider should honour `forceRefresh`.
 */
export type TokenProvider = (request?: TokenRequest) => Promise<string>;

/** The fetch function the client uses; defaults to the global fetch */
export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

/** Timeout and size cap of one HTTP request */
export interface HttpBounds {
  timeoutMs: number;
  maxBytes: number;
}

export const DEFAULT_HTTP_BOUNDS: HttpBounds = {
  timeoutMs: LEDGER_REQUEST_TIMEOUT_MS,
  maxBytes: LEDGER_RESPONSE_MAX_BYTES,
};

/** A response read within bounds. `json` is undefined for an empty or non-JSON body. */
export interface BoundedJsonResponse {
  status: number;
  text: string;
  json: unknown;
}

async function readBodyWithCap(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.length;
    if (receivedBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`response body is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(receivedBytes);
  let position = 0;
  for (const chunk of chunks) {
    body.set(chunk, position);
    position += chunk.length;
  }
  return new TextDecoder().decode(body);
}

function urlForMessage(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

/** fetch with a timeout and a body size cap. Redirects are refused. */
export async function fetchJsonBounded(
  url: string,
  init: RequestInit,
  bounds: HttpBounds = DEFAULT_HTTP_BOUNDS,
  fetchFunction: FetchFunction = (input, requestInit) => fetch(input, requestInit),
): Promise<BoundedJsonResponse> {
  if (!(bounds.timeoutMs > 0) || !(bounds.maxBytes > 0))
    throw new Error("HTTP bounds must be positive");
  const timeoutSignal = AbortSignal.timeout(bounds.timeoutMs);
  try {
    const response = await fetchFunction(url, {
      ...init,
      signal: timeoutSignal,
      redirect: "error",
    });
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > bounds.maxBytes) {
      await response.body?.cancel();
      throw new Error(`Content-Length ${declaredLength} is above the ${bounds.maxBytes}-byte cap`);
    }
    const text = await readBodyWithCap(response, bounds.maxBytes);
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, text, json };
  } catch (err) {
    if (timeoutSignal.aborted)
      throw new Error(
        `${init.method ?? "GET"} ${urlForMessage(url)} timed out after ${bounds.timeoutMs} ms`,
      );
    throw err;
  }
}

/** First 200 characters of an error body, for a message */
export function errorBodyExcerpt(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/** A token provider that always returns the same token */
export function staticTokenProvider(token: string): TokenProvider {
  if (token.length === 0) throw new Error("The static token is empty");
  return async () => token;
}

export interface OAuthClientCredentialsOptions {
  tokenUrl: string | URL;
  clientId: string;
  clientSecret: string;
  audience?: string;
  scope?: string;
  /** Seconds a token is used when the response has no `expires_in` (default 300) */
  defaultLifetimeSeconds?: number;
  /** A token is renewed this many milliseconds before it expires (default 30 000) */
  expiryMarginMs?: number;
  fetch?: FetchFunction;
  bounds?: HttpBounds;
  /** Clock in milliseconds; tests inject one */
  now?: () => number;
}

/** OAuth 2.0 client-credentials provider with a cached token */
export function oauthClientCredentialsTokenProvider(
  options: OAuthClientCredentialsOptions,
): TokenProvider {
  const tokenUrl = new URL(options.tokenUrl);
  const now = options.now ?? (() => Date.now());
  const defaultLifetimeSeconds = options.defaultLifetimeSeconds ?? 300;
  const expiryMarginMs = options.expiryMarginMs ?? 30_000;
  let cached: { accessToken: string; expiresAtMs: number } | undefined;

  async function requestToken(): Promise<{ accessToken: string; expiresAtMs: number }> {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: options.clientId,
      client_secret: options.clientSecret,
    });
    if (options.audience !== undefined) form.set("audience", options.audience);
    if (options.scope !== undefined) form.set("scope", options.scope);
    const response = await fetchJsonBounded(
      tokenUrl.href,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
      options.bounds,
      options.fetch,
    );
    const tokenJson = response.json as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (
      response.status !== 200 ||
      typeof tokenJson?.access_token !== "string" ||
      tokenJson.access_token === ""
    )
      throw new Error(
        `OAuth token request to ${tokenUrl.host} failed with HTTP ${response.status}`,
      );
    const lifetimeSeconds =
      typeof tokenJson.expires_in === "number" && tokenJson.expires_in > 0
        ? tokenJson.expires_in
        : defaultLifetimeSeconds;
    return {
      accessToken: tokenJson.access_token,
      expiresAtMs: now() + lifetimeSeconds * 1000 - expiryMarginMs,
    };
  }

  return async (request?: TokenRequest) => {
    if (request?.forceRefresh || !cached || now() >= cached.expiresAtMs)
      cached = await requestToken();
    return cached.accessToken;
  };
}

/** A non-2xx response of the JSON Ledger API */
export class CantonLedgerError extends Error {
  /** The `code` of a JsCantonError body, when the body is one */
  readonly code: string | undefined;

  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
    json: unknown,
  ) {
    super(`${method} ${path} failed with HTTP ${status}: ${errorBodyExcerpt(body)}`);
    this.name = "CantonLedgerError";
    const code = (json as { code?: unknown } | undefined)?.code;
    this.code = typeof code === "string" ? code : undefined;
  }
}

const INACTIVE_CONTRACT_CODES = new Set(["CONTRACT_NOT_FOUND", "LOCAL_VERDICT_INACTIVE_CONTRACTS"]);
const INACTIVE_CONTRACT_PATTERN = /INACTIVE_CONTRACTS|CONTRACT_NOT_FOUND|contract not active/i;

/**
 * True when a submission failed because a contract it references was archived or replaced.
 * A rebuilt transaction with fresh contract ids can succeed.
 */
export function isInactiveContractError(err: unknown): boolean {
  if (err instanceof CantonLedgerError) {
    if (err.code !== undefined && INACTIVE_CONTRACT_CODES.has(err.code)) return true;
    return INACTIVE_CONTRACT_PATTERN.test(err.body);
  }
  return err instanceof Error && INACTIVE_CONTRACT_PATTERN.test(err.message);
}

/** JSON Ledger API value: the JSON encoding of a Daml value (see codec.ts) */
export type LedgerJson = unknown;

/** A created event of the JSON Ledger API (the fields this SDK reads) */
export interface JsCreatedEvent {
  contractId: string;
  templateId: string;
  createArgument?: LedgerJson;
  createdEventBlob?: string;
  signatories?: string[];
  observers?: string[];
  interfaceViews?: JsInterfaceView[];
  [field: string]: unknown;
}

export interface JsInterfaceView {
  interfaceId: string;
  viewValue?: LedgerJson;
  [field: string]: unknown;
}

/** An active contract: its created event and the synchronizer it is assigned to */
export interface ActiveContract {
  createdEvent: JsCreatedEvent;
  synchronizerId: string;
}

/** A transaction of the JSON Ledger API (the fields this SDK reads) */
export interface JsTransaction {
  updateId: string;
  commandId?: string;
  effectiveAt?: string;
  offset?: number;
  synchronizerId?: string;
  recordTime?: string;
  events: unknown[];
  [field: string]: unknown;
}

export interface ConnectedSynchronizer {
  synchronizerAlias: string;
  synchronizerId: string;
  permission?: string;
}

/** Which contracts an active-contracts request returns */
export type ContractFilter =
  | { kind: "wildcard" }
  /** Package-name references ("#name:Module:Entity") */
  | { kind: "templates"; templateIds: string[] }
  /** A package-name reference to an interface */
  | { kind: "interface"; interfaceId: string; includeInterfaceView: boolean };

export interface ActiveContractsOptions {
  includeCreatedEventBlob?: boolean;
  /** Defaults to the current ledger end */
  activeAtOffset?: number;
}

export type TransactionShape = "TRANSACTION_SHAPE_ACS_DELTA" | "TRANSACTION_SHAPE_LEDGER_EFFECTS";

/**
 * Whose view of a transaction to read: a list of parties, or every party the token can read as
 * (`filtersForAnyParty`; the token needs the CanReadAsAnyParty right).
 */
export type TransactionReaders = readonly string[] | { anyParty: true };

/** A wildcard transaction format for the readers, without created event blobs */
export function transactionFormatFor(
  readers: TransactionReaders,
  transactionShape: TransactionShape = "TRANSACTION_SHAPE_LEDGER_EFFECTS",
): Record<string, unknown> {
  const wildcard = {
    cumulative: [
      { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
    ],
  };
  const byParty = Array.isArray(readers);
  return {
    eventFormat: {
      ...(byParty
        ? {
            filtersByParty: Object.fromEntries(
              (readers as readonly string[]).map((party) => [party, wildcard]),
            ),
          }
        : { filtersForAnyParty: wildcard }),
      verbose: true,
    },
    transactionShape,
  };
}

function cumulativeFilter(filter: ContractFilter, includeCreatedEventBlob: boolean): unknown[] {
  switch (filter.kind) {
    case "wildcard":
      return [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob } } } }];
    case "templates":
      if (filter.templateIds.length === 0) throw new Error("A template filter needs a template id");
      return filter.templateIds.map((templateId) => ({
        identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob } } },
      }));
    case "interface":
      return [
        {
          identifierFilter: {
            InterfaceFilter: {
              value: {
                interfaceId: filter.interfaceId,
                includeInterfaceView: filter.includeInterfaceView,
                includeCreatedEventBlob,
              },
            },
          },
        },
      ];
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JsTransaction of a submit or update response, checked for the fields this SDK reads */
export function parseJsTransaction(value: unknown, context: string): JsTransaction {
  if (!isObject(value)) throw new Error(`${context}: no transaction`);
  if (typeof value["updateId"] !== "string" || value["updateId"] === "")
    throw new Error(`${context}: the transaction has no updateId`);
  if (!Array.isArray(value["events"])) throw new Error(`${context}: the transaction has no events`);
  return value as JsTransaction;
}

/** Active contracts of a JSON Ledger API active-contracts response */
export function parseActiveContracts(response: unknown): ActiveContract[] {
  if (!Array.isArray(response)) throw new Error("active-contracts response is not an array");
  const contracts: ActiveContract[] = [];
  for (const entry of response) {
    const contractEntry = isObject(entry) ? entry["contractEntry"] : undefined;
    // JsEmpty and incomplete (un)assignments carry no active contract.
    const active = isObject(contractEntry) ? contractEntry["JsActiveContract"] : undefined;
    if (active === undefined) continue;
    if (!isObject(active) || !isObject(active["createdEvent"]))
      throw new Error("active-contracts entry has no createdEvent");
    const createdEvent = active["createdEvent"];
    if (
      typeof createdEvent["contractId"] !== "string" ||
      typeof createdEvent["templateId"] !== "string"
    )
      throw new Error("active-contracts entry has no contractId or templateId");
    if (typeof active["synchronizerId"] !== "string")
      throw new Error("active-contracts entry has no synchronizerId");
    contracts.push({
      createdEvent: createdEvent as JsCreatedEvent,
      synchronizerId: active["synchronizerId"],
    });
  }
  return contracts;
}

export interface CantonLedgerClientOptions {
  /** Base URL of the participant's JSON Ledger API */
  baseUrl: string | URL;
  /** Bearer token source; no Authorization header is sent without one */
  tokenProvider?: TokenProvider;
  fetch?: FetchFunction;
  /** Bounds of read requests */
  bounds?: HttpBounds;
  /** Timeout of submit-and-wait and execute-and-wait requests */
  submitTimeoutMs?: number;
  /**
   * The disclosure source that protocol clients built on this connection use (core protocol,
   * NTT). CantonPlatform.getRpc sets it from the platform options; without one, a protocol client
   * uses the guardians' core disclosure service of its network.
   */
  disclosureSource?: DisclosureSource;
  /**
   * Token decimals of instruments, keyed by "<admin>/<id>", for instruments whose amounts have
   * fewer than the 10 decimals of a Daml Decimal (an NTT token has the tokenDecimals of its
   * manager). CantonPlatform.getDecimals and getBalance use them; other instruments have 10.
   */
  instrumentDecimals?: Readonly<Record<string, number>>;
}

/** Checks a token decimals value: an integer from 0 to the 10 decimals of a Daml Decimal */
export function checkInstrumentDecimals(decimals: number, what: string): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > DAML_DECIMAL_SCALE)
    throw new Error(
      `${what}: token decimals must be an integer from 0 to ${DAML_DECIMAL_SCALE}, got ${decimals}`,
    );
  return decimals;
}

/** JSON Ledger API v2 client */
export class CantonLedgerClient {
  readonly baseUrl: URL;
  /** See CantonLedgerClientOptions.disclosureSource */
  readonly disclosureSource: DisclosureSource | undefined;
  /** See CantonLedgerClientOptions.instrumentDecimals */
  readonly instrumentDecimals: Readonly<Record<string, number>>;
  private readonly tokenProvider: TokenProvider | undefined;
  private readonly fetchFunction: FetchFunction | undefined;
  private readonly bounds: HttpBounds;
  private readonly submitBounds: HttpBounds;

  constructor(options: CantonLedgerClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
      throw new Error(`The JSON Ledger API URL must be http or https, got ${baseUrl.protocol}`);
    // Keep a path prefix such as https://host/api/json-api: relative paths append to it.
    if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname = `${baseUrl.pathname}/`;
    this.baseUrl = baseUrl;
    this.disclosureSource = options.disclosureSource;
    const instrumentDecimals: Record<string, number> = {};
    for (const [instrument, decimals] of Object.entries(options.instrumentDecimals ?? {}))
      instrumentDecimals[instrument] = checkInstrumentDecimals(decimals, instrument);
    this.instrumentDecimals = Object.freeze(instrumentDecimals);
    this.tokenProvider = options.tokenProvider;
    this.fetchFunction = options.fetch;
    this.bounds = options.bounds ?? DEFAULT_HTTP_BOUNDS;
    this.submitBounds = {
      ...this.bounds,
      timeoutMs: options.submitTimeoutMs ?? LEDGER_SUBMIT_TIMEOUT_MS,
    };
  }

  /** One request; after a 401, one retry with a refreshed token */
  async request(
    method: "GET" | "POST",
    ledgerPath: string,
    body?: unknown,
    bounds: HttpBounds = this.bounds,
  ): Promise<unknown> {
    if (!ledgerPath.startsWith("/v2/"))
      throw new Error(`Not a JSON Ledger API v2 path: ${ledgerPath}`);
    const url = new URL(ledgerPath.slice(1), this.baseUrl).href;
    for (let attempt = 1; attempt <= LEDGER_REQUEST_MAX_ATTEMPTS; attempt++) {
      const headers: Record<string, string> = {};
      if (this.tokenProvider)
        headers["Authorization"] = `Bearer ${await this.tokenProvider({
          forceRefresh: attempt > 1,
        })}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetchJsonBounded(
        url,
        { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
        bounds,
        this.fetchFunction,
      );
      if (response.status === 401 && this.tokenProvider && attempt < LEDGER_REQUEST_MAX_ATTEMPTS)
        continue;
      if (response.status < 200 || response.status > 299)
        throw new CantonLedgerError(
          method,
          ledgerPath,
          response.status,
          response.text,
          response.json,
        );
      return response.json;
    }
    throw new Error(`${method} ${ledgerPath}: no attempt left`);
  }

  /** GET /v2/state/ledger-end: the participant's ledger end offset */
  async ledgerEnd(): Promise<number> {
    const response = await this.request("GET", "/v2/state/ledger-end");
    const offset = isObject(response) ? response["offset"] : undefined;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
      throw new Error("ledger-end response has no valid offset");
    return offset;
  }

  /** GET /v2/state/connected-synchronizers, optionally for one party */
  async connectedSynchronizers(party?: string): Promise<ConnectedSynchronizer[]> {
    const query = party === undefined ? "" : `?party=${encodeURIComponent(party)}`;
    const response = await this.request("GET", `/v2/state/connected-synchronizers${query}`);
    const list = isObject(response) ? response["connectedSynchronizers"] : undefined;
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new Error("connected-synchronizers response is not a list");
    return list.map((entry) => {
      if (!isObject(entry) || typeof entry["synchronizerId"] !== "string")
        throw new Error("connected-synchronizers entry has no synchronizerId");
      return {
        synchronizerId: entry["synchronizerId"],
        synchronizerAlias:
          typeof entry["synchronizerAlias"] === "string" ? entry["synchronizerAlias"] : "",
        ...(typeof entry["permission"] === "string" ? { permission: entry["permission"] } : {}),
      };
    });
  }

  /** POST /v2/state/active-contracts: the contracts of the filter that the party sees */
  async activeContracts(
    party: string,
    filter: ContractFilter,
    options: ActiveContractsOptions = {},
  ): Promise<ActiveContract[]> {
    const activeAtOffset = options.activeAtOffset ?? (await this.ledgerEnd());
    const response = await this.request("POST", "/v2/state/active-contracts", {
      eventFormat: {
        filtersByParty: {
          [party]: {
            cumulative: cumulativeFilter(filter, options.includeCreatedEventBlob ?? false),
          },
        },
        verbose: false,
      },
      activeAtOffset,
    });
    return parseActiveContracts(response);
  }

  /** POST /v2/updates/update-by-id: the transaction, as the readers see it */
  async transactionById(
    updateId: string,
    readers: TransactionReaders,
    transactionShape: TransactionShape = "TRANSACTION_SHAPE_LEDGER_EFFECTS",
  ): Promise<JsTransaction> {
    if (Array.isArray(readers) && readers.length === 0)
      throw new Error("update-by-id needs at least one reading party");
    const response = await this.request("POST", "/v2/updates/update-by-id", {
      updateId,
      updateFormat: { includeTransactions: transactionFormatFor(readers, transactionShape) },
    });
    const update = isObject(response) ? response["update"] : undefined;
    const transaction = isObject(update) ? update["Transaction"] : undefined;
    if (!isObject(transaction)) throw new Error(`update ${updateId} is not a transaction`);
    return parseJsTransaction(transaction["value"], `update ${updateId}`);
  }

  /**
   * POST /v2/commands/submit-and-wait-for-transaction. `commands` is a JsCommands object; the
   * transaction format defaults to ledger effects for the actAs parties.
   */
  async submitAndWaitForTransaction(
    commands: { actAs: readonly string[] } & Record<string, unknown>,
    transactionFormat: Record<string, unknown> = transactionFormatFor(commands.actAs),
  ): Promise<JsTransaction> {
    const response = await this.request(
      "POST",
      "/v2/commands/submit-and-wait-for-transaction",
      { commands, transactionFormat },
      this.submitBounds,
    );
    return parseJsTransaction(
      isObject(response) ? response["transaction"] : undefined,
      "submit-and-wait-for-transaction",
    );
  }

  /** POST /v2/interactive-submission/prepare (external parties; the request is passed as is) */
  async prepareSubmission(request: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/v2/interactive-submission/prepare", request);
  }

  /** POST /v2/interactive-submission/executeAndWaitForTransaction (external parties) */
  async executeAndWaitForTransaction(request: Record<string, unknown>): Promise<JsTransaction> {
    const response = await this.request(
      "POST",
      "/v2/interactive-submission/executeAndWaitForTransaction",
      request,
      this.submitBounds,
    );
    return parseJsTransaction(
      isObject(response) ? response["transaction"] : undefined,
      "executeAndWaitForTransaction",
    );
  }
}
