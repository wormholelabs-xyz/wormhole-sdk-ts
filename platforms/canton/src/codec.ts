// Daml value <-> JSON Ledger API v2 encoding, for the types the Wormhole contracts use.
//
// | Daml type                      | JSON                                       |
// | ------------------------------ | ------------------------------------------ |
// | Int, Decimal                   | string                                     |
// | Party, Text, ContractId        | string                                     |
// | Optional a (a not Optional)    | value or null                              |
// | (a, b)                         | { "_1": a, "_2": b }                       |
// | Map k v                        | array of [k, v] pairs                      |
// | Time                           | ISO 8601 string                            |
// | byte types (Wormhole.Core.Bytes) | { "tag": "<TypeName>", "value": "<lowercase hex>" } |
//
// Nested Optional and Set are not encoded until their JSON form is confirmed on a ledger.
import { encoding } from "@wormhole-foundation/sdk-connect";
import { isCantonContractId, isCantonPartyId } from "./types.js";

/** A JSON value as the JSON Ledger API sends and receives it */
export type DamlJson = string | number | boolean | null | DamlJson[] | { [key: string]: DamlJson };

/** The JSON of a Daml byte type: a variant with one constructor of lowercase hex text */
export interface DamlBytesJson<T extends string = string> {
  tag: T;
  value: string;
}

/** A 2-tuple as the JSON Ledger API encodes it */
export interface DamlTuple2Json<A extends DamlJson = DamlJson, B extends DamlJson = DamlJson> {
  _1: A;
  _2: B;
}

/**
 * Byte types of Wormhole.Core.Bytes and their width rules. A number is an exact byte width;
 * `min` is a minimum byte width; undefined is any whole number of bytes.
 */
export const damlByteTypes = {
  HexBytes: undefined,
  MessagePayload: undefined,
  EncodedVaa: { min: 57 },
  VaaDigest: 32,
  EmitterAddress: 32,
  UniversalAddress: 32,
  GuardianAddress: 20,
  GuardianPublicKey: 65,
  EcdsaSignatureR: 32,
  EcdsaSignatureS: 32,
} as const satisfies Record<string, number | { min: number } | undefined>;

export type DamlByteType = keyof typeof damlByteTypes;

const LOWERCASE_HEX_BYTES = /^(?:[0-9a-f]{2})*$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
// Daml Decimal: Numeric 10, at most 38 digits, 10 of them after the point.
const DECIMAL_PATTERN = /^-?(\d{1,28})(?:\.(\d{1,10}))?$/;

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.slice(0, 80);
}

function checkByteWidth(type: string, byteLength: number): void {
  if (!(type in damlByteTypes)) return;
  const rule = damlByteTypes[type as DamlByteType];
  if (typeof rule === "number" && byteLength !== rule)
    throw new Error(`${type}: expected ${rule} bytes, got ${byteLength}`);
  if (typeof rule === "object" && byteLength < rule.min)
    throw new Error(`${type}: expected at least ${rule.min} bytes, got ${byteLength}`);
}

function checkGuardianPublicKey(type: string, hex: string): void {
  if (type === "GuardianPublicKey" && !hex.startsWith("04"))
    throw new Error("GuardianPublicKey: first byte must be 04 (uncompressed point)");
}

/**
 * Encodes bytes as a Daml byte type. A string must already be lowercase hex without 0x;
 * the Daml types accept exactly one form per value.
 */
export function encodeBytes<T extends string>(
  type: T,
  value: Uint8Array | string,
): DamlBytesJson<T> {
  const hex = typeof value === "string" ? value : encoding.hex.encode(value);
  if (!LOWERCASE_HEX_BYTES.test(hex))
    throw new Error(`${type}: not whole bytes of lowercase hex without 0x`);
  checkByteWidth(type, hex.length / 2);
  checkGuardianPublicKey(type, hex);
  return { tag: type, value: hex };
}

/** The lowercase hex of a Daml byte value; the tag must be the expected type */
export function decodeBytesHex(json: unknown, type: string): string {
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new Error(`${type}: expected {tag, value}, got ${describe(json)}`);
  const { tag, value } = json as { tag?: unknown; value?: unknown };
  if (tag !== type) throw new Error(`${type}: unexpected tag ${describe(tag)}`);
  if (typeof value !== "string" || !LOWERCASE_HEX_BYTES.test(value))
    throw new Error(`${type}: value is not whole bytes of lowercase hex`);
  checkByteWidth(type, value.length / 2);
  checkGuardianPublicKey(type, value);
  return value;
}

/** The bytes of a Daml byte value; the tag must be the expected type */
export function decodeBytes(json: unknown, type: string): Uint8Array {
  return encoding.hex.decode(decodeBytesHex(json, type));
}

/** Daml Int (64-bit) as a JSON string */
export function encodeInt(value: bigint | number): string {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error(`Int: ${value} is not a safe integer; pass a bigint`);
  const big = BigInt(value);
  if (big < INT64_MIN || big > INT64_MAX) throw new Error(`Int: ${big} does not fit 64 bits`);
  return big.toString();
}

export function decodeInt(json: unknown): bigint {
  if (typeof json !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(json))
    throw new Error(`Int: expected a decimal integer string, got ${describe(json)}`);
  const big = BigInt(json);
  if (big < INT64_MIN || big > INT64_MAX) throw new Error(`Int: ${json} does not fit 64 bits`);
  return big;
}

/** Daml Decimal as a JSON string; the text must have at most 28 integer and 10 fractional digits */
export function encodeDecimal(value: string): string {
  if (!DECIMAL_PATTERN.test(value)) throw new Error(`Decimal: "${value}" is not a Daml Decimal`);
  return value;
}

export function decodeDecimal(json: unknown): string {
  if (typeof json !== "string" || !DECIMAL_PATTERN.test(json))
    throw new Error(`Decimal: expected a decimal string, got ${describe(json)}`);
  return json;
}

export function encodeParty(party: string): string {
  if (!isCantonPartyId(party)) throw new Error(`Party: "${party.slice(0, 80)}" is not a party id`);
  return party;
}

export function decodeParty(json: unknown): string {
  if (typeof json !== "string" || !isCantonPartyId(json))
    throw new Error(`Party: expected a party id, got ${describe(json)}`);
  return json;
}

export function encodeText(text: string): string {
  return text;
}

export function decodeText(json: unknown): string {
  if (typeof json !== "string") throw new Error(`Text: expected a string, got ${describe(json)}`);
  return json;
}

export function encodeContractId(contractId: string): string {
  if (!isCantonContractId(contractId))
    throw new Error(`ContractId: "${contractId.slice(0, 80)}" is not a contract id`);
  return contractId;
}

export function decodeContractId(json: unknown): string {
  if (typeof json !== "string" || !isCantonContractId(json))
    throw new Error(`ContractId: expected a contract id, got ${describe(json)}`);
  return json;
}

/**
 * Optional a, where a is not itself Optional: the value, or null for None. An inner value that
 * encodes to null would be a nested Optional and is rejected.
 */
export function encodeOptional<T>(
  value: T | undefined | null,
  encodeValue: (inner: T) => DamlJson,
): DamlJson {
  if (value === undefined || value === null) return null;
  const encoded = encodeValue(value);
  if (encoded === null) throw new Error("Optional: nested Optional values are not supported");
  return encoded;
}

export function decodeOptional<T>(
  json: unknown,
  decodeValue: (inner: unknown) => T,
): T | undefined {
  if (json === null || json === undefined) return undefined;
  return decodeValue(json);
}

export function encodeTuple2<A extends DamlJson, B extends DamlJson>(
  first: A,
  second: B,
): DamlTuple2Json<A, B> {
  return { _1: first, _2: second };
}

export function decodeTuple2<A, B>(
  json: unknown,
  decodeFirst: (value: unknown) => A,
  decodeSecond: (value: unknown) => B,
): [A, B] {
  if (
    typeof json !== "object" ||
    json === null ||
    Array.isArray(json) ||
    !("_1" in json) ||
    !("_2" in json)
  )
    throw new Error(`Tuple2: expected {_1, _2}, got ${describe(json)}`);
  const tuple = json as { _1: unknown; _2: unknown };
  return [decodeFirst(tuple._1), decodeSecond(tuple._2)];
}

/** Daml Map k v as an array of [key, value] pairs; duplicate keys are rejected */
export function encodeMap<K, V>(
  entries: Iterable<readonly [K, V]>,
  encodeKey: (key: K) => DamlJson,
  encodeValue: (value: V) => DamlJson,
): DamlJson[] {
  const encoded: DamlJson[] = [];
  const seenKeys = new Set<string>();
  for (const [key, value] of entries) {
    const encodedKey = encodeKey(key);
    const keyText = JSON.stringify(encodedKey);
    if (seenKeys.has(keyText)) throw new Error(`Map: duplicate key ${keyText}`);
    seenKeys.add(keyText);
    encoded.push([encodedKey, encodeValue(value)]);
  }
  return encoded;
}

export function decodeMap<K, V>(
  json: unknown,
  decodeKey: (key: unknown) => K,
  decodeValue: (value: unknown) => V,
): Array<[K, V]> {
  if (!Array.isArray(json))
    throw new Error(`Map: expected an array of pairs, got ${describe(json)}`);
  const seenKeys = new Set<string>();
  return json.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2)
      throw new Error(`Map: expected a [key, value] pair, got ${describe(pair)}`);
    const keyText = JSON.stringify(pair[0]);
    if (seenKeys.has(keyText)) throw new Error(`Map: duplicate key ${keyText}`);
    seenKeys.add(keyText);
    return [decodeKey(pair[0]), decodeValue(pair[1])];
  });
}

/** Daml List as a JSON array */
export function encodeList<T>(
  values: Iterable<T>,
  encodeValue: (value: T) => DamlJson,
): DamlJson[] {
  return Array.from(values, encodeValue);
}

export function decodeList<T>(json: unknown, decodeValue: (value: unknown) => T): T[] {
  if (!Array.isArray(json)) throw new Error(`List: expected an array, got ${describe(json)}`);
  return json.map(decodeValue);
}

/** Daml Time as an ISO 8601 UTC string */
export function encodeTime(time: Date): string {
  if (Number.isNaN(time.getTime())) throw new Error("Time: invalid date");
  return time.toISOString();
}

const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Daml Time; precision below one millisecond is dropped */
export function decodeTime(json: unknown): Date {
  if (typeof json !== "string" || !ISO_TIME_PATTERN.test(json))
    throw new Error(`Time: expected an ISO 8601 time, got ${describe(json)}`);
  const time = new Date(json);
  if (Number.isNaN(time.getTime())) throw new Error(`Time: invalid time ${json}`);
  return time;
}
