import type { LfType } from "@wormhole-foundation/sdk-canton";
import {
  createArgumentToJson,
  lfType,
  readCreatedEventBlob,
} from "@wormhole-foundation/sdk-canton";
import {
  CORE_STATE_LAYOUT,
  EMITTER_REGISTRY_LAYOUT,
  decodeCoreState,
  decodeEmitter,
  decodeEmitterRegistry,
  decodePublishMessageResult,
  parseAndVerifyVaaArgument,
  publishMessageArgument,
  registerEmitterArgument,
} from "../../src/coreContracts.js";
import {
  SANDBOX_CORE_STATE,
  SANDBOX_EMITTER_ACTIVE_CONTRACTS,
  SANDBOX_EMITTER_REGISTRY,
  SANDBOX_FEE,
  SANDBOX_GG,
  SANDBOX_GUARDIAN_ADDRESS,
  SANDBOX_PUBLISHER,
  SANDBOX_PUBLISH_UPDATE,
} from "../../../../__tests__/fixtures/sandbox.js";

const blobArgument = (blob: string) => readCreatedEventBlob(blob).createArgument;
const clone = <T>(value: T): any => JSON.parse(JSON.stringify(value));

describe("record layouts against recorded blobs", () => {
  it("reads the CoreState blob as the JSON Ledger API serves its payload", () => {
    const fromBlob = createArgumentToJson(
      blobArgument(SANDBOX_CORE_STATE.createdEventBlob),
      CORE_STATE_LAYOUT,
    );
    // The JSON Ledger API omits the trailing None fields; the reader sets them to null.
    const payload = clone(SANDBOX_CORE_STATE.payload);
    payload.evictedGovernanceMaxTimestampSeconds = null;
    payload.guardianSets[0][1].expirationTime = null;
    expect(fromBlob).toEqual(payload);
    expect(decodeCoreState(fromBlob)).toEqual(decodeCoreState(SANDBOX_CORE_STATE.payload));
  });

  it("decodes the recorded CoreState", () => {
    const state = decodeCoreState(SANDBOX_CORE_STATE.payload);
    expect(state).toEqual({
      guardianGovernance: SANDBOX_GG,
      chainId: 75n,
      guardianSetIndex: 0,
      guardianSets: new Map([[0, { addresses: [SANDBOX_GUARDIAN_ADDRESS] }]]),
      messageFee: 0n,
      feeRecipient: SANDBOX_FEE,
    });
  });

  it("reads the EmitterRegistry blob as its payload", () => {
    const fromBlob = createArgumentToJson(
      blobArgument(SANDBOX_EMITTER_REGISTRY.createdEventBlob),
      EMITTER_REGISTRY_LAYOUT,
    );
    expect(fromBlob).toEqual(SANDBOX_EMITTER_REGISTRY.payload);
    expect(decodeEmitterRegistry(fromBlob)).toEqual({
      guardianGovernance: SANDBOX_GG,
      registrationFee: 0n,
      nextId: 0n,
    });
  });

  // A layout that disagrees with the Daml source must fail, never shift fields.
  const fields = (CORE_STATE_LAYOUT as Extract<LfType, { kind: "record" }>).fields;
  const variants: Array<[string, LfType, RegExp]> = [
    [
      "a layout that lacks the last stored field",
      lfType.record("CoreState", fields.slice(0, 9)),
      /CoreState has 9 fields, found 10/,
    ],
    [
      "a layout with two fields swapped",
      lfType.record("CoreState", [fields[1]!, fields[0]!, ...fields.slice(2)]),
      /CoreState.chainId: expected an Int, found party/,
    ],
    [
      "a layout with a field inserted",
      lfType.record("CoreState", [fields[0]!, ["extra", lfType.int64], ...fields.slice(1)]),
      /CoreState.governanceChainId: expected an Int, found variant/,
    ],
    [
      "a layout with a mandatory field the blob does not have",
      lfType.record("CoreState", [...fields.slice(0, 10), ["required", lfType.int64]]),
      /field required is missing and only trailing Optional fields may be omitted/,
    ],
  ];
  it.each(variants)("fails closed on %s", (_name, layout, pattern) => {
    expect(() =>
      createArgumentToJson(blobArgument(SANDBOX_CORE_STATE.createdEventBlob), layout),
    ).toThrow(pattern);
  });
});

describe("payload decoders", () => {
  const state = () => clone(SANDBOX_CORE_STATE.payload);

  it("rejects a CoreState without its current guardian set", () => {
    const payload = state();
    payload.guardianSetIndex = "1";
    expect(() => decodeCoreState(payload)).toThrow(/current guardian set 1 is not stored/);
  });

  it("rejects out-of-range CoreState fields", () => {
    const negativeFee = state();
    negativeFee.messageFee = "-1";
    expect(() => decodeCoreState(negativeFee)).toThrow(/messageFee: expected 0 to/);
    const noMembers = state();
    noMembers.guardianSets[0][1].members = [];
    expect(() => decodeCoreState(noMembers)).toThrow(/expected 1 to 255 members, got 0/);
    const fiveSets = state();
    fiveSets.guardianSets = [0, 1, 2, 3, 4].map((index) => [
      String(index),
      state().guardianSets[0][1],
    ]);
    expect(() => decodeCoreState(fiveSets)).toThrow(/at most 4 guardian sets, got 5/);
    expect(() => decodeCoreState([])).toThrow(/CoreState: expected an object/);
  });

  it("reads a guardian set expiry", () => {
    const payload = state();
    payload.guardianSets = [
      ["0", { ...payload.guardianSets[0][1], expirationTime: "2026-11-25T00:00:00.5Z" }],
      ["1", payload.guardianSets[0][1]],
    ];
    payload.guardianSetIndex = "1";
    expect(decodeCoreState(payload).guardianSets.get(0)!.expirationTime).toEqual(
      new Date("2026-11-25T00:00:00.500Z"),
    );
  });

  it("decodes the recorded Emitter and PublishMessage result", () => {
    const createdEvent = (SANDBOX_EMITTER_ACTIVE_CONTRACTS[0] as any).contractEntry.JsActiveContract
      .createdEvent;
    expect(decodeEmitter(createdEvent.createArgument)).toMatchObject({
      guardianGovernance: SANDBOX_GG,
      owner: SANDBOX_PUBLISHER,
      emitterId: 0n,
      sequence: 0n,
    });
    const exercised = (SANDBOX_PUBLISH_UPDATE as any).update.Transaction.value.events[0]
      .ExercisedEvent;
    expect(decodePublishMessageResult(exercised.exerciseResult)).toEqual({
      registrar: SANDBOX_GG,
      owner: SANDBOX_PUBLISHER,
      emitterId: 0n,
      sequence: 0n,
      nonce: 7,
      consistencyLevel: 1,
      payload: "63616e746f6e2073646b20696e746567726174696f6e",
    });
  });

  it("rejects a PublishMessage result outside the watcher's ranges", () => {
    const exercised = clone(
      (SANDBOX_PUBLISH_UPDATE as any).update.Transaction.value.events[0].ExercisedEvent,
    );
    const result = exercised.exerciseResult;
    expect(() => decodePublishMessageResult({ _1: result._1 })).toThrow(/no _2/);
    result._2.nonce = "4294967296";
    expect(() => decodePublishMessageResult(result)).toThrow(/nonce: expected 0 to 4294967295/);
    result._2.nonce = "1";
    result._2.consistencyLevel = "256";
    expect(() => decodePublishMessageResult(result)).toThrow(/consistencyLevel/);
    result._2.consistencyLevel = "1";
    result._2.emitterId = "9007199254740992";
    expect(() => decodePublishMessageResult(result)).toThrow(/emitterId/);
  });
});

describe("choice arguments", () => {
  const coreStateCid = SANDBOX_CORE_STATE.contractId;

  it("builds PublishMessage at fee zero with the owner as payer", () => {
    expect(
      publishMessageArgument({
        owner: SANDBOX_PUBLISHER,
        coreStateContractId: coreStateCid,
        nonce: 4294967295,
        consistencyLevel: 255,
        payload: new Uint8Array([0xab, 0x01]),
      }),
    ).toEqual({
      nonce: "4294967295",
      payload: { tag: "MessagePayload", value: "ab01" },
      consistencyLevel: "255",
      coreStateCid,
      payer: SANDBOX_PUBLISHER,
      feeAllocation: null,
    });
  });

  it("rejects a nonce or consistency level the core rejects", () => {
    const input = {
      owner: SANDBOX_PUBLISHER,
      coreStateContractId: coreStateCid,
      nonce: 0,
      consistencyLevel: 0,
      payload: new Uint8Array(),
    };
    expect(() => publishMessageArgument({ ...input, nonce: 2 ** 32 })).toThrow(/nonce/);
    expect(() => publishMessageArgument({ ...input, nonce: -1 })).toThrow(/nonce/);
    expect(() => publishMessageArgument({ ...input, consistencyLevel: 256 })).toThrow(
      /consistencyLevel/,
    );
    expect(() => publishMessageArgument({ ...input, consistencyLevel: 1.5 })).toThrow(
      /consistencyLevel/,
    );
  });

  it("builds RegisterEmitter with the expected guardianGovernance", () => {
    expect(registerEmitterArgument(SANDBOX_PUBLISHER, SANDBOX_GG)).toEqual({
      requester: SANDBOX_PUBLISHER,
      payer: SANDBOX_PUBLISHER,
      coreStateCid: null,
      feeAllocation: null,
      expectedGuardianGovernance: SANDBOX_GG,
    });
  });

  it("builds ParseAndVerifyVAA and rejects bytes too short for a VAA", () => {
    const vaa = new Uint8Array(57).fill(1);
    expect(parseAndVerifyVaaArgument(SANDBOX_PUBLISHER, vaa)).toEqual({
      verifier: SANDBOX_PUBLISHER,
      encodedVAA: { tag: "EncodedVaa", value: "01".repeat(57) },
    });
    expect(() => parseAndVerifyVaaArgument(SANDBOX_PUBLISHER, vaa.slice(1))).toThrow(
      /at least 57 bytes/,
    );
  });
});
