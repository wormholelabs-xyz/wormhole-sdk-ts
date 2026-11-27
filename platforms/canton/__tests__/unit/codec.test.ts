import {
  decodeBytes,
  decodeBytesHex,
  decodeContractId,
  decodeDecimal,
  decodeInt,
  decodeList,
  decodeMap,
  decodeOptional,
  decodeParty,
  decodeText,
  decodeTime,
  decodeTuple2,
  encodeBytes,
  encodeContractId,
  encodeDecimal,
  encodeInt,
  encodeList,
  encodeMap,
  encodeOptional,
  encodeParty,
  encodeText,
  encodeTime,
  encodeTuple2,
} from "../../src/codec.js";

const PARTY = `alice::1220${"ab".repeat(32)}`;
const CONTRACT_ID = `00${"cd".repeat(32)}`;

describe("byte variants", () => {
  it("encodes bytes and hex as a tagged variant", () => {
    expect(encodeBytes("MessagePayload", new Uint8Array([0xca, 0xfe]))).toEqual({
      tag: "MessagePayload",
      value: "cafe",
    });
    expect(encodeBytes("MessagePayload", "")).toEqual({ tag: "MessagePayload", value: "" });
    expect(encodeBytes("UniversalAddress", "22".repeat(32))).toEqual({
      tag: "UniversalAddress",
      value: "22".repeat(32),
    });
  });

  it.each([
    ["uppercase hex", "CAFE"],
    ["0x prefix", "0xcafe"],
    ["odd length", "caf"],
    ["non-hex", "zz"],
  ])("rejects %s", (_name, hex) => {
    expect(() => encodeBytes("MessagePayload", hex)).toThrow(/lowercase hex/);
  });

  it("checks the width of a fixed-width type", () => {
    expect(() => encodeBytes("EmitterAddress", "11".repeat(31))).toThrow(/32 bytes/);
    expect(() => encodeBytes("GuardianAddress", "11".repeat(32))).toThrow(/20 bytes/);
    expect(() => encodeBytes("EncodedVaa", "11".repeat(56))).toThrow(/at least 57/);
    expect(() => encodeBytes("GuardianPublicKey", `05${"11".repeat(64)}`)).toThrow(/04/);
    expect(encodeBytes("GuardianPublicKey", `04${"11".repeat(64)}`).value).toHaveLength(130);
  });

  it("accepts an unknown tag with any whole bytes", () => {
    expect(encodeBytes("NttCustomBytes", "00ff")).toEqual({ tag: "NttCustomBytes", value: "00ff" });
  });

  it("decodes with the expected tag only", () => {
    const json = { tag: "VaaDigest", value: "ab".repeat(32) };
    expect(decodeBytesHex(json, "VaaDigest")).toBe("ab".repeat(32));
    expect(decodeBytes(json, "VaaDigest")).toEqual(new Uint8Array(32).fill(0xab));
    expect(() => decodeBytesHex(json, "EmitterAddress")).toThrow(/unexpected tag/);
    expect(() => decodeBytesHex({ tag: "VaaDigest", value: "AB".repeat(32) }, "VaaDigest")).toThrow(
      /lowercase hex/,
    );
    expect(() => decodeBytesHex("abcd", "VaaDigest")).toThrow(/\{tag, value\}/);
    expect(() => decodeBytesHex({ tag: "VaaDigest", value: "ab" }, "VaaDigest")).toThrow(
      /32 bytes/,
    );
  });
});

describe("scalars", () => {
  it("Int is a string of a 64-bit integer", () => {
    expect(encodeInt(42)).toBe("42");
    expect(encodeInt(-7n)).toBe("-7");
    expect(encodeInt(2n ** 63n - 1n)).toBe("9223372036854775807");
    expect(() => encodeInt(2n ** 63n)).toThrow(/64 bits/);
    expect(() => encodeInt(1.5)).toThrow(/safe integer/);
    expect(decodeInt("9223372036854775807")).toBe(2n ** 63n - 1n);
    expect(decodeInt("-1")).toBe(-1n);
    expect(() => decodeInt(42)).toThrow(/string/);
    expect(() => decodeInt("01")).toThrow();
    expect(() => decodeInt("9223372036854775808")).toThrow(/64 bits/);
  });

  it("Decimal is a string with at most 10 fractional digits", () => {
    expect(encodeDecimal("1.5")).toBe("1.5");
    expect(encodeDecimal("-0.0000000001")).toBe("-0.0000000001");
    expect(() => encodeDecimal("1.00000000001")).toThrow(/Decimal/);
    expect(() => encodeDecimal("1e5")).toThrow(/Decimal/);
    expect(decodeDecimal("100.0000000000")).toBe("100.0000000000");
    expect(() => decodeDecimal(1.5)).toThrow(/Decimal/);
  });

  it("Party, Text and ContractId are strings", () => {
    expect(encodeParty(PARTY)).toBe(PARTY);
    expect(decodeParty(PARTY)).toBe(PARTY);
    expect(() => encodeParty("alice")).toThrow(/party id/);
    expect(() => decodeParty(7)).toThrow(/party id/);
    expect(encodeText("hello")).toBe("hello");
    expect(decodeText("hello")).toBe("hello");
    expect(() => decodeText(null)).toThrow(/string/);
    expect(encodeContractId(CONTRACT_ID)).toBe(CONTRACT_ID);
    expect(decodeContractId(CONTRACT_ID)).toBe(CONTRACT_ID);
    expect(() => encodeContractId("cid")).toThrow(/contract id/);
  });

  it("Time is an ISO 8601 string", () => {
    const time = new Date("2026-11-24T10:00:00.123Z");
    expect(encodeTime(time)).toBe("2026-11-24T10:00:00.123Z");
    expect(decodeTime("2026-11-24T10:00:00.123456Z").getTime()).toBe(time.getTime());
    expect(decodeTime("2026-11-24T10:00:00Z").toISOString()).toBe("2026-11-24T10:00:00.000Z");
    expect(() => decodeTime("2026-11-24")).toThrow(/ISO 8601/);
    expect(() => encodeTime(new Date("bad"))).toThrow(/invalid/);
  });
});

describe("containers", () => {
  it("Optional is the value or null", () => {
    expect(encodeOptional(undefined, encodeText)).toBeNull();
    expect(encodeOptional(null, encodeText)).toBeNull();
    expect(encodeOptional("x", encodeText)).toBe("x");
    expect(decodeOptional(null, decodeText)).toBeUndefined();
    expect(decodeOptional("x", decodeText)).toBe("x");
  });

  it("rejects a nested Optional", () => {
    expect(() => encodeOptional("x", () => null)).toThrow(/nested Optional/);
  });

  it("a tuple is {_1, _2}", () => {
    expect(encodeTuple2("1", "2")).toEqual({ _1: "1", _2: "2" });
    expect(decodeTuple2({ _1: "1", _2: PARTY }, decodeInt, decodeParty)).toEqual([1n, PARTY]);
    expect(() => decodeTuple2(["1", "2"], decodeInt, decodeInt)).toThrow(/_1, _2/);
  });

  it("a Map is an array of pairs", () => {
    const encoded = encodeMap(
      [
        [0n, "a"],
        [1n, "b"],
      ],
      encodeInt,
      encodeText,
    );
    expect(encoded).toEqual([
      ["0", "a"],
      ["1", "b"],
    ]);
    expect(decodeMap(encoded, decodeInt, decodeText)).toEqual([
      [0n, "a"],
      [1n, "b"],
    ]);
    expect(() =>
      encodeMap(
        [
          [1n, "a"],
          [1n, "b"],
        ],
        encodeInt,
        encodeText,
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      decodeMap(
        [
          ["1", "a"],
          ["1", "b"],
        ],
        decodeInt,
        decodeText,
      ),
    ).toThrow(/duplicate/);
    expect(() => decodeMap({ "1": "a" }, decodeInt, decodeText)).toThrow(/array of pairs/);
    expect(() => decodeMap([["1"]], decodeInt, decodeText)).toThrow(/pair/);
  });

  it("a List is an array", () => {
    expect(encodeList([1n, 2n], encodeInt)).toEqual(["1", "2"]);
    expect(decodeList(["1", "2"], decodeInt)).toEqual([1n, 2n]);
    expect(() => decodeList("1", decodeInt)).toThrow(/array/);
  });

  it("nests: a guardian set member list in a map", () => {
    const json = [
      [
        "0",
        {
          keys: [{ tag: "GuardianAddress", value: "11".repeat(20) }],
          expirationTime: null,
        },
      ],
    ];
    const decoded = decodeMap(json, decodeInt, (value) => {
      const record = value as { keys: unknown; expirationTime: unknown };
      return {
        keys: decodeList(record.keys, (key) => decodeBytesHex(key, "GuardianAddress")),
        expirationTime: decodeOptional(record.expirationTime, decodeTime),
      };
    });
    expect(decoded).toEqual([[0n, { keys: ["11".repeat(20)], expirationTime: undefined }]]);
  });
});
