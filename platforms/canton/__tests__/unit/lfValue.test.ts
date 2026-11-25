import { encoding } from "@wormhole-foundation/sdk-connect";
import { readCreatedEventBlob } from "../../src/blob.js";
import type { LfType, LfValue } from "../../src/lfValue.js";
import {
  LF_VALUE_MAX_NESTING,
  createArgumentToJson,
  lfType,
  lfValueToJson,
  readValue,
} from "../../src/lfValue.js";
import { SANDBOX_CORE_STATE, SANDBOX_GG } from "../fixtures/sandbox.js";

// Hand-written protobuf encoding of Daml-LF values (value.proto).

function varint(value: number | bigint): number[] {
  let remaining = BigInt(value);
  if (remaining < 0n) remaining += 1n << 64n;
  const bytes: number[] = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return bytes;
}

const tag = (field: number, wireType: number) => varint((field << 3) | wireType);
const lengthDelimited = (field: number, bytes: number[]) => [
  ...tag(field, 2),
  ...varint(bytes.length),
  ...bytes,
];
const utf8 = (text: string) => [...encoding.bytes.encode(text)];

const v = {
  unit: () => lengthDelimited(1, []),
  bool: (flag: boolean) => [...tag(2, 0), flag ? 1 : 0],
  int64: (value: bigint) => [
    ...tag(3, 0),
    ...varint(value >= 0n ? value << 1n : (-value << 1n) - 1n),
  ],
  date: (days: number) => [...tag(4, 0), ...varint(days)],
  timestamp: (micros: bigint) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, micros, true);
    return [...tag(5, 1), ...bytes];
  },
  numeric: (text: string) => lengthDelimited(6, utf8(text)),
  party: (party: string) => lengthDelimited(7, utf8(party)),
  text: (text: string) => lengthDelimited(8, utf8(text)),
  contractId: (hex: string) => lengthDelimited(9, [...encoding.hex.decode(hex)]),
  optional: (inner?: number[]) => lengthDelimited(10, inner ? lengthDelimited(1, inner) : []),
  list: (elements: number[][]) =>
    lengthDelimited(
      11,
      elements.flatMap((e) => lengthDelimited(1, e)),
    ),
  map: (entries: Array<[number[], number[]]>) =>
    lengthDelimited(
      12,
      entries.flatMap(([key, value]) =>
        lengthDelimited(1, [...lengthDelimited(1, key), ...lengthDelimited(2, value)]),
      ),
    ),
  record: (fields: number[][]) =>
    lengthDelimited(
      13,
      fields.flatMap((field) => lengthDelimited(1, lengthDelimited(1, field))),
    ),
  variant: (constructor: string, value: number[]) =>
    lengthDelimited(14, [...lengthDelimited(1, utf8(constructor)), ...lengthDelimited(2, value)]),
  enum: (constructor: string) => lengthDelimited(15, lengthDelimited(1, utf8(constructor))),
  textMap: (entries: Array<[string, number[]]>) =>
    lengthDelimited(
      16,
      entries.flatMap(([key, value]) =>
        lengthDelimited(1, [...lengthDelimited(1, utf8(key)), ...lengthDelimited(2, value)]),
      ),
    ),
};

const read = (bytes: number[]) => readValue(new Uint8Array(bytes));
const PARTY = `alice::1220${"ab".repeat(32)}`;

describe("readValue", () => {
  it("reads every value kind", () => {
    expect(read(v.unit())).toEqual({ kind: "unit" });
    expect(read(v.bool(true))).toEqual({ kind: "bool", value: true });
    expect(read(v.int64(75n))).toEqual({ kind: "int64", value: 75n });
    expect(read(v.int64(-3n))).toEqual({ kind: "int64", value: -3n });
    expect(read(v.int64(2n ** 63n - 1n))).toEqual({ kind: "int64", value: 2n ** 63n - 1n });
    expect(read(v.int64(-(2n ** 63n)))).toEqual({ kind: "int64", value: -(2n ** 63n) });
    expect(read(v.date(-1))).toEqual({ kind: "date", days: -1 });
    expect(read(v.timestamp(-5n))).toEqual({ kind: "timestamp", micros: -5n });
    expect(read(v.numeric("1.5000000000"))).toEqual({ kind: "numeric", value: "1.5000000000" });
    expect(read(v.party(PARTY))).toEqual({ kind: "party", value: PARTY });
    expect(read(v.text(""))).toEqual({ kind: "text", value: "" });
    expect(read(v.contractId("00ab"))).toEqual({ kind: "contractId", value: "00ab" });
    expect(read(v.optional())).toEqual({ kind: "optional", value: undefined });
    expect(read(v.optional(v.int64(1n)))).toEqual({
      kind: "optional",
      value: { kind: "int64", value: 1n },
    });
    expect(read(v.list([v.text("a"), v.text("b")]))).toEqual({
      kind: "list",
      elements: [
        { kind: "text", value: "a" },
        { kind: "text", value: "b" },
      ],
    });
    expect(read(v.map([[v.int64(0n), v.bool(false)]]))).toEqual({
      kind: "map",
      entries: [
        [
          { kind: "int64", value: 0n },
          { kind: "bool", value: false },
        ],
      ],
    });
    expect(read(v.textMap([["k", v.unit()]]))).toEqual({
      kind: "textMap",
      entries: [["k", { kind: "unit" }]],
    });
    expect(read(v.record([v.party(PARTY), v.int64(1n)]))).toEqual({
      kind: "record",
      fields: [
        { kind: "party", value: PARTY },
        { kind: "int64", value: 1n },
      ],
    });
    expect(read(v.variant("MessagePayload", v.text("ab")))).toEqual({
      kind: "variant",
      constructor: "MessagePayload",
      value: { kind: "text", value: "ab" },
    });
    expect(read(v.enum("Red"))).toEqual({ kind: "enum", constructor: "Red" });
  });

  const failures: Array<[string, number[], RegExp]> = [
    ["no member", [], /Value has no member/],
    ["two members", [...v.bool(true), ...v.int64(1n)], /more than one member/],
    ["an unknown member", lengthDelimited(18, []), /unknown field 18/],
    ["uint256", lengthDelimited(17, [1]), /uint256 is not supported/],
    ["a wrong wire type", [...tag(3, 2), 0], /wire type 2, expected 0/],
    ["a bool above 1", [...tag(2, 0), 2], /Value.bool is 2/],
    ["a non-empty unit", lengthDelimited(1, [1]), /unit is not empty/],
    ["a truncated value", lengthDelimited(8, utf8("abc")).slice(0, 3), /past the end/],
    [
      "a record field without value",
      lengthDelimited(13, lengthDelimited(1, [])),
      /Field has no value/,
    ],
    [
      "a variant without constructor",
      lengthDelimited(14, lengthDelimited(2, v.unit())),
      /no constructor/,
    ],
    [
      "a map entry without key",
      lengthDelimited(12, lengthDelimited(1, lengthDelimited(2, v.unit()))),
      /no key/,
    ],
    ["an unknown record field", lengthDelimited(13, lengthDelimited(2, [])), /unknown field 2/],
  ];
  it.each(failures)("rejects %s", (_name, bytes, pattern) => {
    expect(() => read(bytes)).toThrow(pattern);
  });

  it("rejects nesting deeper than Daml allows", () => {
    let nested = v.unit();
    for (let depth = 0; depth <= LF_VALUE_MAX_NESTING; depth++) nested = v.list([nested]);
    expect(() => read(nested)).toThrow(/nesting is deeper than 100/);
  });

  it("reads the create argument of a recorded CoreState blob", () => {
    const { createArgument } = readCreatedEventBlob(SANDBOX_CORE_STATE.createdEventBlob);
    const value = readValue(createArgument);
    if (value.kind !== "record") throw new Error("not a record");
    // CoreState has 11 fields; normalization drops the trailing None
    // (evictedGovernanceMaxTimestampSeconds).
    expect(value.fields.map((field) => field.kind)).toEqual([
      "party",
      "int64",
      "int64",
      "variant",
      "int64",
      "map",
      "int64",
      "record",
      "party",
      "map",
    ]);
    expect(value.fields[0]).toEqual({ kind: "party", value: SANDBOX_GG });
  });
});

describe("lfValueToJson", () => {
  const point: LfType = lfType.record("Point", [
    ["owner", lfType.party],
    ["count", lfType.int64],
    ["label", lfType.optional(lfType.text)],
    ["at", lfType.optional(lfType.timestamp)],
  ]);
  const value = (fields: LfValue[]): LfValue => ({ kind: "record", fields });

  it("labels record fields and fills omitted trailing Optional fields with null", () => {
    expect(
      lfValueToJson(
        value([
          { kind: "party", value: PARTY },
          { kind: "int64", value: 3n },
        ]),
        point,
      ),
    ).toEqual({ owner: PARTY, count: "3", label: null, at: null });
    expect(
      lfValueToJson(
        value([
          { kind: "party", value: PARTY },
          { kind: "int64", value: -1n },
          { kind: "optional", value: { kind: "text", value: "x" } },
          { kind: "optional", value: { kind: "timestamp", micros: 1_732_000_000_123_456n } },
        ]),
        point,
      ),
    ).toEqual({ owner: PARTY, count: "-1", label: "x", at: "2024-11-19T07:06:40.123Z" });
  });

  it("encodes byte types, lists and maps as the JSON Ledger API does", () => {
    const type = lfType.map(lfType.int64, lfType.list(lfType.bytes("GuardianAddress")));
    const json = lfValueToJson(
      {
        kind: "map",
        entries: [
          [
            { kind: "int64", value: 0n },
            {
              kind: "list",
              elements: [
                {
                  kind: "variant",
                  constructor: "GuardianAddress",
                  value: { kind: "text", value: "aa" },
                },
              ],
            },
          ],
        ],
      },
      type,
    );
    expect(json).toEqual([["0", [{ tag: "GuardianAddress", value: "aa" }]]]);
  });

  const mode = lfType.enum("Mode", ["LockUnlock", "BurnMint"]);
  const factory = lfType.variant("Factory", {
    TransferFactoryCid: lfType.contractId,
    Count: lfType.int64,
  });

  it("encodes enums as the constructor name and variants as {tag, value}", () => {
    expect(lfValueToJson({ kind: "enum", constructor: "BurnMint" }, mode)).toBe("BurnMint");
    expect(
      lfValueToJson(
        {
          kind: "variant",
          constructor: "TransferFactoryCid",
          value: { kind: "contractId", value: "00ab" },
        },
        factory,
      ),
    ).toEqual({ tag: "TransferFactoryCid", value: "00ab" });
    expect(
      lfValueToJson(
        { kind: "variant", constructor: "Count", value: { kind: "int64", value: 7n } },
        factory,
      ),
    ).toEqual({ tag: "Count", value: "7" });
  });

  const failures: Array<[string, LfValue, LfType, RegExp]> = [
    [
      "an enum constructor the type does not have",
      { kind: "enum", constructor: "Other" },
      lfType.enum("Mode", ["LockUnlock", "BurnMint"]),
      /Mode has no constructor Other/,
    ],
    [
      "a variant where an enum is expected",
      { kind: "variant", constructor: "BurnMint", value: { kind: "unit" } },
      lfType.enum("Mode", ["LockUnlock", "BurnMint"]),
      /expected a Mode enum, found variant/,
    ],
    [
      "a variant constructor the type does not have",
      { kind: "variant", constructor: "toString", value: { kind: "unit" } },
      lfType.variant("Factory", { TransferFactoryCid: lfType.contractId }),
      /Factory has no constructor toString/,
    ],
    [
      "a variant value of another type",
      { kind: "variant", constructor: "TransferFactoryCid", value: { kind: "text", value: "x" } },
      lfType.variant("Factory", { TransferFactoryCid: lfType.contractId }),
      /TransferFactoryCid: expected a ContractId, found text/,
    ],
    ["a kind mismatch", { kind: "text", value: "1" }, lfType.int64, /expected an Int, found text/],
    [
      "too many record fields",
      value([
        { kind: "party", value: PARTY },
        { kind: "int64", value: 1n },
        { kind: "optional", value: undefined },
        { kind: "optional", value: undefined },
        { kind: "unit" },
      ]),
      point,
      /Point has 4 fields, found 5/,
    ],
    [
      "a missing field that is not optional",
      value([{ kind: "party", value: PARTY }]),
      point,
      /field count is missing and only trailing Optional fields may be omitted/,
    ],
    [
      "a byte variant with another constructor",
      { kind: "variant", constructor: "VaaDigest", value: { kind: "text", value: "" } },
      lfType.bytes("EmitterAddress"),
      /expected constructor EmitterAddress, found VaaDigest/,
    ],
    [
      "a byte variant that does not hold text",
      { kind: "variant", constructor: "EmitterAddress", value: { kind: "unit" } },
      lfType.bytes("EmitterAddress"),
      /expected a Text, found unit/,
    ],
    [
      "a nested Optional type",
      { kind: "optional", value: undefined },
      lfType.optional(lfType.optional(lfType.int64)),
      /nested Optional/,
    ],
  ];
  it.each(failures)("rejects %s", (_name, input, type, pattern) => {
    expect(() => lfValueToJson(input, type)).toThrow(pattern);
  });

  it("decodes a create argument only as a record type", () => {
    expect(() => createArgumentToJson(new Uint8Array(v.unit()), lfType.int64)).toThrow(
      /A create argument is a record/,
    );
  });
});
