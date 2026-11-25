// Reader of a serialized Daml-LF value: the `create_arg` of a created event blob (blob.ts).
//
// Canton writes it with ValueCoder.encodeValue (daml-lf/transaction): the bytes of a protobuf
// `Value` (value.proto), without a `VersionedValue` wrapper:
//
//   message Value { oneof sum {
//     Empty unit = 1;  bool bool = 2;  sint64 int64 = 3;  int32 date = 4;  sfixed64 timestamp = 5;
//     string numeric = 6;  string party = 7;  string text = 8;  bytes contract_id = 9;
//     Optional optional = 10;  List list = 11;  Map map = 12;  Record record = 13;
//     Variant variant = 14;  Enum enum = 15;  TextMap text_map = 16;  bytes uint256 = 17; } }
//   message Record { repeated Field fields = 1; message Field { Value value = 1; } }
//   message Variant { string constructor = 1; Value value = 2; }
//   message Enum { string value = 1; }
//   message List { repeated Value elements = 1; }
//   message Optional { Value value = 1; }
//   message Map { repeated Entry entries = 1; message Entry { Value key = 1; Value value = 2; } }
//   message TextMap { repeated Entry entries = 1; message Entry { string key = 1; Value value = 2; } }
//
// A stored create argument is a normalized value (SValue.toNormalizedValue): no type ids, no
// record field labels, and the trailing None fields of each record dropped. So record fields are
// positional, and the reader needs the field order of each record type from its Daml source
// (LfType below). The reader fails closed: an unknown field, a second value in the oneof, a
// value kind other than the expected type, too many record fields, a missing field that is not a
// trailing Optional, or nesting deeper than Daml allows each throw. It never guesses a field.
//
// A value read this way from a blob that passed the envelope checks (anchor.ts) has the same
// trust as a read from the participant's JSON Ledger API: the ledger binds the blob to its
// contract id when a command discloses it, but a reader that does not submit the blob has only
// the source's word that the contract exists and is active.
import { encoding } from "@wormhole-foundation/sdk-connect";
import type { DamlJson } from "./codec.js";
import {
  BlobFormatError,
  ProtoReader,
  SeenFields,
  WIRE_FIXED64,
  WIRE_LENGTH_DELIMITED,
  WIRE_VARINT,
  expectWireType,
  unknownField,
} from "./blob.js";

/** Daml-LF value nesting limit (Value.MAXIMUM_NESTING) */
export const LF_VALUE_MAX_NESTING = 100;

/** A decoded Daml-LF value, without type information (a normalized value has none) */
export type LfValue =
  | { kind: "unit" }
  | { kind: "bool"; value: boolean }
  | { kind: "int64"; value: bigint }
  | { kind: "date"; days: number }
  | { kind: "timestamp"; micros: bigint }
  | { kind: "numeric"; value: string }
  | { kind: "party"; value: string }
  | { kind: "text"; value: string }
  /** Lowercase hex, as the Ledger API writes contract ids */
  | { kind: "contractId"; value: string }
  | { kind: "optional"; value: LfValue | undefined }
  | { kind: "list"; elements: LfValue[] }
  | { kind: "map"; entries: Array<[LfValue, LfValue]> }
  | { kind: "textMap"; entries: Array<[string, LfValue]> }
  | { kind: "record"; fields: LfValue[] }
  | { kind: "variant"; constructor: string; value: LfValue }
  | { kind: "enum"; constructor: string };

/** The Value oneof members by field number */
const VALUE_KINDS: Record<number, string> = {
  1: "unit",
  2: "bool",
  3: "int64",
  4: "date",
  5: "timestamp",
  6: "numeric",
  7: "party",
  8: "text",
  9: "contract_id",
  10: "optional",
  11: "list",
  12: "map",
  13: "record",
  14: "variant",
  15: "enum",
  16: "text_map",
  17: "uint256",
};

function zigZagDecode(encoded: bigint): bigint {
  return (encoded >> 1n) ^ -(encoded & 1n);
}

function readEmpty(bytes: Uint8Array): void {
  if (bytes.length !== 0) throw new BlobFormatError("Value.unit is not empty");
}

/** Reads the one field of a wrapper message that holds a single (optional) Value */
function readSingleValue(
  bytes: Uint8Array,
  messageName: string,
  depth: number,
  required: boolean,
): LfValue | undefined {
  const reader = new ProtoReader(bytes, messageName);
  const seen = new SeenFields(messageName);
  let value: LfValue | undefined;
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    if (field !== 1) unknownField(messageName, field);
    seen.once(field, "value");
    expectWireType(messageName, "value", wireType, WIRE_LENGTH_DELIMITED);
    value = readValue(reader.readLengthDelimited(), depth + 1);
  }
  if (required && value === undefined) throw new BlobFormatError(`${messageName} has no value`);
  return value;
}

/** Reads a message whose only field 1 is a repeated Value (List) or a repeated sub-message */
function readRepeated(
  bytes: Uint8Array,
  messageName: string,
  readElement: (elementBytes: Uint8Array) => void,
): void {
  const reader = new ProtoReader(bytes, messageName);
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    if (field !== 1) unknownField(messageName, field);
    expectWireType(messageName, "entries", wireType, WIRE_LENGTH_DELIMITED);
    readElement(reader.readLengthDelimited());
  }
}

/** Reads a two-field entry message: key (field 1) and value (field 2) */
function readEntry(
  bytes: Uint8Array,
  messageName: string,
  readKey: (reader: ProtoReader) => void,
  depth: number,
  keyRequired: boolean,
): LfValue {
  const reader = new ProtoReader(bytes, messageName);
  const seen = new SeenFields(messageName);
  let value: LfValue | undefined;
  let hasKey = false;
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    switch (field) {
      case 1:
        seen.once(field, "key");
        expectWireType(messageName, "key", wireType, WIRE_LENGTH_DELIMITED);
        readKey(reader);
        hasKey = true;
        break;
      case 2:
        seen.once(field, "value");
        expectWireType(messageName, "value", wireType, WIRE_LENGTH_DELIMITED);
        value = readValue(reader.readLengthDelimited(), depth + 1);
        break;
      default:
        unknownField(messageName, field);
    }
  }
  if (keyRequired && !hasKey) throw new BlobFormatError(`${messageName} has no key`);
  if (value === undefined) throw new BlobFormatError(`${messageName} has no value`);
  return value;
}

function readVariant(bytes: Uint8Array, depth: number): LfValue {
  const name = "Value.Variant";
  const reader = new ProtoReader(bytes, name);
  const seen = new SeenFields(name);
  let constructor = "";
  let value: LfValue | undefined;
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    switch (field) {
      case 1:
        seen.once(field, "constructor");
        expectWireType(name, "constructor", wireType, WIRE_LENGTH_DELIMITED);
        constructor = reader.readString("constructor");
        break;
      case 2:
        seen.once(field, "value");
        expectWireType(name, "value", wireType, WIRE_LENGTH_DELIMITED);
        value = readValue(reader.readLengthDelimited(), depth + 1);
        break;
      default:
        unknownField(name, field);
    }
  }
  if (constructor === "") throw new BlobFormatError(`${name} has no constructor`);
  if (value === undefined) throw new BlobFormatError(`${name} has no value`);
  return { kind: "variant", constructor, value };
}

function readEnum(bytes: Uint8Array): LfValue {
  const name = "Value.Enum";
  const reader = new ProtoReader(bytes, name);
  const seen = new SeenFields(name);
  let constructor = "";
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    if (field !== 1) unknownField(name, field);
    seen.once(field, "value");
    expectWireType(name, "value", wireType, WIRE_LENGTH_DELIMITED);
    constructor = reader.readString("value");
  }
  if (constructor === "") throw new BlobFormatError(`${name} has no constructor`);
  return { kind: "enum", constructor };
}

/** The one member of a Value's oneof, read from its tag */
function readValueMember(reader: ProtoReader, field: number, wireType: number, depth: number) {
  const name = "Value";
  const member = VALUE_KINDS[field];
  if (member === undefined) unknownField(name, field);
  switch (field) {
    case 2: {
      expectWireType(name, member, wireType, WIRE_VARINT);
      const flag = reader.readVarint();
      if (flag > 1n) throw new BlobFormatError(`Value.bool is ${flag}`);
      return { kind: "bool", value: flag === 1n } as const;
    }
    case 3:
      expectWireType(name, member, wireType, WIRE_VARINT);
      return { kind: "int64", value: zigZagDecode(reader.readVarint()) } as const;
    case 4: {
      expectWireType(name, member, wireType, WIRE_VARINT);
      const days = BigInt.asIntN(64, reader.readVarint());
      if (days < -(2n ** 31n) || days >= 2n ** 31n)
        throw new BlobFormatError(`Value.date ${days} does not fit int32`);
      return { kind: "date", days: Number(days) } as const;
    }
    case 5:
      expectWireType(name, member, wireType, WIRE_FIXED64);
      return { kind: "timestamp", micros: reader.readFixed64() } as const;
  }
  expectWireType(name, member, wireType, WIRE_LENGTH_DELIMITED);
  switch (field) {
    case 1:
      readEmpty(reader.readLengthDelimited());
      return { kind: "unit" } as const;
    case 6:
      return { kind: "numeric", value: reader.readString(member) } as const;
    case 7:
      return { kind: "party", value: reader.readString(member) } as const;
    case 8:
      return { kind: "text", value: reader.readString(member) } as const;
    case 9:
      return {
        kind: "contractId",
        value: encoding.hex.encode(reader.readLengthDelimited()),
      } as const;
    case 10:
      return {
        kind: "optional",
        value: readSingleValue(reader.readLengthDelimited(), "Value.Optional", depth, false),
      } as const;
    case 11: {
      const elements: LfValue[] = [];
      readRepeated(reader.readLengthDelimited(), "Value.List", (bytes) => {
        elements.push(readValue(bytes, depth + 1));
      });
      return { kind: "list", elements } as const;
    }
    case 12: {
      const entries: Array<[LfValue, LfValue]> = [];
      readRepeated(reader.readLengthDelimited(), "Value.Map", (bytes) => {
        let key: LfValue | undefined;
        const value = readEntry(
          bytes,
          "Value.Map.Entry",
          (entryReader) => {
            key = readValue(entryReader.readLengthDelimited(), depth + 1);
          },
          depth,
          true,
        );
        entries.push([key!, value]);
      });
      return { kind: "map", entries } as const;
    }
    case 13: {
      const fields: LfValue[] = [];
      readRepeated(reader.readLengthDelimited(), "Value.Record", (bytes) => {
        fields.push(readSingleValue(bytes, "Value.Record.Field", depth, true)!);
      });
      return { kind: "record", fields } as const;
    }
    case 14:
      return readVariant(reader.readLengthDelimited(), depth);
    case 15:
      return readEnum(reader.readLengthDelimited());
    case 16: {
      const entries: Array<[string, LfValue]> = [];
      readRepeated(reader.readLengthDelimited(), "Value.TextMap", (bytes) => {
        // proto3 omits an empty key, so a missing key is the empty text.
        let key = "";
        const value = readEntry(
          bytes,
          "Value.TextMap.Entry",
          (entryReader) => {
            key = entryReader.readString("key");
          },
          depth,
          false,
        );
        entries.push([key, value]);
      });
      return { kind: "textMap", entries } as const;
    }
    default:
      throw new BlobFormatError(`Value.${member} is not supported by this reader`);
  }
}

/** Reads one serialized `Value` message */
export function readValue(bytes: Uint8Array, depth = 0): LfValue {
  if (depth > LF_VALUE_MAX_NESTING)
    throw new BlobFormatError(`value nesting is deeper than ${LF_VALUE_MAX_NESTING}`);
  const reader = new ProtoReader(bytes, "Value");
  let value: LfValue | undefined;
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    if (value !== undefined) throw new BlobFormatError("Value has more than one member");
    value = readValueMember(reader, field, wireType, depth);
  }
  if (value === undefined) throw new BlobFormatError("Value has no member");
  return value;
}

/** Field order and types of a Daml data type, as its Daml source declares them */
export type LfType =
  | { kind: "party" }
  | { kind: "int64" }
  | { kind: "text" }
  | { kind: "bool" }
  | { kind: "numeric" }
  | { kind: "timestamp" }
  | { kind: "contractId" }
  /** A Wormhole.Core.Bytes type: a single-constructor variant of Text, named like its type */
  | { kind: "bytes"; typeName: string }
  | { kind: "optional"; of: LfType }
  | { kind: "list"; of: LfType }
  | { kind: "map"; key: LfType; value: LfType }
  | { kind: "record"; name: string; fields: ReadonlyArray<readonly [string, LfType]> }
  /** A Daml enum: a data type whose constructors carry no value */
  | { kind: "enum"; name: string; constructors: readonly string[] }
  /** A Daml variant whose constructors each carry one value, by constructor name */
  | { kind: "variant"; name: string; constructors: Readonly<Record<string, LfType>> };

/** Builders of LfType values */
export const lfType = {
  party: { kind: "party" } as LfType,
  int64: { kind: "int64" } as LfType,
  text: { kind: "text" } as LfType,
  bool: { kind: "bool" } as LfType,
  numeric: { kind: "numeric" } as LfType,
  timestamp: { kind: "timestamp" } as LfType,
  contractId: { kind: "contractId" } as LfType,
  bytes: (typeName: string): LfType => ({ kind: "bytes", typeName }),
  optional: (of: LfType): LfType => ({ kind: "optional", of }),
  list: (of: LfType): LfType => ({ kind: "list", of }),
  map: (key: LfType, value: LfType): LfType => ({ kind: "map", key, value }),
  record: (name: string, fields: ReadonlyArray<readonly [string, LfType]>): LfType => ({
    kind: "record",
    name,
    fields,
  }),
  enum: (name: string, constructors: readonly string[]): LfType => ({
    kind: "enum",
    name,
    constructors,
  }),
  variant: (name: string, constructors: Readonly<Record<string, LfType>>): LfType => ({
    kind: "variant",
    name,
    constructors,
  }),
};

function kindMismatch(path: string, expected: string, value: LfValue): never {
  throw new BlobFormatError(`${path}: expected ${expected}, found ${value.kind}`);
}

const MICROS_PER_MILLI = 1000n;

/** ISO 8601 text of a Daml Time; precision below one millisecond is dropped */
function timestampText(micros: bigint, path: string): string {
  const millis = micros / MICROS_PER_MILLI - (micros % MICROS_PER_MILLI < 0n ? 1n : 0n);
  const time = new Date(Number(millis));
  if (Number.isNaN(time.getTime()))
    throw new BlobFormatError(`${path}: timestamp ${micros} is out of range`);
  return time.toISOString();
}

/**
 * Converts a decoded value to the JSON Ledger API encoding of the type (codec.ts), so one decoder
 * serves a served payload and a create argument read from a blob. Record fields take their labels
 * from the type; a record may omit trailing Optional fields (normalization drops trailing Nones),
 * which become null. Every other difference between the value and the type throws.
 */
export function lfValueToJson(value: LfValue, type: LfType, path = "value"): DamlJson {
  switch (type.kind) {
    case "party":
      if (value.kind !== "party") kindMismatch(path, "a party", value);
      return value.value;
    case "int64":
      if (value.kind !== "int64") kindMismatch(path, "an Int", value);
      return value.value.toString();
    case "text":
      if (value.kind !== "text") kindMismatch(path, "a Text", value);
      return value.value;
    case "bool":
      if (value.kind !== "bool") kindMismatch(path, "a Bool", value);
      return value.value;
    case "numeric":
      if (value.kind !== "numeric") kindMismatch(path, "a Numeric", value);
      return value.value;
    case "timestamp":
      if (value.kind !== "timestamp") kindMismatch(path, "a Time", value);
      return timestampText(value.micros, path);
    case "contractId":
      if (value.kind !== "contractId") kindMismatch(path, "a ContractId", value);
      return value.value;
    case "bytes":
      if (value.kind !== "variant") kindMismatch(path, `a ${type.typeName} variant`, value);
      if (value.constructor !== type.typeName)
        throw new BlobFormatError(
          `${path}: expected constructor ${type.typeName}, found ${value.constructor}`,
        );
      if (value.value.kind !== "text") kindMismatch(`${path}.value`, "a Text", value.value);
      return { tag: type.typeName, value: value.value.value };
    case "optional":
      if (type.of.kind === "optional")
        throw new BlobFormatError(`${path}: nested Optional values are not supported`);
      if (value.kind !== "optional") kindMismatch(path, "an Optional", value);
      return value.value === undefined ? null : lfValueToJson(value.value, type.of, path);
    case "list":
      if (value.kind !== "list") kindMismatch(path, "a List", value);
      return value.elements.map((element, index) =>
        lfValueToJson(element, type.of, `${path}[${index}]`),
      );
    case "map":
      if (value.kind !== "map") kindMismatch(path, "a Map", value);
      return value.entries.map(([key, entry], index) => [
        lfValueToJson(key, type.key, `${path}[${index}].key`),
        lfValueToJson(entry, type.value, `${path}[${index}].value`),
      ]);
    case "record":
      return recordToJson(value, type, path);
    case "enum":
      // The JSON Ledger API writes an enum value as its constructor name.
      if (value.kind !== "enum") kindMismatch(path, `a ${type.name} enum`, value);
      if (!type.constructors.includes(value.constructor))
        throw new BlobFormatError(
          `${path}: ${type.name} has no constructor ${value.constructor.slice(0, 80)}`,
        );
      return value.constructor;
    case "variant": {
      // The JSON Ledger API writes a variant value as {"tag": <constructor>, "value": <value>}.
      if (value.kind !== "variant") kindMismatch(path, `a ${type.name} variant`, value);
      const constructorType = Object.prototype.hasOwnProperty.call(
        type.constructors,
        value.constructor,
      )
        ? type.constructors[value.constructor]
        : undefined;
      if (constructorType === undefined)
        throw new BlobFormatError(
          `${path}: ${type.name} has no constructor ${value.constructor.slice(0, 80)}`,
        );
      return {
        tag: value.constructor,
        value: lfValueToJson(value.value, constructorType, `${path}.${value.constructor}`),
      };
    }
  }
}

function recordToJson(
  value: LfValue,
  type: Extract<LfType, { kind: "record" }>,
  path: string,
): DamlJson {
  if (value.kind !== "record") kindMismatch(path, `a ${type.name} record`, value);
  if (value.fields.length > type.fields.length)
    throw new BlobFormatError(
      `${path}: ${type.name} has ${type.fields.length} fields, found ${value.fields.length}`,
    );
  const json: { [field: string]: DamlJson } = {};
  type.fields.forEach(([fieldName, fieldType], index) => {
    const fieldPath = `${path}.${fieldName}`;
    const fieldValue = value.fields[index];
    if (fieldValue !== undefined) {
      json[fieldName] = lfValueToJson(fieldValue, fieldType, fieldPath);
      return;
    }
    if (fieldType.kind !== "optional")
      throw new BlobFormatError(
        `${path}: ${type.name} has ${value.fields.length} fields; field ${fieldName} is missing ` +
          `and only trailing Optional fields may be omitted`,
      );
    json[fieldName] = null;
  });
  return json;
}

/** Decodes a serialized create argument (blob.ts `createArgument`) as the JSON of a record type */
export function createArgumentToJson(createArgument: Uint8Array, type: LfType): DamlJson {
  if (type.kind !== "record") throw new Error("A create argument is a record");
  return lfValueToJson(readValue(createArgument), type, type.name);
}
