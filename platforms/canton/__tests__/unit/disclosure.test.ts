import type { DisclosedContract } from "../../src/disclosure.js";
import {
  AcsDisclosureSource,
  DisclosureServiceError,
  GuardianDisclosureSource,
  StaticDisclosureSource,
  disclosedContractFromActive,
} from "../../src/disclosure.js";
import { activeContractEntry, mockFetch, mockLedger } from "../mocks/ledger.js";

const GG = `guardianGovernance::1220${"aa".repeat(32)}`;
const ROGUE = `rogue::1220${"cc".repeat(32)}`;
const READER = `reader::1220${"dd".repeat(32)}`;
const PACKAGE_ID = "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371";
const cid = (n: number) => `00${n.toString(16).padStart(64, "0")}`;

function coreEvent(
  entity: string,
  contractNumber: number,
  guardianGovernance: string,
  blob = `blob-${contractNumber}`,
) {
  return {
    contractId: cid(contractNumber),
    templateId: `${PACKAGE_ID}:Wormhole.Core.State:${entity}`,
    createArgument: { guardianGovernance, nextId: "3" },
    createdEventBlob: blob,
    signatories: [guardianGovernance],
  };
}

describe("AcsDisclosureSource", () => {
  it("reads CoreState and EmitterRegistry of guardianGovernance with blobs", async () => {
    const { ledger, requests } = mockLedger({
      "/v2/state/ledger-end": [{ json: { offset: 40 } }],
      "/v2/state/active-contracts": [
        {
          json: [
            activeContractEntry(coreEvent("CoreState", 1, ROGUE)),
            activeContractEntry(coreEvent("CoreState", 2, GG)),
            activeContractEntry(coreEvent("EmitterRegistry", 3, GG)),
            activeContractEntry(coreEvent("Emitter", 4, GG)),
          ],
        },
      ],
    });
    const source = new AcsDisclosureSource({ ledger, reader: READER, guardianGovernance: GG });
    const disclosed = await source.core();
    expect(disclosed).toEqual([
      {
        role: "CoreState",
        templateId: `${PACKAGE_ID}:Wormhole.Core.State:CoreState`,
        contractId: cid(2),
        createdEventBlob: "blob-2",
        synchronizerId: "global-domain::1220aa",
        payload: { guardianGovernance: GG, nextId: "3" },
      },
      {
        role: "EmitterRegistry",
        templateId: `${PACKAGE_ID}:Wormhole.Core.State:EmitterRegistry`,
        contractId: cid(3),
        createdEventBlob: "blob-3",
        synchronizerId: "global-domain::1220aa",
        payload: { guardianGovernance: GG, nextId: "3" },
      },
    ]);
    const filters = (requests[1]!.body as any).eventFormat.filtersByParty[READER].cumulative;
    expect(filters.map((filter: any) => filter.identifierFilter.TemplateFilter.value)).toEqual([
      { templateId: "#wormhole-core:Wormhole.Core.State:CoreState", includeCreatedEventBlob: true },
      {
        templateId: "#wormhole-core:Wormhole.Core.State:EmitterRegistry",
        includeCreatedEventBlob: true,
      },
    ]);
    expect((requests[1]!.body as any).activeAtOffset).toBe(40);
  });

  it("fails without exactly one contract per role", async () => {
    const { ledger } = mockLedger({
      "/v2/state/ledger-end": [{ json: { offset: 1 } }, { json: { offset: 1 } }],
      "/v2/state/active-contracts": [
        { json: [activeContractEntry(coreEvent("EmitterRegistry", 3, GG))] },
        {
          json: [
            activeContractEntry(coreEvent("CoreState", 1, GG)),
            activeContractEntry(coreEvent("CoreState", 2, GG)),
            activeContractEntry(coreEvent("EmitterRegistry", 3, GG)),
          ],
        },
      ],
    });
    const source = new AcsDisclosureSource({ ledger, reader: READER, guardianGovernance: GG });
    await expect(source.core()).rejects.toThrow(/expected one active CoreState .* found 0/);
    await expect(source.core()).rejects.toThrow(/expected one active CoreState .* found 2/);
  });

  it("fails on a contract read without a blob", () => {
    expect(() =>
      disclosedContractFromActive(
        { createdEvent: coreEvent("CoreState", 1, GG, ""), synchronizerId: "s" },
        "CoreState",
      ),
    ).toThrow(/no created event blob/);
  });
});

describe("StaticDisclosureSource", () => {
  const contract = (role: string, n: number): DisclosedContract => ({
    role,
    templateId: `${PACKAGE_ID}:Wormhole.Core.Replay:${role}`,
    contractId: cid(n),
    createdEventBlob: `blob-${n}`,
    synchronizerId: "global-domain::1220aa",
  });

  const source = new StaticDisclosureSource({
    core: [contract("CoreState", 1), contract("EmitterRegistry", 2)],
    replayNodes: [
      {
        consumer: READER,
        namespace: "ntt",
        digest: "ab".repeat(32),
        contract: contract("ReplayNode", 3),
      },
    ],
    claimedRootsNodes: [
      { consumer: READER, namespace: "ntt", contract: contract("ClaimedRootsNode", 4) },
    ],
  });

  it("returns the supplied core contracts", async () => {
    expect((await source.core()).map((entry) => entry.role)).toEqual([
      "CoreState",
      "EmitterRegistry",
    ]);
  });

  it("looks up replay and claimed-roots nodes", async () => {
    expect((await source.replayNode(READER, "ntt", "ab".repeat(32))).contractId).toBe(cid(3));
    expect((await source.claimedRootsNode(READER, "ntt")).contractId).toBe(cid(4));
    await expect(source.replayNode(READER, "ntt", "cd".repeat(32))).rejects.toThrow(
      /no replay node/,
    );
    await expect(source.claimedRootsNode(GG, "ntt")).rejects.toThrow(/no claimed-roots node/);
    await expect(
      new StaticDisclosureSource({ core: [] }).replayNode(READER, "ntt", "x"),
    ).rejects.toThrow();
  });
});

describe("GuardianDisclosureSource", () => {
  const SYNC = "global-domain::1220aa";
  const BLOB = "Y3M=";
  const entry = (moduleAndEntity: string, n: number) => ({
    templateId: `${PACKAGE_ID}:${moduleAndEntity}`,
    contractId: cid(n),
    createdEventBlob: BLOB,
    synchronizerId: SYNC,
    activeAtOffset: 40,
  });

  it("reads CoreState and EmitterRegistry from their routes", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/v1/core-state": [{ json: entry("Wormhole.Core.State:CoreState", 1) }],
      "/v1/emitter-registry": [{ json: entry("Wormhole.Core.State:EmitterRegistry", 2) }],
    });
    const source = new GuardianDisclosureSource({
      baseUrl: "https://disclosure.test/",
      fetch: fetchFunction,
    });
    expect(await source.core()).toEqual([
      {
        role: "CoreState",
        templateId: `${PACKAGE_ID}:Wormhole.Core.State:CoreState`,
        contractId: cid(1),
        createdEventBlob: BLOB,
        synchronizerId: SYNC,
      },
      {
        role: "EmitterRegistry",
        templateId: `${PACKAGE_ID}:Wormhole.Core.State:EmitterRegistry`,
        contractId: cid(2),
        createdEventBlob: BLOB,
        synchronizerId: SYNC,
      },
    ]);
    expect(requests.map((request) => `${request.method} ${request.url}`).sort()).toEqual([
      "GET https://disclosure.test/v1/core-state",
      "GET https://disclosure.test/v1/emitter-registry",
    ]);
  });

  it("keeps a path prefix of the base URL", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/canton/v1/replay-root-registry": [
        { json: entry("Wormhole.Core.State:ReplayRootRegistry", 3) },
      ],
    });
    const source = new GuardianDisclosureSource({
      baseUrl: "https://edge.test/canton",
      fetch: fetchFunction,
    });
    expect((await source.replayRootRegistry()).role).toBe("ReplayRootRegistry");
    expect(requests[0]!.url).toBe("https://edge.test/canton/v1/replay-root-registry");
  });

  it("asks for the covering replay node and the claimed-roots node with encoded parameters", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/v1/replay-node": [{ json: entry("Wormhole.Core.Replay:ReplayNode", 4) }],
      "/v1/claimed-roots-node": [{ json: entry("Wormhole.Core.Replay:ReplayNode", 5) }],
    });
    const source = new GuardianDisclosureSource({
      baseUrl: "https://disclosure.test",
      fetch: fetchFunction,
    });
    const digest = "ab".repeat(32);
    const node = await source.replayNode(READER, "ntt:a b&c", digest);
    expect(node.role).toBe("covering ReplayNode");
    expect(node.contractId).toBe(cid(4));
    const replayUrl = new URL(requests[0]!.url);
    expect(replayUrl.pathname).toBe("/v1/replay-node");
    expect([...replayUrl.searchParams.entries()]).toEqual([
      ["consumer", READER],
      ["namespace", "ntt:a b&c"],
      ["digest", digest],
    ]);
    const claimed = await source.claimedRootsNode(READER, "ntt");
    expect(claimed.role).toBe("covering claimed-roots ReplayNode");
    expect([...new URL(requests[1]!.url).searchParams.keys()]).toEqual(["consumer", "namespace"]);
  });

  it("refuses a digest that is not 64 lowercase hex characters before any request", async () => {
    const { fetchFunction, requests } = mockFetch({});
    const source = new GuardianDisclosureSource({
      baseUrl: "https://disclosure.test",
      fetch: fetchFunction,
    });
    await expect(source.replayNode(READER, "ntt", "AB".repeat(32))).rejects.toThrow(/64 lowercase/);
    expect(requests).toHaveLength(0);
  });

  it("reports the public message and request id of an error answer", async () => {
    const { fetchFunction } = mockFetch({
      "/v1/replay-node": [
        { status: 404, json: { error: "no live replay node covers the digest", requestId: "r1" } },
        { status: 503, json: { error: "index not ready, retry", requestId: "r2" } },
      ],
    });
    const source = new GuardianDisclosureSource({
      baseUrl: "https://disclosure.test",
      fetch: fetchFunction,
    });
    const notFound = await source.replayNode(READER, "ntt", "ab".repeat(32)).catch((err) => err);
    expect(notFound).toBeInstanceOf(DisclosureServiceError);
    expect(notFound.status).toBe(404);
    expect(notFound.retryable).toBe(false);
    expect(notFound.message).toMatch(/no live replay node covers the digest \(request r1\)/);
    const notReady = await source.replayNode(READER, "ntt", "ab".repeat(32)).catch((err) => err);
    expect(notReady.status).toBe(503);
    expect(notReady.retryable).toBe(true);
  });

  it("refuses an entry of another template, a malformed entry and a blob that is not base64", async () => {
    const { fetchFunction } = mockFetch({
      "/v1/core-state": [
        { json: entry("Wormhole.Core.State:EmitterRegistry", 1) },
        { json: { ...entry("Wormhole.Core.State:CoreState", 1), synchronizerId: "" } },
        { json: { ...entry("Wormhole.Core.State:CoreState", 1), createdEventBlob: "not base64!" } },
        { json: { ...entry("Wormhole.Core.State:CoreState", 1), contractId: "xyz" } },
      ],
      "/v1/emitter-registry": Array.from({ length: 4 }, () => ({
        json: entry("Wormhole.Core.State:EmitterRegistry", 2),
      })),
    });
    const source = new GuardianDisclosureSource({
      baseUrl: "https://disclosure.test",
      fetch: fetchFunction,
    });
    await expect(source.core()).rejects.toThrow(/expected Wormhole.Core.State:CoreState/);
    await expect(source.core()).rejects.toThrow(/malformed entry/);
    await expect(source.core()).rejects.toThrow(/not base64/);
    await expect(source.core()).rejects.toThrow();
  });

  it("refuses a base URL with a query or another scheme", () => {
    expect(() => new GuardianDisclosureSource({ baseUrl: "https://d.test/?x=1" })).toThrow(/query/);
    expect(() => new GuardianDisclosureSource({ baseUrl: "ftp://d.test" })).toThrow(
      /http or https/,
    );
  });
});
