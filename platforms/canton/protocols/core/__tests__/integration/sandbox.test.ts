// Opt-in integration test against a Canton ledger with the JSON Ledger API, for example a local
// sandbox:
//
//   DPM_SDK_VERSION=3.7.3 dpm sandbox --json-api-port 7575        (from an empty directory)
//   CANTON_JSON_API_URL=http://localhost:7575 \
//   CANTON_CORE_DAR=<wormhole>/canton/core/.daml/dist/wormhole-core-0.12.3.dar npm test
//
// Skipped unless CANTON_JSON_API_URL is set. It allocates fresh parties, creates a core
// (CoreState, EmitterRegistry) under a fresh guardianGovernance and a rogue core under another
// party, then runs register, publish, parse and verify through the SDK with a publisher that is
// not a stakeholder of the CoreState. Optional: CANTON_TOKEN (bearer token), CANTON_USER_ID
// (default wormhole-sdk-test; a ledger without auth needs one on each submission),
// CANTON_FIXTURE_OUT (a file to write the recorded ledger responses to).
import { jest } from "@jest/globals";
import fs from "node:fs";
import type { Network, VAA } from "@wormhole-foundation/sdk-connect";
import {
  deserialize,
  encoding,
  keccak256,
  secp256k1,
  serialize,
} from "@wormhole-foundation/sdk-connect";
import { mocks } from "@wormhole-foundation/sdk-definitions/testing";
import type { CantonCommandEnvelope, DisclosedContract } from "@wormhole-foundation/sdk-canton";
import {
  AcsDisclosureSource,
  CORE_PACKAGE_ID_0_12_3,
  CantonLedgerClient,
  CantonLedgerError,
  CantonLocalSigner,
  CantonUnsignedTransaction,
  StaticDisclosureSource,
  createArgumentToJson,
  emitterAddress,
  readCreatedEventBlob,
  staticTokenProvider,
  transactionFormatFor,
} from "@wormhole-foundation/sdk-canton";
import { CORE_STATE_LAYOUT, CantonWormholeCore } from "../../src/index.js";

jest.setTimeout(180_000);

const LEDGER_URL = process.env["CANTON_JSON_API_URL"];
const CORE_DAR = process.env["CANTON_CORE_DAR"];
const TOKEN = process.env["CANTON_TOKEN"];
const USER_ID = process.env["CANTON_USER_ID"] ?? "wormhole-sdk-test";
const FIXTURE_OUT = process.env["CANTON_FIXTURE_OUT"];
const describeLedger = LEDGER_URL ? describe : describe.skip;

// A test guardian key; never a real guardian.
const GUARDIAN_PRIVATE_KEY = "cfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0";
const GUARDIAN_PUBLIC_KEY = encoding.hex.encode(
  secp256k1.getPublicKey(GUARDIAN_PRIVATE_KEY, false),
);
const GUARDIAN_ADDRESS = encoding.hex.encode(
  keccak256(secp256k1.getPublicKey(GUARDIAN_PRIVATE_KEY, false).slice(1)).slice(12),
);

const recorded: Record<string, unknown> = {};

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of generator) items.push(item);
  return items;
}

/** The outcome of a submission that should fail: HTTP status, error code and message excerpt */
function rejection(err: unknown): Record<string, unknown> {
  if (err instanceof CantonLedgerError) {
    const json = JSON.parse(err.body) as Record<string, unknown>;
    return {
      status: err.status,
      code: err.code,
      cause: String(json["cause"] ?? "").slice(0, 600),
      errorCategory: json["errorCategory"],
      grpcCodeValue: json["grpcCodeValue"],
    };
  }
  return { error: (err as Error).message.slice(0, 600) };
}

// Protobuf at field level, for the D9 spike: decode a message into its top-level fields and
// encode it again with changes.
interface ProtoField {
  field: number;
  wireType: number;
  data: Uint8Array;
}

function readVarint(bytes: Uint8Array, start: number): [bigint, number] {
  let value = 0n;
  let position = start;
  for (let shift = 0n; ; shift += 7n) {
    const byte = bytes[position++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, position];
  }
}

function writeVarint(value: bigint): number[] {
  const out: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0n);
  return out;
}

function decodeFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let position = 0;
  while (position < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, position);
    const field = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (wireType === 2) {
      const [length, afterLength] = readVarint(bytes, afterTag);
      const end = afterLength + Number(length);
      fields.push({ field, wireType, data: bytes.slice(afterLength, end) });
      position = end;
    } else if (wireType === 0) {
      const [, afterValue] = readVarint(bytes, afterTag);
      fields.push({ field, wireType, data: bytes.slice(afterTag, afterValue) });
      position = afterValue;
    } else if (wireType === 1) {
      fields.push({ field, wireType, data: bytes.slice(afterTag, afterTag + 8) });
      position = afterTag + 8;
    } else throw new Error(`wire type ${wireType}`);
  }
  return fields;
}

function encodeFields(fields: ProtoField[]): Uint8Array {
  const out: number[] = [];
  for (const { field, wireType, data } of fields) {
    out.push(...writeVarint(BigInt((field << 3) | wireType)));
    if (wireType === 2) out.push(...writeVarint(BigInt(data.length)));
    out.push(...data);
  }
  return new Uint8Array(out);
}

/** Rewrites the FatContractInstance inside a blob */
function alterBlob(blob: string, change: (fields: ProtoField[]) => ProtoField[]): string {
  const versioned = decodeFields(encoding.b64.decode(blob));
  const payload = versioned.find((entry) => entry.field === 2)!;
  payload.data = encodeFields(change(decodeFields(payload.data)));
  return encoding.b64.encode(encodeFields(versioned));
}

/** A deep copy: MockGuardians.addSignatures adds to the VAA it is given */
function copyOf(vaa: VAA<"Uint8Array">): VAA<"Uint8Array"> {
  return deserialize("Uint8Array", serialize(vaa));
}

/** Replaces the first field (guardianGovernance) of a serialized CoreState create argument */
function withFirstParty(createArgument: Uint8Array, partyId: string): Uint8Array {
  const value = decodeFields(createArgument);
  const record = value.find((entry) => entry.field === 13)!;
  const recordFields = decodeFields(record.data);
  recordFields[0]!.data = encodeFields([
    {
      field: 1,
      wireType: 2,
      data: encodeFields([{ field: 7, wireType: 2, data: new TextEncoder().encode(partyId) }]),
    },
  ]);
  record.data = encodeFields(recordFields);
  return encodeFields(value);
}

describeLedger("Canton core protocol on a ledger", () => {
  const ledger = new CantonLedgerClient({
    baseUrl: LEDGER_URL ?? "http://localhost:1",
    ...(TOKEN ? { tokenProvider: staticTokenProvider(TOKEN) } : {}),
  });
  const suffix = Date.now().toString(36);
  let synchronizerId: string;
  const party: Record<string, string> = {};
  let core: CantonWormholeCore<Network, "Canton">;
  let blobOnlyCore: CantonWormholeCore<Network, "Canton">;
  let acsSource: AcsDisclosureSource;
  let publisherSigner: CantonLocalSigner<Network, "Canton">;

  async function allocate(hint: string): Promise<string> {
    const response = (await ledger.request("POST", "/v2/parties", {
      partyIdHint: `${hint}-${suffix}`,
      identityProviderId: "",
    })) as { partyDetails: { party: string } };
    return response.partyDetails.party;
  }

  async function submitSetup(actAs: string[], command: unknown, label: string) {
    return ledger.submitAndWaitForTransaction(
      {
        commands: [command],
        commandId: `setup-${label}-${suffix}`,
        actAs,
        synchronizerId,
        userId: USER_ID,
      },
      transactionFormatFor(actAs),
    );
  }

  async function createCore(gg: string, fee: string, instrumentAdmin: string, label: string) {
    await submitSetup(
      [gg, fee],
      {
        CreateCommand: {
          templateId: "#wormhole-core:Wormhole.Core.State:CoreState",
          createArguments: {
            guardianGovernance: gg,
            chainId: "75",
            governanceChainId: "1",
            governanceContract: { tag: "EmitterAddress", value: `${"00".repeat(31)}04` },
            guardianSetIndex: "0",
            guardianSets: [
              [
                "0",
                {
                  members: [
                    {
                      address: { tag: "GuardianAddress", value: GUARDIAN_ADDRESS },
                      publicKey: { tag: "GuardianPublicKey", value: GUARDIAN_PUBLIC_KEY },
                    },
                  ],
                  expirationTime: null,
                },
              ],
            ],
            messageFee: "0",
            feeInstrument: { admin: instrumentAdmin, id: "TestCoin" },
            feeRecipient: fee,
            consumedGovernance: [],
            evictedGovernanceMaxTimestampSeconds: null,
          },
        },
      },
      `${label}-core-state`,
    );
    await submitSetup(
      [gg],
      {
        CreateCommand: {
          templateId: "#wormhole-core:Wormhole.Core.State:EmitterRegistry",
          createArguments: {
            guardianGovernance: gg,
            onboardingFeeAdmin: instrumentAdmin,
            registrationFee: "0",
            nextId: "0",
          },
        },
      },
      `${label}-emitter-registry`,
    );
  }

  function coreFor(gg: string, source: AcsDisclosureSource | StaticDisclosureSource) {
    return CantonWormholeCore.withOptions(
      "Devnet" as Network,
      "Canton",
      ledger,
      { coreBridge: gg },
      {
        disclosureSource: source,
      },
    );
  }

  beforeAll(async () => {
    if (CORE_DAR) {
      const upload = await fetch(new URL("v2/packages", `${LEDGER_URL}/`).href, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
        body: fs.readFileSync(CORE_DAR),
      });
      if (upload.status !== 200) throw new Error(`DAR upload: HTTP ${upload.status}`);
    }
    const synchronizers = await ledger.connectedSynchronizers();
    recorded["connectedSynchronizers"] = synchronizers;
    synchronizerId = synchronizers[0]!.synchronizerId;
    for (const hint of ["gg", "fee", "instrument", "publisher", "verifier", "rogue", "roguefee"])
      party[hint] = await allocate(hint);
    await createCore(party["gg"]!, party["fee"]!, party["instrument"]!, "real");
    await createCore(party["rogue"]!, party["roguefee"]!, party["instrument"]!, "rogue");
    acsSource = new AcsDisclosureSource({
      ledger,
      reader: party["gg"]!,
      guardianGovernance: party["gg"]!,
    });
    core = coreFor(party["gg"]!, acsSource);
    const blobOnly = (await acsSource.core()).map(({ payload: _payload, ...entry }) => entry);
    recorded["coreDisclosures"] = await acsSource.core();
    blobOnlyCore = coreFor(party["gg"]!, new StaticDisclosureSource({ core: blobOnly }));
    publisherSigner = new CantonLocalSigner("Canton", ledger, party["publisher"]!, {
      userId: USER_ID,
    });
  });

  afterAll(() => {
    if (FIXTURE_OUT)
      fs.writeFileSync(
        FIXTURE_OUT,
        JSON.stringify(
          recorded,
          (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
          2,
        ),
      );
  });

  it("reads fee and guardian set from served payloads and from blobs alike", async () => {
    for (const client of [core, blobOnlyCore]) {
      expect(await client.getMessageFee()).toBe(0n);
      expect(await client.getGuardianSetIndex()).toBe(0);
      expect(await client.getGuardianSet(0)).toEqual({
        index: 0,
        keys: [`0x${GUARDIAN_ADDRESS}`],
        expiry: 0n,
      });
    }
    const [coreState] = (await acsSource.core()).filter((entry) => entry.role === "CoreState");
    const envelope = readCreatedEventBlob(coreState!.createdEventBlob);
    expect(envelope.templateId).toBe(`${CORE_PACKAGE_ID_0_12_3}:Wormhole.Core.State:CoreState`);
    expect(envelope.signatories).toEqual([party["fee"], party["gg"]].sort());
  });

  it("refuses to publish without an emitter", async () => {
    await expect(collect(core.publishMessage(party["publisher"]!, "hello", 0, 0))).rejects.toThrow(
      /has no Emitter/,
    );
  });

  let firstEmitterId: bigint;

  it("registers an emitter for a publisher that is not a CoreState stakeholder", async () => {
    const txs = await collect(core.registerEmitter(party["publisher"]!));
    const [updateId] = await publisherSigner.signAndSend(txs);
    expect(updateId).toMatch(/^1220[0-9a-f]{64}$/);
    const emitters = await core.getEmitters(party["publisher"]!);
    expect(emitters).toHaveLength(1);
    firstEmitterId = emitters[0]!.emitterId;
    expect(emitters[0]!.sequence).toBe(0n);
    expect(
      emitters[0]!.address.equals(
        emitterAddress(party["gg"]!, party["publisher"]!, firstEmitterId),
      ),
    ).toBe(true);
    recorded["emitterActiveContracts"] = await ledger.request(
      "POST",
      "/v2/state/active-contracts",
      {
        eventFormat: {
          filtersByParty: {
            [party["publisher"]!]: {
              cumulative: [
                {
                  identifierFilter: {
                    TemplateFilter: {
                      value: {
                        templateId: "#wormhole-core:Wormhole.Core.State:Emitter",
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
        activeAtOffset: await ledger.ledgerEnd(),
      },
    );
  });

  let publishUpdateId: string;
  let publishedVaa: VAA<"Uint8Array">;

  it("publishes, then parses the message by update id", async () => {
    const payload = encoding.bytes.encode("canton sdk integration");
    const txs = await collect(blobOnlyCore.publishMessage(party["publisher"]!, payload, 7, 1));
    expect(txs).toHaveLength(1);
    [publishUpdateId] = (await publisherSigner.signAndSend(txs)) as [string];
    recorded["publishUpdateById"] = await ledger.request("POST", "/v2/updates/update-by-id", {
      updateId: publishUpdateId,
      updateFormat: { includeTransactions: transactionFormatFor([party["publisher"]!]) },
    });

    const expectedEmitter = emitterAddress(party["gg"]!, party["publisher"]!, firstEmitterId);
    const ids = await core.parseTransaction(publishUpdateId, party["publisher"]!);
    expect(ids).toHaveLength(1);
    expect(ids[0]!.emitter.equals(expectedEmitter)).toBe(true);
    expect(ids[0]!.sequence).toBe(0n);

    // The guardians' view: guardianGovernance reads the same transaction.
    const asGovernance = await core.parseTransaction(publishUpdateId, party["gg"]!);
    expect(asGovernance).toEqual(ids);

    const vaas = await core.parseMessages(publishUpdateId, party["publisher"]!);
    expect(vaas).toHaveLength(1);
    publishedVaa = vaas[0]!;
    expect(publishedVaa.nonce).toBe(7);
    expect(publishedVaa.consistencyLevel).toBe(1);
    expect(encoding.bytes.decode(publishedVaa.payload)).toBe("canton sdk integration");
    expect(publishedVaa.timestamp).toBeGreaterThan(1_700_000_000);
  });

  it("parses for any party when no reader is named", async () => {
    let outcome: unknown;
    try {
      outcome = await core.parseTransaction(publishUpdateId);
    } catch (err) {
      outcome = rejection(err);
    }
    recorded["parseAnyParty"] = outcome;
    expect(Array.isArray(outcome)).toBe(true);
  });

  it("verifies a VAA signed by the guardian set, and rejects a bad one", async () => {
    const guardians = new mocks.MockGuardians(0, [GUARDIAN_PRIVATE_KEY]);
    const signed = guardians.addSignatures(copyOf(publishedVaa), [0]) as VAA<"Uint8Array">;
    const verifier = new CantonLocalSigner("Canton", ledger, party["verifier"]!, {
      userId: USER_ID,
    });
    const [updateId] = await verifier.signAndSend(
      await collect(core.verifyMessage(party["verifier"]!, signed)),
    );
    expect(updateId).toMatch(/^1220/);

    const unsigned = serialize(publishedVaa);
    let outcome: unknown = "accepted";
    try {
      await verifier.signAndSend(
        await collect(core.verifyMessage(party["verifier"]!, { ...publishedVaa, signatures: [] })),
      );
    } catch (err) {
      outcome = rejection(err);
    }
    recorded["verifyWithoutQuorum"] = outcome;
    expect(outcome).not.toBe("accepted");
    expect(unsigned.length).toBeGreaterThan(57);
  });

  it("rebuilds a publish whose Emitter another publish consumed", async () => {
    const [stale] = await collect(core.publishMessage(party["publisher"]!, "stale", 1, 0));
    await publisherSigner.signAndSend(
      await collect(core.publishMessage(party["publisher"]!, "fresh", 2, 0)),
    );
    const noRebuild = new CantonLocalSigner("Canton", ledger, party["publisher"]!, {
      userId: USER_ID,
      maxAttempts: 1,
    });
    let outcome: unknown = "accepted";
    try {
      await noRebuild.signAndSend([stale!]);
    } catch (err) {
      outcome = rejection(err);
    }
    recorded["staleEmitter"] = outcome;
    expect(outcome).not.toBe("accepted");

    let rebuilt: CantonCommandEnvelope | undefined;
    const original = stale as CantonUnsignedTransaction<Network, "Canton">;
    const watched = new CantonUnsignedTransaction(
      original.transaction,
      original.network,
      original.chain,
      original.description,
      false,
      async () => (rebuilt = await original.rebuild!()),
    );
    const [updateId] = await publisherSigner.signAndSend([watched]);
    expect(rebuilt).toBeDefined();
    const ids = await core.parseTransaction(updateId!, party["publisher"]!);
    expect(ids.map((id) => id.sequence)).toEqual([2n]);
  });

  it("selects among several emitters only with an explicit emitter id", async () => {
    await publisherSigner.signAndSend(await collect(core.registerEmitter(party["publisher"]!)));
    const emitters = await core.getEmitters(party["publisher"]!);
    expect(emitters).toHaveLength(2);
    await expect(collect(core.publishMessage(party["publisher"]!, "x", 0, 0))).rejects.toThrow(
      /has 2 Emitters/,
    );
    const second = emitters[1]!.emitterId;
    const [updateId] = await publisherSigner.signAndSend(
      await collect(core.publishMessage(party["publisher"]!, "x", 0, 0, { emitterId: second })),
    );
    const ids = await core.parseTransaction(updateId!, party["publisher"]!);
    expect(ids[0]!.emitter.equals(emitterAddress(party["gg"]!, party["publisher"]!, second))).toBe(
      true,
    );
  });

  describe("rogue core under another guardianGovernance", () => {
    let rogueEntries: DisclosedContract[];

    beforeAll(async () => {
      rogueEntries = await new AcsDisclosureSource({
        ledger,
        reader: party["rogue"]!,
        guardianGovernance: party["rogue"]!,
      }).core();
    });

    it("rejects a rogue CoreState and EmitterRegistry in every anchored path", async () => {
      const fooled = coreFor(party["gg"]!, new StaticDisclosureSource({ core: rogueEntries }));
      await expect(fooled.getMessageFee()).rejects.toThrow(/is not signed by/);
      await expect(collect(fooled.publishMessage(party["publisher"]!, "x", 0, 0))).rejects.toThrow(
        /is not signed by/,
      );
      await expect(collect(fooled.registerEmitter(party["publisher"]!))).rejects.toThrow(
        /is not signed by/,
      );
      await expect(collect(fooled.verifyMessage(party["verifier"]!, publishedVaa))).rejects.toThrow(
        /is not signed by/,
      );
    });

    it("rejects a disclosed entry whose template carries an unpinned package id", async () => {
      const entries = (await acsSource.core()).map((entry) => ({
        ...entry,
        templateId: entry.templateId.replace(CORE_PACKAGE_ID_0_12_3, "ab".repeat(32)),
      }));
      const unpinned = coreFor(party["gg"]!, new StaticDisclosureSource({ core: entries }));
      await expect(unpinned.getMessageFee()).rejects.toThrow(/pinned/);
    });

    it("drops a message whose registrar is not the configured guardianGovernance", async () => {
      const rogueCore = coreFor(
        party["rogue"]!,
        new StaticDisclosureSource({ core: rogueEntries }),
      );
      await publisherSigner.signAndSend(
        await collect(rogueCore.registerEmitter(party["publisher"]!)),
      );
      const [updateId] = await publisherSigner.signAndSend(
        await collect(rogueCore.publishMessage(party["publisher"]!, "rogue", 0, 0)),
      );
      expect(await rogueCore.parseTransaction(updateId!, party["publisher"]!)).toHaveLength(1);
      await expect(core.parseTransaction(updateId!, party["publisher"]!)).rejects.toThrow(
        /not guardianGovernance/,
      );
    });

    // D9 spike: does the participant reject a disclosed blob whose envelope or create argument
    // was altered? The outcomes are recorded in the fixture output.
    it("D9: the ledger rejects altered disclosure blobs", async () => {
      const [realCoreState] = (await acsSource.core()).filter(
        (entry) => entry.role === "CoreState",
      );
      const [rogueCoreState] = rogueEntries.filter((entry) => entry.role === "CoreState");
      const vaa = serialize(
        new mocks.MockGuardians(0, [GUARDIAN_PRIVATE_KEY]).addSignatures(copyOf(publishedVaa), [0]),
      );
      const encoder = new TextEncoder();
      async function verifyWith(disclosed: DisclosedContract, label: string) {
        try {
          await ledger.submitAndWaitForTransaction(
            {
              commands: [
                {
                  ExerciseCommand: {
                    templateId: "#wormhole-core:Wormhole.Core.State:CoreState",
                    contractId: disclosed.contractId,
                    choice: "ParseAndVerifyVAA",
                    choiceArgument: {
                      verifier: party["verifier"],
                      encodedVAA: { tag: "EncodedVaa", value: encoding.hex.encode(vaa) },
                    },
                  },
                },
              ],
              commandId: `d9-${label}-${suffix}`,
              actAs: [party["verifier"]!],
              disclosedContracts: [
                {
                  templateId: disclosed.templateId,
                  contractId: disclosed.contractId,
                  createdEventBlob: disclosed.createdEventBlob,
                  synchronizerId: disclosed.synchronizerId,
                },
              ],
              synchronizerId,
              userId: USER_ID,
            },
            transactionFormatFor([party["verifier"]!]),
          );
          return "accepted";
        } catch (err) {
          return rejection(err);
        }
      }

      const results: Record<string, unknown> = {};
      results["unaltered real CoreState"] = await verifyWith(realCoreState!, "control");

      // The rogue CoreState's envelope rewritten to list the real guardianGovernance as signatory.
      const forgedSignatories = [party["gg"]!, party["roguefee"]!].sort();
      const signatoryForgery = {
        ...rogueCoreState!,
        createdEventBlob: alterBlob(rogueCoreState!.createdEventBlob, (fields) => [
          ...fields.filter((entry) => entry.field !== 5),
          ...forgedSignatories.map((signatory) => ({
            field: 5,
            wireType: 2,
            data: encoder.encode(signatory),
          })),
        ]),
      };
      expect(readCreatedEventBlob(signatoryForgery.createdEventBlob).signatories).toContain(
        party["gg"],
      );
      results["rogue CoreState, signatories rewritten to the real gg"] = await verifyWith(
        signatoryForgery,
        "signatories",
      );

      // The real CoreState's create argument with chainId 75 changed to 76 (sint64 150 -> 152).
      const argumentForgery = {
        ...realCoreState!,
        createdEventBlob: alterBlob(realCoreState!.createdEventBlob, (fields) =>
          fields.map((entry) => {
            if (entry.field !== 4) return entry;
            const data = entry.data.slice();
            const at = data.findIndex(
              (byte, index) =>
                byte === 0x18 && data[index + 1] === 0x96 && data[index + 2] === 0x01,
            );
            if (at < 0) throw new Error("chainId 75 not found in create_arg");
            data[at + 1] = 0x98;
            return { ...entry, data };
          }),
        ),
      };
      results["real CoreState, create_arg chainId changed"] = await verifyWith(
        argumentForgery,
        "create-arg",
      );

      // The rogue CoreState with both its create argument and its envelope rewritten to the real
      // gg: the envelope then agrees with the argument, and only the contract id binds them.
      const fullForgery = {
        ...rogueCoreState!,
        createdEventBlob: alterBlob(rogueCoreState!.createdEventBlob, (fields) => [
          ...fields
            .filter((entry) => entry.field !== 5)
            .map((entry) =>
              entry.field === 4
                ? { ...entry, data: withFirstParty(entry.data, party["gg"]!) }
                : entry,
            ),
          ...forgedSignatories.map((signatory) => ({
            field: 5,
            wireType: 2,
            data: encoder.encode(signatory),
          })),
        ]),
      };
      expect(
        (
          createArgumentToJson(
            readCreatedEventBlob(fullForgery.createdEventBlob).createArgument,
            CORE_STATE_LAYOUT,
          ) as { guardianGovernance: string }
        ).guardianGovernance,
      ).toBe(party["gg"]);
      results["rogue CoreState, create_arg and signatories rewritten to the real gg"] =
        await verifyWith(fullForgery, "both");
      recorded["d9"] = results;
      // eslint-disable-next-line no-console
      console.log("D9 spike results", JSON.stringify(results, null, 2));
      expect(results["unaltered real CoreState"]).toBe("accepted");
      expect(results["rogue CoreState, signatories rewritten to the real gg"]).not.toBe("accepted");
      expect(results["real CoreState, create_arg chainId changed"]).not.toBe("accepted");
      expect(
        results["rogue CoreState, create_arg and signatories rewritten to the real gg"],
      ).not.toBe("accepted");
    });
  });
});
