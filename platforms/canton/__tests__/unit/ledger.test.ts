import type { FetchFunction, TokenRequest } from "../../src/ledger.js";
import {
  CantonLedgerClient,
  CantonLedgerError,
  fetchJsonBounded,
  isInactiveContractError,
  oauthClientCredentialsTokenProvider,
  parseActiveContracts,
  staticTokenProvider,
  transactionFormatFor,
} from "../../src/ledger.js";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; json?: unknown; text?: string } | "hang";

/** A fetch that answers from a queue per path and records every request */
function mockFetch(replies: Record<string, Reply[]>) {
  const requests: RecordedRequest[] = [];
  const fetchFunction: FetchFunction = async (url, init) => {
    const parsed = new URL(url);
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    let body: unknown = bodyText;
    try {
      body = bodyText === undefined ? undefined : JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
    requests.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
    });
    const reply = replies[parsed.pathname]?.shift();
    if (reply === undefined) return new Response("not found", { status: 404 });
    if (reply === "hang")
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
    return new Response(text, { status: reply.status ?? 200 });
  };
  return { fetchFunction, requests };
}

const PARTY = `alice::1220${"ab".repeat(32)}`;
const CONTRACT_ID = `00${"cd".repeat(32)}`;

function tokenCounter() {
  const calls: (TokenRequest | undefined)[] = [];
  const provider = async (request?: TokenRequest) => {
    calls.push(request);
    return `token-${calls.length}`;
  };
  return { provider, calls };
}

describe("fetchJsonBounded", () => {
  it("parses a JSON body and returns non-JSON as text", async () => {
    const ok = await fetchJsonBounded("http://ledger/ok", { method: "GET" }, undefined, async () =>
      Response.json({ answer: 42 }),
    );
    expect(ok).toEqual({ status: 200, text: '{"answer":42}', json: { answer: 42 } });
    const plain = await fetchJsonBounded(
      "http://ledger/x",
      {},
      undefined,
      async () => new Response("plain", { status: 400 }),
    );
    expect(plain.json).toBeUndefined();
    expect(plain.text).toBe("plain");
  });

  it("rejects a body over the cap", async () => {
    const stream = () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024));
          controller.enqueue(new Uint8Array(1024));
          controller.close();
        },
      });
    await expect(
      fetchJsonBounded(
        "http://ledger/big",
        {},
        { timeoutMs: 1000, maxBytes: 2047 },
        async () => new Response(stream()),
      ),
    ).rejects.toThrow(/larger than 2047/);
    await expect(
      fetchJsonBounded(
        "http://ledger/big",
        {},
        { timeoutMs: 1000, maxBytes: 100 },
        async () => new Response("x".repeat(200), { headers: { "content-length": "200" } }),
      ),
    ).rejects.toThrow(/Content-Length 200/);
  });

  it("times out", async () => {
    const { fetchFunction } = mockFetch({ "/hang": ["hang"] });
    const started = Date.now();
    await expect(
      fetchJsonBounded(
        "http://ledger/hang?secret=1",
        { method: "POST" },
        { timeoutMs: 50, maxBytes: 10 },
        fetchFunction,
      ),
    ).rejects.toThrow("POST http://ledger/hang timed out after 50 ms");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("refuses non-positive bounds", async () => {
    await expect(
      fetchJsonBounded("http://ledger/", {}, { timeoutMs: 0, maxBytes: 1 }),
    ).rejects.toThrow(/positive/);
  });
});

describe("token providers", () => {
  it("static", async () => {
    expect(await staticTokenProvider("abc")()).toBe("abc");
    expect(() => staticTokenProvider("")).toThrow(/empty/);
  });

  it("OAuth client credentials: form body, cache, forced refresh, expiry", async () => {
    let issued = 0;
    const { fetchFunction, requests } = mockFetch({
      "/oauth/token": Array.from({ length: 4 }, () => ({
        json: { access_token: `t${++issued}`, expires_in: 60 },
      })),
    });
    let now = 1_000_000;
    const provider = oauthClientCredentialsTokenProvider({
      tokenUrl: "https://auth.example/oauth/token",
      clientId: "client",
      clientSecret: "secret",
      audience: "https://canton.network.global",
      fetch: fetchFunction,
      now: () => now,
    });
    expect(await provider()).toBe("t1");
    expect(await provider()).toBe("t1");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(requests[0]!.body as string);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "client_credentials",
      client_id: "client",
      client_secret: "secret",
      audience: "https://canton.network.global",
    });
    expect(await provider({ forceRefresh: true })).toBe("t2");
    now += 31_000; // 60 s lifetime minus the 30 s margin
    expect(await provider()).toBe("t3");
    expect(requests).toHaveLength(3);
  });

  it("OAuth client credentials: a failed token request throws", async () => {
    const { fetchFunction } = mockFetch({ "/token": [{ status: 401, json: { error: "nope" } }] });
    const provider = oauthClientCredentialsTokenProvider({
      tokenUrl: "https://auth.example/token",
      clientId: "client",
      clientSecret: "secret",
      fetch: fetchFunction,
    });
    await expect(provider()).rejects.toThrow(
      "OAuth token request to auth.example failed with HTTP 401",
    );
  });
});

describe("CantonLedgerClient", () => {
  it("rejects a non-http URL", () => {
    expect(() => new CantonLedgerClient({ baseUrl: "ftp://ledger" })).toThrow(/http or https/);
  });

  it("ledger end: GET with a bearer token, under a base path", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/api/json/v2/state/ledger-end": [{ json: { offset: 7 } }],
    });
    const { provider } = tokenCounter();
    const client = new CantonLedgerClient({
      baseUrl: "https://participant.example/api/json",
      tokenProvider: provider,
      fetch: fetchFunction,
    });
    expect(await client.ledgerEnd()).toBe(7);
    expect(requests[0]).toMatchObject({
      url: "https://participant.example/api/json/v2/state/ledger-end",
      method: "GET",
      headers: { Authorization: "Bearer token-1" },
    });
    expect(requests[0]!.headers["Content-Type"]).toBeUndefined();
  });

  it("ledger end: rejects a response without a valid offset", async () => {
    const { fetchFunction } = mockFetch({ "/v2/state/ledger-end": [{ json: { offset: "7" } }] });
    const client = new CantonLedgerClient({ baseUrl: "http://ledger", fetch: fetchFunction });
    await expect(client.ledgerEnd()).rejects.toThrow(/no valid offset/);
  });

  it("401 then 200: one retry with a forced refresh", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/v2/state/ledger-end": [{ status: 401, text: "expired" }, { json: { offset: 3 } }],
    });
    const { provider, calls } = tokenCounter();
    const client = new CantonLedgerClient({
      baseUrl: "http://ledger",
      tokenProvider: provider,
      fetch: fetchFunction,
    });
    expect(await client.ledgerEnd()).toBe(3);
    expect(requests.map((request) => request.headers["Authorization"])).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
    expect(calls).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
  });

  it("401 twice: two requests, then a CantonLedgerError", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/v2/state/ledger-end": [{ status: 401 }, { status: 401 }, { json: { offset: 1 } }],
    });
    const client = new CantonLedgerClient({
      baseUrl: "http://ledger",
      tokenProvider: tokenCounter().provider,
      fetch: fetchFunction,
    });
    const error = await client.ledgerEnd().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CantonLedgerError);
    expect((error as CantonLedgerError).status).toBe(401);
    expect(requests).toHaveLength(2);
  });

  it("without a token provider: no Authorization header and no retry", async () => {
    const { fetchFunction, requests } = mockFetch({ "/v2/state/ledger-end": [{ status: 401 }] });
    const client = new CantonLedgerClient({ baseUrl: "http://ledger", fetch: fetchFunction });
    await expect(client.ledgerEnd()).rejects.toThrow(/HTTP 401/);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers["Authorization"]).toBeUndefined();
  });

  it("connected synchronizers, for a party", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/v2/state/connected-synchronizers": [
        {
          json: {
            connectedSynchronizers: [
              {
                synchronizerAlias: "global",
                synchronizerId: "global-domain::1220aa",
                permission: "PARTICIPANT_PERMISSION_SUBMISSION",
              },
            ],
          },
        },
        { json: {} },
      ],
    });
    const client = new CantonLedgerClient({ baseUrl: "http://ledger", fetch: fetchFunction });
    expect(await client.connectedSynchronizers(PARTY)).toEqual([
      {
        synchronizerAlias: "global",
        synchronizerId: "global-domain::1220aa",
        permission: "PARTICIPANT_PERMISSION_SUBMISSION",
      },
    ]);
    expect(new URL(requests[0]!.url).searchParams.get("party")).toBe(PARTY);
    expect(await client.connectedSynchronizers()).toEqual([]);
  });

  it("active contracts: template filter with blobs at the ledger end", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/v2/state/ledger-end": [{ json: { offset: 11 } }],
      "/v2/state/active-contracts": [
        {
          json: [
            {
              contractEntry: {
                JsActiveContract: {
                  createdEvent: {
                    contractId: CONTRACT_ID,
                    templateId: `${"ef".repeat(32)}:Wormhole.Core.State:CoreState`,
                    createArgument: { messageFee: "0" },
                    createdEventBlob: "AAAA",
                  },
                  synchronizerId: "global-domain::1220aa",
                  reassignmentCounter: 0,
                },
              },
            },
            { contractEntry: { JsEmpty: {} } },
            { contractEntry: { JsIncompleteAssigned: {} } },
          ],
        },
      ],
    });
    const client = new CantonLedgerClient({ baseUrl: "http://ledger", fetch: fetchFunction });
    const contracts = await client.activeContracts(
      PARTY,
      { kind: "templates", templateIds: ["#wormhole-core:Wormhole.Core.State:CoreState"] },
      { includeCreatedEventBlob: true },
    );
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.synchronizerId).toBe("global-domain::1220aa");
    expect(contracts[0]!.createdEvent.createdEventBlob).toBe("AAAA");
    expect(requests[1]!.headers["Content-Type"]).toBe("application/json");
    expect(requests[1]!.body).toEqual({
      eventFormat: {
        filtersByParty: {
          [PARTY]: {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: {
                    value: {
                      templateId: "#wormhole-core:Wormhole.Core.State:CoreState",
                      includeCreatedEventBlob: true,
                    },
                  },
                },
              },
            ],
          },
        },
        verbose: false,
      },
      activeAtOffset: 11,
    });
  });

  it("active contracts: a given offset, wildcard and interface filters", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/v2/state/active-contracts": [{ json: [] }, { json: [] }],
    });
    const client = new CantonLedgerClient({ baseUrl: "http://ledger", fetch: fetchFunction });
    await client.activeContracts(PARTY, { kind: "wildcard" }, { activeAtOffset: 5 });
    await client.activeContracts(
      PARTY,
      { kind: "interface", interfaceId: "#pkg:Mod:Iface", includeInterfaceView: true },
      { activeAtOffset: 5 },
    );
    expect(requests).toHaveLength(2);
    const filters = requests.map(
      (request) =>
        (request.body as any).eventFormat.filtersByParty[PARTY].cumulative[0].identifierFilter,
    );
    expect(filters[0]).toEqual({ WildcardFilter: { value: { includeCreatedEventBlob: false } } });
    expect(filters[1]).toEqual({
      InterfaceFilter: {
        value: {
          interfaceId: "#pkg:Mod:Iface",
          includeInterfaceView: true,
          includeCreatedEventBlob: false,
        },
      },
    });
  });

  it("parseActiveContracts rejects malformed entries", () => {
    expect(() => parseActiveContracts({})).toThrow(/not an array/);
    expect(() =>
      parseActiveContracts([
        { contractEntry: { JsActiveContract: { createdEvent: { contractId: "x" } } } },
      ]),
    ).toThrow(/contractId or templateId/);
    expect(() =>
      parseActiveContracts([
        {
          contractEntry: {
            JsActiveContract: { createdEvent: { contractId: "x", templateId: "y" } },
          },
        },
      ]),
    ).toThrow(/synchronizerId/);
  });

  it("transaction by id: ledger-effects format and the Transaction update", async () => {
    const transaction = {
      updateId: `1220${"00".repeat(32)}`,
      events: [{ ExercisedEvent: {} }],
      effectiveAt: "2026-11-24T00:00:00Z",
    };
    const { fetchFunction, requests } = mockFetch({
      "/v2/updates/update-by-id": [
        { json: { update: { Transaction: { value: transaction } } } },
        { json: { update: { Reassignment: { value: {} } } } },
      ],
    });
    const client = new CantonLedgerClient({ baseUrl: "http://ledger", fetch: fetchFunction });
    expect(await client.transactionById(transaction.updateId, [PARTY])).toEqual(transaction);
    expect(requests[0]!.body).toEqual({
      updateId: transaction.updateId,
      updateFormat: { includeTransactions: transactionFormatFor([PARTY]) },
    });
    expect((requests[0]!.body as any).updateFormat.includeTransactions.transactionShape).toBe(
      "TRANSACTION_SHAPE_LEDGER_EFFECTS",
    );
    await expect(client.transactionById("x", [PARTY])).rejects.toThrow(/not a transaction/);
    await expect(client.transactionById("x", [])).rejects.toThrow(/reading party/);
  });

  it("transaction by id for any party: filtersForAnyParty instead of filtersByParty", async () => {
    const transaction = { updateId: `1220${"00".repeat(32)}`, events: [] };
    const { fetchFunction, requests } = mockFetch({
      "/v2/updates/update-by-id": [{ json: { update: { Transaction: { value: transaction } } } }],
    });
    const client = new CantonLedgerClient({ baseUrl: "http://ledger", fetch: fetchFunction });
    await client.transactionById(transaction.updateId, { anyParty: true });
    const eventFormat = (requests[0]!.body as any).updateFormat.includeTransactions.eventFormat;
    expect(eventFormat.filtersByParty).toBeUndefined();
    expect(eventFormat.filtersForAnyParty).toEqual({
      cumulative: [
        { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
      ],
    });
    expect(eventFormat.verbose).toBe(true);
  });

  it("submit-and-wait: JsCommands plus a ledger-effects format for actAs", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/v2/commands/submit-and-wait-for-transaction": [
        { json: { transaction: { updateId: "1220ff", events: [] } } },
        { json: { transaction: { events: [] } } },
      ],
    });
    const client = new CantonLedgerClient({ baseUrl: "http://ledger", fetch: fetchFunction });
    const commands = { commands: [], commandId: "c1", actAs: [PARTY] };
    expect((await client.submitAndWaitForTransaction(commands)).updateId).toBe("1220ff");
    expect(requests[0]!.body).toEqual({
      commands,
      transactionFormat: transactionFormatFor([PARTY]),
    });
    await expect(client.submitAndWaitForTransaction(commands)).rejects.toThrow(/no updateId/);
  });

  it("submit-and-wait uses its own timeout", async () => {
    const { fetchFunction } = mockFetch({
      "/v2/commands/submit-and-wait-for-transaction": ["hang"],
      "/v2/state/ledger-end": ["hang"],
    });
    const client = new CantonLedgerClient({
      baseUrl: "http://ledger",
      fetch: fetchFunction,
      bounds: { timeoutMs: 30, maxBytes: 1000 },
      submitTimeoutMs: 60,
    });
    await expect(client.ledgerEnd()).rejects.toThrow(/after 30 ms/);
    await expect(client.submitAndWaitForTransaction({ actAs: [PARTY] })).rejects.toThrow(
      /after 60 ms/,
    );
  });

  it("interactive submission endpoints", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/v2/interactive-submission/prepare": [{ json: { preparedTransactionHash: "AA==" } }],
      "/v2/interactive-submission/executeAndWaitForTransaction": [
        { json: { transaction: { updateId: "1220aa", events: [] } } },
      ],
    });
    const client = new CantonLedgerClient({ baseUrl: "http://ledger", fetch: fetchFunction });
    expect(await client.prepareSubmission({ commandId: "c" })).toEqual({
      preparedTransactionHash: "AA==",
    });
    expect((await client.executeAndWaitForTransaction({ submissionId: "s" })).updateId).toBe(
      "1220aa",
    );
    expect(requests.map((request) => request.body)).toEqual([
      { commandId: "c" },
      { submissionId: "s" },
    ]);
  });

  it("an error body becomes a CantonLedgerError with its code", async () => {
    const { fetchFunction } = mockFetch({
      "/v2/commands/submit-and-wait-for-transaction": [
        {
          status: 404,
          json: {
            code: "CONTRACT_NOT_FOUND",
            cause: "Contract could not be found with id 00ab",
            context: {},
            errorCategory: 11,
          },
        },
      ],
    });
    const client = new CantonLedgerClient({ baseUrl: "http://ledger", fetch: fetchFunction });
    const error = await client
      .submitAndWaitForTransaction({ actAs: [PARTY] })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CantonLedgerError);
    expect((error as CantonLedgerError).code).toBe("CONTRACT_NOT_FOUND");
    expect(isInactiveContractError(error)).toBe(true);
  });
});

describe("isInactiveContractError", () => {
  it.each([
    [
      new CantonLedgerError("POST", "/p", 409, "", { code: "LOCAL_VERDICT_INACTIVE_CONTRACTS" }),
      true,
    ],
    [
      new CantonLedgerError(
        "POST",
        "/p",
        400,
        "LOCAL_VERDICT_INACTIVE_CONTRACTS(2,0): ...",
        undefined,
      ),
      true,
    ],
    [new CantonLedgerError("POST", "/p", 400, "", { code: "DAML_AUTHORIZATION_ERROR" }), false],
    [new Error("contract not active"), true],
    [new Error("timeout"), false],
    ["CONTRACT_NOT_FOUND", false],
  ])("%#", (error, expected) => {
    expect(isInactiveContractError(error)).toBe(expected);
  });
});
