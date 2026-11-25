import type { CantonHolding } from "../../src/holdings.js";
import {
  holdingAmountRaw,
  parseHoldings,
  readHoldings,
  selectInputHoldings,
  unlockedBalance,
} from "../../src/holdings.js";
import { activeContractEntry, mockLedger } from "../mocks/ledger.js";

const OWNER = `alice::1220${"ab".repeat(32)}`;
const OTHER = `bob::1220${"cd".repeat(32)}`;
const ADMIN = `token-admin::1220${"ef".repeat(32)}`;
const OTHER_ADMIN = `other-admin::1220${"ef".repeat(32)}`;
const INSTRUMENT = { admin: ADMIN, id: "USD" };
const cid = (n: number) => `00${n.toString(16).padStart(64, "0")}`;
const HOLDING_INTERFACE = `${"12".repeat(32)}:Splice.Api.Token.HoldingV1:Holding`;

function holdingEvent(n: number, view: Record<string, unknown>, interfaceId = HOLDING_INTERFACE) {
  return {
    contractId: cid(n),
    templateId: `${"34".repeat(32)}:Token.Coin:Coin`,
    interfaceViews: [{ interfaceId, viewStatus: { code: 0 }, viewValue: view }],
  };
}

const view = (amount: string, extra: Record<string, unknown> = {}) => ({
  owner: OWNER,
  instrumentId: INSTRUMENT,
  amount,
  lock: null,
  meta: { values: {} },
  ...extra,
});

describe("parseHoldings", () => {
  it("reads the Holding views the owner owns", () => {
    const holdings = parseHoldings(
      [
        activeContractEntry(holdingEvent(1, view("5.0"))),
        activeContractEntry(holdingEvent(2, view("1.5", { lock: { holders: [ADMIN] } }))),
        activeContractEntry(holdingEvent(3, view("9.0", { owner: OTHER }))),
        activeContractEntry(holdingEvent(4, view("9.0"), `${"12".repeat(32)}:Other.Iface:Holding`)),
        activeContractEntry(holdingEvent(5, view("9.0", { amount: 9 }))),
        { contractEntry: { JsEmpty: {} } },
      ],
      OWNER,
    );
    expect(holdings).toEqual([
      { contractId: cid(1), owner: OWNER, instrumentId: INSTRUMENT, amount: "5.0", locked: false },
      { contractId: cid(2), owner: OWNER, instrumentId: INSTRUMENT, amount: "1.5", locked: true },
    ]);
  });

  it("refuses too many holdings and a malformed response", () => {
    expect(() => parseHoldings(new Array(1001).fill({}), OWNER)).toThrow(/more than 1000 holdings/);
    expect(() => parseHoldings({}, OWNER)).toThrow(/not an array/);
    expect(() =>
      parseHoldings(
        [
          activeContractEntry(
            holdingEvent(1, view("1", { instrumentId: { admin: "x", id: "USD" } })),
          ),
        ],
        OWNER,
      ),
    ).toThrow(/party id/);
  });
});

describe("readHoldings", () => {
  it("queries the Holding interface with its view at the ledger end", async () => {
    const { ledger, requests } = mockLedger({
      "/v2/state/ledger-end": [{ json: { offset: 9 } }],
      "/v2/state/active-contracts": [
        { json: [activeContractEntry(holdingEvent(1, view("2.25")))] },
      ],
    });
    expect(await readHoldings(ledger, OWNER)).toHaveLength(1);
    expect(requests[1]!.body).toEqual({
      eventFormat: {
        filtersByParty: {
          [OWNER]: {
            cumulative: [
              {
                identifierFilter: {
                  InterfaceFilter: {
                    value: {
                      interfaceId:
                        "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
                      includeInterfaceView: true,
                      includeCreatedEventBlob: false,
                    },
                  },
                },
              },
            ],
          },
        },
        verbose: false,
      },
      activeAtOffset: 9,
    });
  });
});

describe("amounts and selection", () => {
  it("holdingAmountRaw", () => {
    expect(holdingAmountRaw("5", 2)).toBe(500n);
    expect(holdingAmountRaw("5.25", 2)).toBe(525n);
    expect(holdingAmountRaw("5.2500000000", 2)).toBe(525n);
    expect(holdingAmountRaw("0.0000000001")).toBe(1n);
    expect(() => holdingAmountRaw("5.251", 2)).toThrow(/exceeds 2 decimals/);
    expect(() => holdingAmountRaw("-1", 2)).toThrow(/non-negative/);
    expect(() => holdingAmountRaw("1", -1)).toThrow(/decimals/);
  });

  const holding = (
    n: number,
    amount: string,
    extra: Partial<CantonHolding> = {},
  ): CantonHolding => ({
    contractId: cid(n),
    owner: OWNER,
    instrumentId: INSTRUMENT,
    amount,
    locked: false,
    ...extra,
  });

  const holdings = [
    holding(3, "4.0"),
    holding(1, "1.0"),
    holding(2, "50.0", { locked: true }),
    holding(4, "50.0", { instrumentId: { admin: OTHER_ADMIN, id: "USD" } }),
    holding(5, "2.0"),
  ];

  it("selects unlocked holdings of the instrument in contract id order", () => {
    expect(selectInputHoldings(holdings, INSTRUMENT, 400n, 2)).toEqual([cid(1), cid(3)]);
    expect(selectInputHoldings(holdings, INSTRUMENT, 100n, 2)).toEqual([cid(1)]);
    expect(() => selectInputHoldings(holdings, INSTRUMENT, 800n, 2)).toThrow(/cover 700 raw/);
    expect(() => selectInputHoldings(holdings, INSTRUMENT, 600n, 2, 2)).toThrow(
      /in 2 holdings or fewer/,
    );
  });

  it("sums the unlocked balance", () => {
    expect(unlockedBalance(holdings, INSTRUMENT)).toBe(7n * 10n ** 10n);
    expect(unlockedBalance(holdings, { admin: OTHER_ADMIN, id: "USD" }, 0)).toBe(50n);
    expect(unlockedBalance([], INSTRUMENT)).toBe(0n);
  });
});
