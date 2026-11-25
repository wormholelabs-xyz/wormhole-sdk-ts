import type { Address } from "@wormhole-foundation/sdk-connect";
import {
  UniversalAddress,
  encoding,
  keccak256,
  registerNative,
} from "@wormhole-foundation/sdk-connect";
import { EMITTER_ADDRESS_TAG, PARTY_ADDRESS_TAG, TOKEN_ADDRESS_TAG } from "./constants.js";
import type { AnyCantonAddress, CantonInstrumentId } from "./types.js";
import { _platform, isCantonPartyId } from "./types.js";

/** u32be(byte length) ‖ utf8(text): the 'lenPrefixed' encoding of Wormhole.Core.Bytes */
function lengthPrefixed(text: string): Uint8Array {
  const bytes = encoding.bytes.encode(text);
  const prefixed = new Uint8Array(4 + bytes.length);
  new DataView(prefixed.buffer).setUint32(0, bytes.length, false);
  prefixed.set(bytes, 4);
  return prefixed;
}

function u64be(value: bigint | number): Uint8Array {
  const big = BigInt(value);
  if (big < 0n || big >= 2n ** 64n)
    throw new Error(`${big} does not fit an unsigned 64-bit integer`);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, big, false);
  return bytes;
}

/**
 * The 32-byte address of a party: keccak256("wormhole:v1" ‖ u32be(len(party)) ‖ party).
 * One-way. Accepts any text; CantonAddress enforces the party id grammar.
 */
export function partyAddress(party: string): Uint8Array {
  return keccak256(
    encoding.bytes.concat(encoding.bytes.encode(PARTY_ADDRESS_TAG), lengthPrefixed(party)),
  );
}

/**
 * The 32-byte token address of a CIP-0056 instrument (Wormhole.Ntt.Payload nttTokenAddressFor):
 * keccak256("wormhole:ntt-token:v1" ‖ lp(admin) ‖ lp(id)). One-way.
 */
export function instrumentTokenAddress(instrument: CantonInstrumentId): Uint8Array {
  return keccak256(
    encoding.bytes.concat(
      encoding.bytes.encode(TOKEN_ADDRESS_TAG),
      lengthPrefixed(instrument.admin),
      lengthPrefixed(instrument.id),
    ),
  );
}

/**
 * The Wormhole emitter address of the Emitter (registrar, owner, emitterId)
 * (Wormhole.Core.State emitterAddressFor):
 * keccak256("wormhole:emitter:v1" ‖ lp(registrar) ‖ lp(owner) ‖ u64be(emitterId)).
 * The registrar is the guardianGovernance party.
 */
export function emitterAddress(
  registrar: string,
  owner: string,
  emitterId: bigint | number,
): UniversalAddress {
  return new UniversalAddress(
    keccak256(
      encoding.bytes.concat(
        encoding.bytes.encode(EMITTER_ADDRESS_TAG),
        lengthPrefixed(registrar),
        lengthPrefixed(owner),
        u64be(emitterId),
      ),
    ),
  );
}

/** Which form of native address a CantonAddress holds */
export type CantonAddressKind = "party" | "instrument" | "hex";

const HEX_32_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;
const INSTRUMENT_SEPARATOR = "/";

/**
 * A Canton native address: a party id ("<hint>::1220<64 hex>"), a CIP-0056 instrument
 * ("<admin party>/<instrument id>", split at the first "/"), or 32 bytes as 64 hex characters
 * (emitter, manager and token addresses).
 *
 * The universal address of a party or an instrument is a one-way hash, so a UniversalAddress
 * converts to a "hex" CantonAddress, never back to a party.
 */
export class CantonAddress implements Address {
  static readonly byteSize = 32;
  static readonly platform = _platform;
  readonly type: string = "Native";

  /** The canonical string: the party id, "<admin>/<id>", or 64 lowercase hex characters */
  readonly address: string;
  readonly kind: CantonAddressKind;

  constructor(address: AnyCantonAddress) {
    if (CantonAddress.instanceof(address)) {
      this.address = address.address;
      this.kind = address.kind;
      return;
    }
    if (UniversalAddress.instanceof(address) || address instanceof Uint8Array) {
      const bytes = address instanceof Uint8Array ? address : address.toUint8Array();
      if (bytes.length !== CantonAddress.byteSize)
        throw new Error(`Invalid Canton address: expected 32 bytes, got ${bytes.length}`);
      this.address = encoding.hex.encode(bytes);
      this.kind = "hex";
      return;
    }
    if (typeof address !== "string") throw new Error(`Invalid Canton address ${String(address)}`);
    const kind = CantonAddress.kindOf(address);
    if (kind === undefined) throw new Error(`Invalid Canton address "${address.slice(0, 80)}"`);
    this.kind = kind;
    this.address = kind === "hex" ? encoding.hex.encode(encoding.hex.decode(address)) : address;
  }

  /** The kind of a native address string, or undefined if the string is not one */
  static kindOf(address: string): CantonAddressKind | undefined {
    if (HEX_32_PATTERN.test(address)) return "hex";
    if (isCantonPartyId(address)) return "party";
    const separatorIndex = address.indexOf(INSTRUMENT_SEPARATOR);
    if (separatorIndex > 0) {
      const admin = address.slice(0, separatorIndex);
      const id = address.slice(separatorIndex + 1);
      if (id.length > 0 && isCantonPartyId(admin)) return "instrument";
    }
    return undefined;
  }

  static isValidAddress(address: string): boolean {
    return CantonAddress.kindOf(address) !== undefined;
  }

  /** "<admin>/<id>" for an instrument */
  static instrumentAddress(instrument: CantonInstrumentId): CantonAddress {
    return new CantonAddress(`${instrument.admin}${INSTRUMENT_SEPARATOR}${instrument.id}`);
  }

  unwrap(): string {
    return this.address;
  }

  toString(): string {
    return this.address;
  }

  toNative(): CantonAddress {
    return this;
  }

  /** The party id of a party address; throws for any other kind */
  toParty(): string {
    if (this.kind !== "party") throw new Error(`Canton address ${this.address} is not a party`);
    return this.address;
  }

  /** The instrument of an instrument address; throws for any other kind */
  toInstrument(): CantonInstrumentId {
    if (this.kind !== "instrument")
      throw new Error(`Canton address ${this.address} is not an instrument`);
    const separatorIndex = this.address.indexOf(INSTRUMENT_SEPARATOR);
    return {
      admin: this.address.slice(0, separatorIndex),
      id: this.address.slice(separatorIndex + 1),
    };
  }

  /** The 32 bytes of a hex address; the UTF-8 text of a party or an instrument */
  toUint8Array(): Uint8Array {
    return this.kind === "hex"
      ? encoding.hex.decode(this.address)
      : encoding.bytes.encode(this.address);
  }

  toUniversalAddress(): UniversalAddress {
    switch (this.kind) {
      case "hex":
        return new UniversalAddress(encoding.hex.decode(this.address));
      case "party":
        return new UniversalAddress(partyAddress(this.address));
      case "instrument":
        return new UniversalAddress(instrumentTokenAddress(this.toInstrument()));
    }
  }

  static instanceof(address: unknown): address is CantonAddress {
    return (
      typeof address === "object" &&
      address !== null &&
      (address.constructor as { platform?: unknown } | undefined)?.platform ===
        CantonAddress.platform
    );
  }

  equals(other: CantonAddress | UniversalAddress): boolean {
    if (CantonAddress.instanceof(other)) return other.address === this.address;
    return other.equals(this.toUniversalAddress());
  }
}

declare module "@wormhole-foundation/sdk-connect" {
  export namespace WormholeRegistry {
    interface PlatformToNativeAddressMapping {
      Canton: CantonAddress;
    }
  }
}

registerNative(_platform, CantonAddress);
