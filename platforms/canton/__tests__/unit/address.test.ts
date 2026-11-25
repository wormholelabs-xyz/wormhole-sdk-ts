import { UniversalAddress, encoding, toNative } from "@wormhole-foundation/sdk-connect";
import {
  CantonAddress,
  emitterAddress,
  instrumentTokenAddress,
  partyAddress,
} from "../../src/address.js";
import { isCantonPartyId, parseCantonContractId, parseCantonTemplateId } from "../../src/types.js";

const FINGERPRINT = `1220${"ab".repeat(32)}`;
const ALICE = `alice::${FINGERPRINT}`;
const ADMIN = `token-admin::${FINGERPRINT}`;

describe("address derivations", () => {
  // D1 vector (docs/wh-sdk-canton.md, decision D1).
  it("party hash: vector-recipient::1220deadbeef", () => {
    expect(encoding.hex.encode(partyAddress("vector-recipient::1220deadbeef"))).toBe(
      "4c3feac3d35c3b4bcd02a9b3faa309c8ed0b33163e2161908f691980319f7947",
    );
  });

  // wormhole/canton/test/daml/Test/TestCore.daml testAddressVector.
  it("emitter address: shared cross-language vector", () => {
    expect(
      emitterAddress(
        `vector-registrar::1220${"deadbeef".repeat(8)}`,
        "vector-owner::1220cafebabe",
        7,
      ).toString(),
    ).toBe("0x37311031ac421fbccc74c1df19ad5635cbefd1a82db60d613eb62a158f504d35");
  });

  it("emitter address: a bigint id gives the same address as a number", () => {
    const registrar = `vector-registrar::1220${"deadbeef".repeat(8)}`;
    expect(emitterAddress(registrar, ALICE, 7n).equals(emitterAddress(registrar, ALICE, 7))).toBe(
      true,
    );
  });

  it("emitter address: rejects an id outside u64", () => {
    expect(() => emitterAddress(ALICE, ALICE, -1)).toThrow(/64-bit/);
    expect(() => emitterAddress(ALICE, ALICE, 2n ** 64n)).toThrow(/64-bit/);
  });

  // ntt/canton/test/daml/Test/TestNttVectors.daml testVectorTokenAddress.
  it("token address: nttTokenAddressFromText vector", () => {
    expect(
      encoding.hex.encode(
        instrumentTokenAddress({ admin: "vector-token-admin::1220deadbeef", id: "VECTOR-TOKEN" }),
      ),
    ).toBe("0eb25a08a7432d2f56bd449c5ca6e41c9c0b13d1af7e784f46d70572dff91efa");
  });

  it("length prefixes separate the fields", () => {
    const left = instrumentTokenAddress({ admin: "ab", id: "c" });
    const right = instrumentTokenAddress({ admin: "a", id: "bc" });
    expect(encoding.bytes.equals(left, right)).toBe(false);
  });
});

describe("CantonAddress", () => {
  it("parses a party id", () => {
    const address = new CantonAddress(ALICE);
    expect(address.kind).toBe("party");
    expect(address.toString()).toBe(ALICE);
    expect(address.unwrap()).toBe(ALICE);
    expect(address.toParty()).toBe(ALICE);
    expect(encoding.bytes.decode(address.toUint8Array())).toBe(ALICE);
    expect(address.toUniversalAddress().toUint8Array()).toEqual(partyAddress(ALICE));
  });

  it("parses an instrument, split at the first slash", () => {
    const address = new CantonAddress(`${ADMIN}/USD/coin`);
    expect(address.kind).toBe("instrument");
    expect(address.toInstrument()).toEqual({ admin: ADMIN, id: "USD/coin" });
    expect(address.toUniversalAddress().toUint8Array()).toEqual(
      instrumentTokenAddress({ admin: ADMIN, id: "USD/coin" }),
    );
    expect(CantonAddress.instrumentAddress({ admin: ADMIN, id: "USD/coin" }).equals(address)).toBe(
      true,
    );
  });

  it("parses 64 hex characters and passes them through", () => {
    const hex = "ab".repeat(32);
    const address = new CantonAddress(`0x${hex.toUpperCase()}`);
    expect(address.kind).toBe("hex");
    expect(address.toString()).toBe(hex);
    expect(encoding.hex.encode(address.toUniversalAddress().toUint8Array())).toBe(hex);
    expect(encoding.hex.encode(address.toUint8Array())).toBe(hex);
  });

  it("accepts a UniversalAddress, 32 bytes and a CantonAddress", () => {
    const bytes = new Uint8Array(32).fill(7);
    const fromUniversal = new CantonAddress(new UniversalAddress(bytes));
    expect(fromUniversal.kind).toBe("hex");
    expect(new CantonAddress(bytes).equals(fromUniversal)).toBe(true);
    expect(new CantonAddress(fromUniversal).toString()).toBe(fromUniversal.toString());
    expect(() => new CantonAddress(new Uint8Array(20))).toThrow(/32 bytes/);
    expect(() => new CantonAddress(new UniversalAddress(new Uint8Array(20)))).toThrow(/32 bytes/);  });

  it("compares with a universal address", () => {
    const address = new CantonAddress(ALICE);
    expect(address.equals(new UniversalAddress(partyAddress(ALICE)))).toBe(true);
    expect(address.equals(new CantonAddress(ADMIN))).toBe(false);
  });

  it("is registered as the native address of Canton", () => {
    const native = toNative("Canton", ALICE);
    expect(CantonAddress.instanceof(native)).toBe(true);
    expect(native.toString()).toBe(ALICE);
  });

  it.each([
    ["no separator", "alice"],
    ["short fingerprint", "vector-recipient::1220deadbeef"],
    ["uppercase fingerprint", `alice::1220${"AB".repeat(32)}`],
    ["wrong namespace prefix", `alice::1221${"ab".repeat(32)}`],
    ["empty hint", `::${FINGERPRINT}`],
    ["hint with a dot", `al.ice::${FINGERPRINT}`],
    ["hint ending with a colon", `alice:::${FINGERPRINT}`],
    ["hint too long", `${"a".repeat(186)}::${FINGERPRINT}`],
    ["instrument without id", `${ADMIN}/`],
    ["instrument with a bad admin", "admin/USD"],
    ["63 hex characters", "a".repeat(63)],
  ])("rejects %s", (_name, text) => {
    expect(CantonAddress.isValidAddress(text)).toBe(false);
    expect(() => new CantonAddress(text)).toThrow(/Invalid Canton address/);
  });

  it("toParty and toInstrument check the kind", () => {
    expect(() => new CantonAddress(ADMIN).toInstrument()).toThrow(/not an instrument/);
    expect(() => new CantonAddress(`${ADMIN}/USD`).toParty()).toThrow(/not a party/);
  });
});

describe("id parsers", () => {
  it("party ids", () => {
    expect(isCantonPartyId(ALICE)).toBe(true);
    expect(isCantonPartyId(`a b:c_d-e::${FINGERPRINT}`)).toBe(true);
  });

  it("contract ids", () => {
    const contractId = `00${"cd".repeat(32)}ca10`;
    expect(parseCantonContractId(contractId)).toBe(contractId);
    expect(() => parseCantonContractId(`02${"cd".repeat(32)}`)).toThrow();
    expect(() => parseCantonContractId("00abc")).toThrow();
  });

  it("template ids need a package id", () => {
    const packageId = "ef".repeat(32);
    expect(parseCantonTemplateId(`${packageId}:Wormhole.Core.State:CoreState`)).toEqual({
      packageId,
      moduleName: "Wormhole.Core.State",
      entityName: "CoreState",
    });
    expect(() => parseCantonTemplateId("#wormhole-core:Wormhole.Core.State:CoreState")).toThrow(
      /64 lowercase hex/,
    );
    expect(() => parseCantonTemplateId(`${packageId}:CoreState`)).toThrow(/Template id/);
  });
});
