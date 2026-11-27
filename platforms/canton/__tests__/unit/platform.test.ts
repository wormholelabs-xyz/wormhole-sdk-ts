import { Wormhole, networkPlatformConfigs } from "@wormhole-foundation/sdk-connect";
import { CantonAddress } from "../../src/address.js";
import { CantonChain } from "../../src/chain.js";
import { CORE_PACKAGE_ID_0_12_3, pinnedCorePackageIds } from "../../src/constants.js";
import { GuardianDisclosureSource, StaticDisclosureSource } from "../../src/disclosure.js";
import { CantonLedgerClient } from "../../src/ledger.js";
import { CantonPlatform } from "../../src/platform.js";
import { activeContractEntry, mockFetch, mockLedger } from "../mocks/ledger.js";

const OWNER = `alice::1220${"ab".repeat(32)}`;
const ADMIN = `token-admin::1220${"ef".repeat(32)}`;
const cid = (n: number) => `00${n.toString(16).padStart(64, "0")}`;

function configWith(rpc: string, httpHeaders?: Record<string, string>) {
  const base = networkPlatformConfigs("Devnet", "Canton");
  return { Canton: { ...base.Canton!, rpc, ...(httpHeaders ? { httpHeaders } : {}) } };
}

describe("CantonPlatform", () => {
  it("supports the Canton chain only", () => {
    expect(CantonPlatform.isSupportedChain("Canton")).toBe(true);
    expect(CantonPlatform.isSupportedChain("Ethereum")).toBe(false);
  });

  it("has the constants of the base patch", () => {
    const config = networkPlatformConfigs("Mainnet", "Canton").Canton!;
    expect(config.chainId).toBe(75);
    expect(config.nativeTokenDecimals).toBe(10);
    expect(config.rpc).toBe("");
  });

  it("has no default rpc", () => {
    const platform = new CantonPlatform("Mainnet");
    expect(() => platform.getRpc("Canton")).toThrow(/no default/);
  });

  it("builds a ledger client from the rpc and a bearer header", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/v2/state/ledger-end": [{ json: { offset: 12 } }],
    });
    const platform = new CantonPlatform(
      "Devnet",
      configWith("http://participant.test", { Authorization: "Bearer abc" }),
      { fetch: fetchFunction },
    );
    const rpc = platform.getRpc("Canton");
    expect(rpc).toBeInstanceOf(CantonLedgerClient);
    expect(await CantonPlatform.getLatestBlock(rpc)).toBe(12);
    expect(requests[0]!.headers["Authorization"]).toBe("Bearer abc");
  });

  it("prefers the configured token provider", async () => {
    const { fetchFunction, requests } = mockFetch({
      "/v2/state/ledger-end": [{ json: { offset: 1 } }],
    });
    const platform = new CantonPlatform(
      "Devnet",
      configWith("http://participant.test", { Authorization: "Bearer abc" }),
      { fetch: fetchFunction, tokenProvider: async () => "oauth" },
    );
    await CantonPlatform.getLatestFinalizedBlock(platform.getRpc("Canton"));
    expect(requests[0]!.headers["Authorization"]).toBe("Bearer oauth");
  });

  it("gives chains and the disclosure source", () => {
    const source = new StaticDisclosureSource({ core: [] });
    const platform = new CantonPlatform("Devnet", configWith("http://participant.test"), {
      disclosureSource: source,
    });
    expect(platform.getChain("Canton")).toBeInstanceOf(CantonChain);
    expect(platform.disclosureSource()).toBe(source);
    expect(() => new CantonPlatform("Devnet", configWith("http://p")).disclosureSource()).toThrow(
      /No Canton disclosure source is configured and Devnet has no core disclosure service URL/,
    );
    const withUrl = new CantonPlatform("Devnet", configWith("http://p"), {
      coreDisclosureServiceUrl: "https://disclosure.test",
    });
    expect(withUrl.disclosureSource()).toBeInstanceOf(GuardianDisclosureSource);
    expect(withUrl.disclosureSource()).toBe(withUrl.disclosureSource());
  });

  it("hands a configured disclosure source to protocol clients through the connection", () => {
    const source = new StaticDisclosureSource({ core: [] });
    const configured = new CantonPlatform("Devnet", configWith("http://participant.test"), {
      disclosureSource: source,
    });
    expect(configured.getRpc("Canton").disclosureSource).toBe(source);
    const withUrl = new CantonPlatform("Devnet", configWith("http://p"), {
      coreDisclosureServiceUrl: "https://disclosure.test",
    });
    expect(withUrl.getRpc("Canton").disclosureSource).toBe(withUrl.disclosureSource());
    // Without a configured source the connection has none: the client picks the network's.
    expect(
      new CantonPlatform("Devnet", configWith("http://p")).getRpc("Canton").disclosureSource,
    ).toBe(undefined);
  });

  it("registers with Wormhole", () => {
    const wh = new Wormhole("Devnet", [CantonPlatform], {
      chains: { Canton: { rpc: "http://participant.test" } },
    });
    expect(wh.getChain("Canton").config.rpc).toBe("http://participant.test");
    expect(wh.getPlatform("Canton").utils()._platform).toBe("Canton");
  });

  it("reads the unlocked balance of an instrument in 10^-10 units", async () => {
    const view = (amount: string, lock: unknown = null) => ({
      owner: OWNER,
      instrumentId: { admin: ADMIN, id: "USD" },
      amount,
      lock,
    });
    const event = (n: number, viewValue: unknown) => ({
      contractId: cid(n),
      templateId: `${"34".repeat(32)}:Token.Coin:Coin`,
      interfaceViews: [
        { interfaceId: `${"12".repeat(32)}:Splice.Api.Token.HoldingV1:Holding`, viewValue },
      ],
    });
    const { ledger } = mockLedger({
      "/v2/state/ledger-end": [{ json: { offset: 3 } }],
      "/v2/state/active-contracts": [
        {
          json: [
            activeContractEntry(event(1, view("1.5"))),
            activeContractEntry(event(2, view("0.25"))),
            activeContractEntry(event(3, view("100.0", { holders: [ADMIN] }))),
          ],
        },
      ],
    });
    const balance = await CantonPlatform.getBalance(
      "Devnet",
      "Canton",
      ledger,
      OWNER,
      new CantonAddress(`${ADMIN}/USD`),
    );
    expect(balance).toBe(17_500_000_000n);
    expect(
      await CantonPlatform.getDecimals(
        "Devnet",
        "Canton",
        ledger,
        new CantonAddress(`${ADMIN}/USD`),
      ),
    ).toBe(10);
    expect(await CantonPlatform.getDecimals("Devnet", "Canton", ledger, "native")).toBe(10);
  });

  it("uses the configured decimals of an instrument, rounding the balance down", async () => {
    const view = (amount: string) => ({
      owner: OWNER,
      instrumentId: { admin: ADMIN, id: "NTT" },
      amount,
      lock: null,
    });
    const { fetchFunction } = mockFetch({
      "/v2/state/ledger-end": [{ json: { offset: 3 } }],
      "/v2/state/active-contracts": [
        {
          json: [
            activeContractEntry({
              contractId: cid(1),
              templateId: `${"34".repeat(32)}:Token.Coin:Coin`,
              interfaceViews: [
                {
                  interfaceId: `${"12".repeat(32)}:Splice.Api.Token.HoldingV1:Holding`,
                  viewValue: view("1.123456789"),
                },
              ],
            }),
          ],
        },
      ],
    });
    const platform = new CantonPlatform("Devnet", configWith("http://participant.test"), {
      instrumentDecimals: { [`${ADMIN}/NTT`]: 8 },
      fetch: fetchFunction,
    });
    const ledger = platform.getRpc("Canton");
    const token = new CantonAddress(`${ADMIN}/NTT`);
    expect(await CantonPlatform.getDecimals("Devnet", "Canton", ledger, token)).toBe(8);
    expect(
      await CantonPlatform.getDecimals("Devnet", "Canton", ledger, new CantonAddress(`${ADMIN}/X`)),
    ).toBe(10);
    expect(await CantonPlatform.getBalance("Devnet", "Canton", ledger, OWNER, token)).toBe(
      112_345_678n,
    );
    expect(
      () =>
        new CantonLedgerClient({
          baseUrl: "http://participant.test",
          instrumentDecimals: { [`${ADMIN}/NTT`]: 11 },
        }),
    ).toThrow(/integer from 0 to 10/);
  });

  it("getBalance and getDecimals check the address kinds", async () => {
    const { ledger } = mockLedger({});
    await expect(
      CantonPlatform.getBalance("Devnet", "Canton", ledger, OWNER, new CantonAddress(OWNER)),
    ).rejects.toThrow(/not an instrument/);
    await expect(
      CantonPlatform.getBalance(
        "Devnet",
        "Canton",
        ledger,
        `${ADMIN}/USD`,
        new CantonAddress(`${ADMIN}/USD`),
      ),
    ).rejects.toThrow(/not a party/);
    await expect(
      CantonPlatform.getBalance("Devnet", "Canton", ledger, OWNER, "native"),
    ).rejects.toThrow(/M5/);
    await expect(
      CantonPlatform.getDecimals("Devnet", "Canton", ledger, new CantonAddress("ab".repeat(32))),
    ).rejects.toThrow(/not an instrument/);
  });

  it("maps synchronizer ids through the native chain ids", async () => {
    expect(() => CantonPlatform.chainFromChainId("global-domain::1220aa::34-0")).toThrow(
      "Unknown Canton synchronizer id global-domain::1220aa",
    );
    const { ledger } = mockLedger({
      "/v2/state/connected-synchronizers": [
        {
          json: {
            connectedSynchronizers: [
              { synchronizerAlias: "global", synchronizerId: "global-domain::1220aa" },
            ],
          },
        },
      ],
    });
    await expect(CantonPlatform.chainFromRpc(ledger)).rejects.toThrow(
      /connected to global-domain::1220aa; expected exactly one known Canton synchronizer, found 0/,
    );
  });

  it("throws a clear error for methods of later milestones", async () => {
    const { ledger } = mockLedger({});
    expect(() => CantonPlatform.nativeTokenId("Devnet", "Canton")).toThrow(
      /not implemented yet \(milestone M5/,
    );
    expect(() =>
      CantonPlatform.isNativeTokenId("Devnet", "Canton", Wormhole.tokenId("Canton", "native")),
    ).toThrow(/M5/);
    await expect(CantonPlatform.sendWait("Canton", ledger, [])).rejects.toThrow(/milestone M4/);
  });
});

describe("pinned core package ids", () => {
  it("knows Devnet (LocalNet) only, and takes an override", () => {
    expect(pinnedCorePackageIds("Devnet")).toEqual([CORE_PACKAGE_ID_0_12_3]);
    expect(() => pinnedCorePackageIds("Mainnet")).toThrow(/No wormhole-core package id/);
    expect(
      pinnedCorePackageIds("Mainnet", { current: "aa".repeat(32), retiring: "bb".repeat(32) }),
    ).toEqual(["aa".repeat(32), "bb".repeat(32)]);
  });
});
