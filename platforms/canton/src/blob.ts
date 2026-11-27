// Reader of the created event blob envelope.
//
// The Ledger API documents the blob as opaque. Canton 3.x builds it with
// ContractInstanceCoder.encodeFatContractInstance (daml-lf/transaction): a protobuf `Versioned`
// whose `payload` is a protobuf `FatContractInstance` (transaction.proto):
//
//   message Versioned { string version = 1; bytes payload = 2; }
//   message FatContractInstance {
//     bytes contract_id = 1;  string package_name = 2;  repeated int32 package_version = 9;
//     Identifier template_id = 3;  bytes create_arg = 4;
//     repeated string non_maintainer_signatories = 5;  repeated string non_signatory_stakeholders = 6;
//     sfixed64 created_at = 7;  bytes authentication_data = 8;
//     KeyWithMaintainers contract_key_with_maintainers = 1001;
//   }
//   message Identifier { string package_id = 1; repeated string module_name = 2; repeated string name = 3; }
//   message KeyWithMaintainers { bytes key = 1; repeated string maintainers = 2; bytes hash = 3; }
//
// The signatories are the key maintainers plus non_maintainer_signatories. This reader returns
// the contract id, template id and signatories, and create_arg as undecoded bytes (lfValue.ts
// decodes them). It does not decode the key value.
// It fails closed: an unknown field, an unknown version, a repeated singular field, a wrong wire
// type, trailing bytes or an invalid party each throw, as a Canton upgrade can change the format.
import { encoding } from "@wormhole-foundation/sdk-connect";

/** Serialization versions of Canton 3.x (SerializationVersion "2.1", "2" and "3") */
export const KNOWN_BLOB_VERSIONS: readonly string[] = ["2.1", "2", "3"];

/** What the envelope of a created event blob says about the contract */
export interface CreatedEventBlobEnvelope {
  /** The serialization version string of the `Versioned` wrapper */
  version: string;
  /** The contract id, lowercase hex as the Ledger API writes it */
  contractId: string;
  packageName: string;
  /** "<package id>:<module>:<entity>" */
  templateId: string;
  /** Key maintainers and non-maintainer signatories, sorted */
  signatories: string[];
  nonSignatoryStakeholders: string[];
  /** create_arg: the serialized Daml-LF value of the create argument, undecoded (see lfValue.ts) */
  createArgument: Uint8Array;
}

/** A reader failure: the blob is not an envelope this reader can vouch for */
export class BlobFormatError extends Error {
  constructor(message: string) {
    super(`created event blob: ${message}`);
    this.name = "BlobFormatError";
  }
}

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH_DELIMITED = 2;

// A Ref.Party: a PartyIdString of the Ledger API.
const LEDGER_PARTY_PATTERN = /^[A-Za-z0-9:\-_ ]{1,255}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A minimal protobuf reader over one message */
export class ProtoReader {
  private position = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly messageName: string,
  ) {}

  done(): boolean {
    return this.position >= this.bytes.length;
  }

  readVarint(): bigint {
    let result = 0n;
    for (let index = 0; index < 10; index++) {
      if (this.position >= this.bytes.length)
        throw new BlobFormatError(`${this.messageName}: truncated varint`);
      const byte = this.bytes[this.position++]!;
      if (index === 9 && byte > 1)
        throw new BlobFormatError(`${this.messageName}: varint above 64 bits`);
      result |= BigInt(byte & 0x7f) << BigInt(7 * index);
      if ((byte & 0x80) === 0) return result;
    }
    throw new BlobFormatError(`${this.messageName}: varint longer than 10 bytes`);
  }

  readTag(): { field: number; wireType: number } {
    const tag = this.readVarint();
    if (tag > 0xffffffffn) throw new BlobFormatError(`${this.messageName}: tag above 32 bits`);
    const field = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (field === 0) throw new BlobFormatError(`${this.messageName}: field number 0`);
    return { field, wireType };
  }

  readLengthDelimited(): Uint8Array {
    const length = this.readVarint();
    if (length > BigInt(this.bytes.length - this.position))
      throw new BlobFormatError(`${this.messageName}: length ${length} past the end`);
    const start = this.position;
    this.position += Number(length);
    return this.bytes.subarray(start, this.position);
  }

  readString(fieldName: string): string {
    try {
      return utf8.decode(this.readLengthDelimited());
    } catch (err) {
      if (err instanceof BlobFormatError) throw err;
      throw new BlobFormatError(`${this.messageName}.${fieldName}: not UTF-8`);
    }
  }

  /** A little-endian signed 64-bit value (wire type 1: sfixed64) */
  readFixed64(): bigint {
    if (this.position + 8 > this.bytes.length)
      throw new BlobFormatError(`${this.messageName}: truncated fixed-width field`);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.position, 8);
    this.position += 8;
    return view.getBigInt64(0, true);
  }

  skipFixed(byteCount: number): void {
    if (this.position + byteCount > this.bytes.length)
      throw new BlobFormatError(`${this.messageName}: truncated fixed-width field`);
    this.position += byteCount;
  }
}

/** Rejects a second occurrence of a singular field */
export class SeenFields {
  private readonly seen = new Set<number>();
  constructor(private readonly messageName: string) {}
  once(field: number, fieldName: string): void {
    if (this.seen.has(field))
      throw new BlobFormatError(`${this.messageName}.${fieldName} appears more than once`);
    this.seen.add(field);
  }
}

export function expectWireType(
  messageName: string,
  fieldName: string,
  actual: number,
  expected: number,
): void {
  if (actual !== expected)
    throw new BlobFormatError(
      `${messageName}.${fieldName} has wire type ${actual}, expected ${expected}`,
    );
}

export function unknownField(messageName: string, field: number): never {
  throw new BlobFormatError(`${messageName} has unknown field ${field}`);
}

function readVersioned(bytes: Uint8Array): { version: string; payload: Uint8Array } {
  const name = "Versioned";
  const reader = new ProtoReader(bytes, name);
  const seen = new SeenFields(name);
  let version: string | undefined;
  let payload: Uint8Array | undefined;
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    switch (field) {
      case 1:
        seen.once(field, "version");
        expectWireType(name, "version", wireType, WIRE_LENGTH_DELIMITED);
        version = reader.readString("version");
        break;
      case 2:
        seen.once(field, "payload");
        expectWireType(name, "payload", wireType, WIRE_LENGTH_DELIMITED);
        payload = reader.readLengthDelimited();
        break;
      default:
        unknownField(name, field);
    }
  }
  if (version === undefined || !KNOWN_BLOB_VERSIONS.includes(version))
    throw new BlobFormatError(`unknown serialization version ${JSON.stringify(version ?? "")}`);
  if (payload === undefined || payload.length === 0) throw new BlobFormatError("empty payload");
  return { version, payload };
}

function readIdentifier(bytes: Uint8Array): string {
  const name = "Identifier";
  const reader = new ProtoReader(bytes, name);
  const seen = new SeenFields(name);
  let packageId = "";
  const moduleName: string[] = [];
  const entityName: string[] = [];
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    switch (field) {
      case 1:
        seen.once(field, "package_id");
        expectWireType(name, "package_id", wireType, WIRE_LENGTH_DELIMITED);
        packageId = reader.readString("package_id");
        break;
      case 2:
        expectWireType(name, "module_name", wireType, WIRE_LENGTH_DELIMITED);
        moduleName.push(reader.readString("module_name"));
        break;
      case 3:
        expectWireType(name, "name", wireType, WIRE_LENGTH_DELIMITED);
        entityName.push(reader.readString("name"));
        break;
      default:
        unknownField(name, field);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(packageId))
    throw new BlobFormatError(`template package id ${JSON.stringify(packageId)} is not 64 hex`);
  const segment = /^[A-Za-z$_][A-Za-z0-9$_]*$/;
  if (moduleName.length === 0 || entityName.length === 0)
    throw new BlobFormatError("template id has no module or no name");
  if (![...moduleName, ...entityName].every((part) => segment.test(part)))
    throw new BlobFormatError("template id has an invalid name segment");
  return `${packageId}:${moduleName.join(".")}:${entityName.join(".")}`;
}

function readKeyMaintainers(bytes: Uint8Array): string[] {
  const name = "KeyWithMaintainers";
  const reader = new ProtoReader(bytes, name);
  const seen = new SeenFields(name);
  const maintainers: string[] = [];
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    switch (field) {
      case 1:
        seen.once(field, "key");
        expectWireType(name, "key", wireType, WIRE_LENGTH_DELIMITED);
        reader.readLengthDelimited();
        break;
      case 2:
        expectWireType(name, "maintainers", wireType, WIRE_LENGTH_DELIMITED);
        maintainers.push(reader.readString("maintainers"));
        break;
      case 3:
        seen.once(field, "hash");
        expectWireType(name, "hash", wireType, WIRE_LENGTH_DELIMITED);
        reader.readLengthDelimited();
        break;
      default:
        unknownField(name, field);
    }
  }
  if (maintainers.length === 0) throw new BlobFormatError("a contract key has no maintainers");
  return maintainers;
}

function skipPackageVersion(reader: ProtoReader, wireType: number): void {
  if (wireType === WIRE_VARINT) {
    reader.readVarint();
    return;
  }
  expectWireType("FatContractInstance", "package_version", wireType, WIRE_LENGTH_DELIMITED);
  const packed = new ProtoReader(reader.readLengthDelimited(), "package_version");
  while (!packed.done()) packed.readVarint();
}

/** Strictly ascending, valid ledger parties (the order Canton requires) */
function checkPartyList(fieldName: string, parties: readonly string[]): void {
  parties.forEach((party, index) => {
    if (!LEDGER_PARTY_PATTERN.test(party))
      throw new BlobFormatError(
        `${fieldName} holds an invalid party ${JSON.stringify(party.slice(0, 80))}`,
      );
    if (index > 0 && !(parties[index - 1]! < party))
      throw new BlobFormatError(`${fieldName} is not strictly ordered`);
  });
}

function readFatContractInstance(bytes: Uint8Array): Omit<CreatedEventBlobEnvelope, "version"> {
  const name = "FatContractInstance";
  const reader = new ProtoReader(bytes, name);
  const seen = new SeenFields(name);
  let contractId: Uint8Array | undefined;
  let packageName = "";
  let templateId: string | undefined;
  const nonMaintainerSignatories: string[] = [];
  const nonSignatoryStakeholders: string[] = [];
  let maintainers: string[] = [];
  let createArgument: Uint8Array | undefined;
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    switch (field) {
      case 1:
        seen.once(field, "contract_id");
        expectWireType(name, "contract_id", wireType, WIRE_LENGTH_DELIMITED);
        contractId = reader.readLengthDelimited();
        break;
      case 2:
        seen.once(field, "package_name");
        expectWireType(name, "package_name", wireType, WIRE_LENGTH_DELIMITED);
        packageName = reader.readString("package_name");
        break;
      case 3:
        seen.once(field, "template_id");
        expectWireType(name, "template_id", wireType, WIRE_LENGTH_DELIMITED);
        templateId = readIdentifier(reader.readLengthDelimited());
        break;
      case 4:
        seen.once(field, "create_arg");
        expectWireType(name, "create_arg", wireType, WIRE_LENGTH_DELIMITED);
        createArgument = reader.readLengthDelimited();
        break;
      case 5:
        expectWireType(name, "non_maintainer_signatories", wireType, WIRE_LENGTH_DELIMITED);
        nonMaintainerSignatories.push(reader.readString("non_maintainer_signatories"));
        break;
      case 6:
        expectWireType(name, "non_signatory_stakeholders", wireType, WIRE_LENGTH_DELIMITED);
        nonSignatoryStakeholders.push(reader.readString("non_signatory_stakeholders"));
        break;
      case 7:
        seen.once(field, "created_at");
        expectWireType(name, "created_at", wireType, WIRE_FIXED64);
        reader.skipFixed(8);
        break;
      case 8:
        seen.once(field, "authentication_data");
        expectWireType(name, "authentication_data", wireType, WIRE_LENGTH_DELIMITED);
        reader.readLengthDelimited();
        break;
      case 9:
        skipPackageVersion(reader, wireType);
        break;
      case 1001:
        seen.once(field, "contract_key_with_maintainers");
        expectWireType(name, "contract_key_with_maintainers", wireType, WIRE_LENGTH_DELIMITED);
        maintainers = readKeyMaintainers(reader.readLengthDelimited());
        break;
      default:
        unknownField(name, field);
    }
  }
  if (contractId === undefined || contractId.length === 0)
    throw new BlobFormatError("no contract id");
  if (packageName === "") throw new BlobFormatError("no package name");
  if (templateId === undefined) throw new BlobFormatError("no template id");
  if (createArgument === undefined || createArgument.length === 0)
    throw new BlobFormatError("no create argument");
  checkPartyList("non_maintainer_signatories", nonMaintainerSignatories);
  checkPartyList("non_signatory_stakeholders", nonSignatoryStakeholders);
  const sortedMaintainers = [...new Set(maintainers)].sort();
  checkPartyList("maintainers", sortedMaintainers);
  if (sortedMaintainers.some((party) => nonMaintainerSignatories.includes(party)))
    throw new BlobFormatError("a party is both a maintainer and a non-maintainer signatory");
  const signatories = [...sortedMaintainers, ...nonMaintainerSignatories].sort();
  if (signatories.length === 0) throw new BlobFormatError("no signatory");
  if (nonSignatoryStakeholders.some((party) => signatories.includes(party)))
    throw new BlobFormatError("a party is both a signatory and a non-signatory stakeholder");
  return {
    contractId: encoding.hex.encode(contractId),
    packageName,
    templateId,
    signatories,
    nonSignatoryStakeholders: [...nonSignatoryStakeholders],
    createArgument: createArgument.slice(),
  };
}

/**
 * Reads the envelope of a created event blob: its contract id, template id and signatories.
 * Accepts the base64 text the JSON Ledger API serves, or the bytes.
 */
export function readCreatedEventBlob(blob: string | Uint8Array): CreatedEventBlobEnvelope {
  let bytes: Uint8Array;
  if (typeof blob === "string") {
    if (blob.length === 0 || !encoding.b64.valid(blob)) throw new BlobFormatError("not base64");
    bytes = encoding.b64.decode(blob);
  } else {
    bytes = blob;
  }
  if (bytes.length === 0) throw new BlobFormatError("empty");
  const { version, payload } = readVersioned(bytes);
  return { version, ...readFatContractInstance(payload) };
}
