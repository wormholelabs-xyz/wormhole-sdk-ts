import { encoding } from "@wormhole-foundation/sdk-connect";
import type { AnchorStrategy } from "../../src/anchor.js";
import {
  BlobEnvelopeAnchor,
  checkDisclosedContract,
  checkDisclosedContracts,
  checkPinnedPackage,
} from "../../src/anchor.js";
import { BlobFormatError, readCreatedEventBlob } from "../../src/blob.js";
import type { DisclosedContract } from "../../src/disclosure.js";

// Hand-written protobuf encoding of the blob envelope (transaction.proto, value.proto).

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
const bytesField = (field: number, bytes: number[] | Uint8Array) => [
  ...tag(field, 2),
  ...varint(bytes.length),
  ...bytes,
];
const stringField = (field: number, text: string) => bytesField(field, encoding.bytes.encode(text));
const fixed64Field = (field: number, value: bigint) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return [...tag(field, 1), ...bytes];
};

const PACKAGE_ID = "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371";
const OTHER_PACKAGE_ID = "ef".repeat(32);
const GG = `guardianGovernance::1220${"aa".repeat(32)}`;
const FEE = `feeCustody::1220${"bb".repeat(32)}`;
const ROGUE = `rogue::1220${"cc".repeat(32)}`;
const OBSERVER = `observer::1220${"dd".repeat(32)}`;
const CONTRACT_ID = `00${"12".repeat(32)}ca111220${"34".repeat(32)}`;
const TEMPLATE_ID = `${PACKAGE_ID}:Wormhole.Core.State:CoreState`;

function identifier(packageId: string, module: string[], name: string[]): number[] {
  return [
    ...stringField(1, packageId),
    ...module.flatMap((segment) => stringField(2, segment)),
    ...name.flatMap((segment) => stringField(3, segment)),
  ];
}

interface FatOptions {
  contractId?: string;
  packageId?: string;
  signatories?: string[];
  stakeholders?: string[];
  keyMaintainers?: string[];
  extra?: number[];
  omitTemplate?: boolean;
  omitCreateArgument?: boolean;
}

function fatContractInstance(options: FatOptions = {}): number[] {
  return [
    ...bytesField(1, encoding.hex.decode(options.contractId ?? CONTRACT_ID)),
    ...stringField(2, "wormhole-core"),
    ...(options.omitTemplate
      ? []
      : bytesField(
          3,
          identifier(options.packageId ?? PACKAGE_ID, ["Wormhole", "Core", "State"], ["CoreState"]),
        )),
    // An opaque create argument: the envelope reader must not look into it.
    ...(options.omitCreateArgument ? [] : bytesField(4, [0x0a, 0x03, 0xff, 0xfe, 0xfd])),
    ...(options.signatories ?? [FEE, GG].sort()).flatMap((party) => stringField(5, party)),
    ...(options.stakeholders ?? []).flatMap((party) => stringField(6, party)),
    ...fixed64Field(7, 1_732_000_000_000_000n),
    ...bytesField(8, [0x01, 0x02]),
    // package_version 1.2.3, packed
    ...bytesField(9, [...varint(1), ...varint(2), ...varint(3)]),
    ...(options.keyMaintainers
      ? bytesField(1001, [
          ...bytesField(1, [0x00]),
          ...options.keyMaintainers.flatMap((party) => stringField(2, party)),
          ...bytesField(3, new Uint8Array(32)),
        ])
      : []),
    ...(options.extra ?? []),
  ];
}

function versioned(payload: number[], version = "2.1", extra: number[] = []): Uint8Array {
  return new Uint8Array([...stringField(1, version), ...bytesField(2, payload), ...extra]);
}

function blob(options: FatOptions = {}, version = "2.1"): string {
  return encoding.b64.encode(versioned(fatContractInstance(options), version));
}

function disclosed(overrides: Partial<DisclosedContract> = {}): DisclosedContract {
  return {
    role: "CoreState",
    templateId: TEMPLATE_ID,
    contractId: CONTRACT_ID,
    createdEventBlob: blob(),
    synchronizerId: "global-domain::1220aa",
    ...overrides,
  };
}

describe("readCreatedEventBlob", () => {
  it("reads contract id, template id and signatories", () => {
    expect(readCreatedEventBlob(blob({ stakeholders: [OBSERVER] }))).toEqual({
      version: "2.1",
      contractId: CONTRACT_ID,
      packageName: "wormhole-core",
      templateId: TEMPLATE_ID,
      signatories: [FEE, GG].sort(),
      nonSignatoryStakeholders: [OBSERVER],
      createArgument: new Uint8Array([0x0a, 0x03, 0xff, 0xfe, 0xfd]),
    });
  });

  it("rejects a blob without a create argument", () => {
    expect(() => readCreatedEventBlob(blob({ omitCreateArgument: true }))).toThrow(
      /no create argument/,
    );
  });

  it("accepts bytes, other known versions and unpacked package versions", () => {
    const bytes = versioned(fatContractInstance({ extra: [...tag(9, 0), ...varint(-1)] }), "3");
    const envelope = readCreatedEventBlob(bytes);
    expect(envelope.version).toBe("3");
    expect(envelope.signatories).toContain(GG);
  });

  it("counts key maintainers as signatories", () => {
    const envelope = readCreatedEventBlob(blob({ signatories: [FEE], keyMaintainers: [GG] }, "2"));
    expect(envelope.signatories).toEqual([FEE, GG].sort());
  });

  it("does not depend on field order", () => {
    const fields = fatContractInstance();
    const reordered = [
      ...stringField(2, "wormhole-core"),
      ...bytesField(1, encoding.hex.decode(CONTRACT_ID)),
    ];
    const rest = fatContractInstance().slice(
      bytesField(1, encoding.hex.decode(CONTRACT_ID)).length +
        stringField(2, "wormhole-core").length,
    );
    expect(readCreatedEventBlob(versioned([...reordered, ...rest]))).toEqual(
      readCreatedEventBlob(versioned(fields)),
    );
  });

  const failures: Array<[string, () => string | Uint8Array, RegExp]> = [
    ["empty text", () => "", /not base64/],
    ["not base64", () => "%%%%", /not base64/],
    ["unknown version", () => blob({}, "dev"), /unknown serialization version "dev"/],
    [
      "no version",
      () => new Uint8Array(bytesField(2, fatContractInstance())),
      /unknown serialization version ""/,
    ],
    [
      "empty payload",
      () => new Uint8Array([...stringField(1, "2.1"), ...bytesField(2, [])]),
      /empty payload/,
    ],
    [
      "unknown Versioned field",
      () => versioned(fatContractInstance(), "2.1", stringField(3, "x")),
      /Versioned has unknown field 3/,
    ],
    [
      "unknown FatContractInstance field",
      () => versioned(fatContractInstance({ extra: stringField(10, "x") })),
      /unknown field 10/,
    ],
    [
      "repeated template id",
      () =>
        versioned(
          fatContractInstance({ extra: bytesField(3, identifier(OTHER_PACKAGE_ID, ["M"], ["E"])) }),
        ),
      /template_id appears more than once/,
    ],
    [
      "repeated contract id",
      () => versioned(fatContractInstance({ extra: bytesField(1, [0]) })),
      /contract_id appears more than once/,
    ],
    [
      "wrong wire type",
      () => versioned(fatContractInstance({ extra: [...tag(5, 0), 1] })),
      /wire type 0, expected 2/,
    ],
    [
      "group wire type",
      () => versioned(fatContractInstance({ extra: [...tag(11, 3)] })),
      /unknown field 11/,
    ],
    [
      "truncated length",
      () => versioned(fatContractInstance({ extra: [...tag(6, 2), 0x7f] })),
      /past the end/,
    ],
    [
      "truncated varint",
      () => versioned(fatContractInstance({ extra: [...tag(9, 0), 0x80] })),
      /truncated varint/,
    ],
    [
      "repeated created_at",
      () => versioned(fatContractInstance({ extra: fixed64Field(7, 0n) })),
      /created_at appears more than once/,
    ],
    [
      "truncated fixed64",
      () => versioned([...bytesField(1, encoding.hex.decode(CONTRACT_ID)), ...tag(7, 1), 0, 0]),
      /truncated fixed-width/,
    ],
    [
      "no template id",
      () => versioned(fatContractInstance({ omitTemplate: true })),
      /no template id/,
    ],
    [
      "bad template package id",
      () => versioned(fatContractInstance({ packageId: "abc" })),
      /not 64 hex/,
    ],
    ["no signatory", () => versioned(fatContractInstance({ signatories: [] })), /no signatory/],
    [
      "unordered signatories",
      () => versioned(fatContractInstance({ signatories: [GG, FEE] })),
      /not strictly ordered/,
    ],
    [
      "duplicate signatory",
      () => versioned(fatContractInstance({ signatories: [GG, GG] })),
      /not strictly ordered/,
    ],
    [
      "invalid party",
      () => versioned(fatContractInstance({ signatories: ["a/b"] })),
      /invalid party/,
    ],
    [
      "signatory that is also a stakeholder",
      () => versioned(fatContractInstance({ stakeholders: [GG] })),
      /both a signatory and a non-signatory/,
    ],
    [
      "maintainer that is also a signatory",
      () => versioned(fatContractInstance({ signatories: [GG], keyMaintainers: [GG] })),
      /both a maintainer/,
    ],
    [
      "key without maintainers",
      () => versioned(fatContractInstance({ keyMaintainers: [] })),
      /no maintainers/,
    ],
    [
      "invalid UTF-8",
      () => versioned(fatContractInstance({ extra: [...tag(5, 2), 1, 0xff] })),
      /not UTF-8/,
    ],
  ];

  it.each(failures)("fails closed: %s", (_name, make, message) => {
    let error: unknown;
    try {
      readCreatedEventBlob(make());
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(BlobFormatError);
    expect((error as Error).message).toMatch(message);
  });
});

describe("anchor checks", () => {
  const policy = { guardianGovernance: GG, packageIds: [PACKAGE_ID] };

  it("accepts a contract of the pinned package signed by guardianGovernance", async () => {
    await expect(checkDisclosedContract(disclosed(), policy)).resolves.toBeUndefined();
    expect(await checkDisclosedContracts([disclosed()], policy)).toHaveLength(1);
  });

  it("accepts the retiring package id", async () => {
    const contract = disclosed({
      templateId: `${OTHER_PACKAGE_ID}:Wormhole.Core.State:CoreState`,
      createdEventBlob: blob({ packageId: OTHER_PACKAGE_ID }),
    });
    await expect(checkDisclosedContract(contract, policy)).rejects.toThrow(/pinned/);
    await expect(
      checkDisclosedContract(contract, { ...policy, packageIds: [PACKAGE_ID, OTHER_PACKAGE_ID] }),
    ).resolves.toBeUndefined();
  });

  it("rejects a package-name template reference", () => {
    expect(() =>
      checkPinnedPackage(
        disclosed({ templateId: "#wormhole-core:Wormhole.Core.State:CoreState" }),
        [PACKAGE_ID],
      ),
    ).toThrow(/64 lowercase hex/);
    expect(() => checkPinnedPackage(disclosed(), [])).toThrow(/No pinned package/);
  });

  it("rejects a rogue CoreState that guardianGovernance does not sign", async () => {
    const rogue = disclosed({ createdEventBlob: blob({ signatories: [FEE, ROGUE].sort() }) });
    await expect(checkDisclosedContract(rogue, policy)).rejects.toThrow(`is not signed by ${GG}`);
  });

  it("rejects a blob of another contract or template", async () => {
    await expect(
      checkDisclosedContract(disclosed({ contractId: `00${"99".repeat(32)}` }), policy),
    ).rejects.toThrow(/the blob is for contract/);
    await expect(
      checkDisclosedContract(
        disclosed({ templateId: `${PACKAGE_ID}:Wormhole.Core.State:EmitterRegistry` }),
        policy,
      ),
    ).rejects.toThrow(/the blob has template/);
  });

  it("rejects an unreadable blob", async () => {
    await expect(
      checkDisclosedContract(disclosed({ createdEventBlob: blob({}, "dev") }), policy),
    ).rejects.toThrow(BlobFormatError);
  });

  it("another strategy can replace the envelope check", async () => {
    const checked: string[] = [];
    const strategy: AnchorStrategy = {
      async checkSignatory(contract, requiredSignatory) {
        checked.push(`${contract.role}:${requiredSignatory}`);
      },
    };
    const contract = disclosed({ createdEventBlob: "not a blob" });
    await expect(checkDisclosedContract(contract, policy, strategy)).resolves.toBeUndefined();
    expect(checked).toEqual([`CoreState:${GG}`]);
    // The package pin applies whatever the strategy.
    await expect(
      checkDisclosedContract(
        disclosed({ templateId: `${OTHER_PACKAGE_ID}:Wormhole.Core.State:CoreState` }),
        policy,
        strategy,
      ),
    ).rejects.toThrow(/pinned/);
    expect(new BlobEnvelopeAnchor()).toBeDefined();
  });
});
