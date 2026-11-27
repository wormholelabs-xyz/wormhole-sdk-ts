// Daml-facing definitions of the Wormhole core package (wormhole-core 0.12.3, module
// Wormhole.Core.State): record layouts, payload decoders and choice arguments. Everything that
// depends on the Daml source of the core lives here, so a new core version changes this file.
import type { DamlJson, LfType } from "@wormhole-foundation/sdk-canton";
import {
  CORE_PACKAGE_NAME,
  CORE_TEMPLATES,
  decodeBytesHex,
  decodeInt,
  decodeMap,
  decodeOptional,
  decodeParty,
  decodeTime,
  encodeBytes,
  encodeContractId,
  encodeInt,
  encodeParty,
  lfType,
} from "@wormhole-foundation/sdk-canton";

/** Package-name references of the core templates, for commands and ACS filters */
export const CORE_TEMPLATE_REFERENCES = {
  CoreState: `#${CORE_PACKAGE_NAME}:${CORE_TEMPLATES.CoreState}`,
  EmitterRegistry: `#${CORE_PACKAGE_NAME}:${CORE_TEMPLATES.EmitterRegistry}`,
  Emitter: `#${CORE_PACKAGE_NAME}:${CORE_TEMPLATES.Emitter}`,
} as const;

/** Choices of the core templates that this client exercises */
export const CORE_CHOICES = {
  PublishMessage: "PublishMessage",
  RegisterEmitter: "RegisterEmitter",
  ParseAndVerifyVAA: "ParseAndVerifyVAA",
} as const;

// Bounds of the core (State.daml, GuardianSet.daml).
const MAX_GUARDIAN_SET_INDEX = 4294967295n;
const MAX_GUARDIANS_PER_SET = 255;
const MAX_STORED_GUARDIAN_SETS = 4;
const MAX_EMITTER_ID = 9007199254740991n;
const MAX_NONCE = 4294967295n;
const MAX_CONSISTENCY_LEVEL = 255n;

// ---------------------------------------------------------------------------------------------
// Record layouts, in the field order of the Daml source.
//
// A create argument read from a created event blob has no field labels: its fields are
// positional. These layouts are the only place that knows the order. They must match the Daml
// declarations field for field; a reordered, added or removed field in a new core version needs
// a new layout here (and a new pinned package id in the platform constants).
// ---------------------------------------------------------------------------------------------

/** Wormhole.Core.GuardianSet.GuardianSetMember */
const GUARDIAN_SET_MEMBER: LfType = lfType.record("GuardianSetMember", [
  ["address", lfType.bytes("GuardianAddress")],
  ["publicKey", lfType.optional(lfType.bytes("GuardianPublicKey"))],
]);

/** Wormhole.Core.GuardianSet.GuardianSet */
const GUARDIAN_SET: LfType = lfType.record("GuardianSet", [
  ["members", lfType.list(GUARDIAN_SET_MEMBER)],
  ["expirationTime", lfType.optional(lfType.timestamp)],
]);

/** Splice.Api.Token.HoldingV1.InstrumentId */
const INSTRUMENT_ID: LfType = lfType.record("InstrumentId", [
  ["admin", lfType.party],
  ["id", lfType.text],
]);

/** Wormhole.Core.State.CoreState (wormhole-core 0.12.3) */
export const CORE_STATE_LAYOUT: LfType = lfType.record("CoreState", [
  ["guardianGovernance", lfType.party],
  ["chainId", lfType.int64],
  ["governanceChainId", lfType.int64],
  ["governanceContract", lfType.bytes("EmitterAddress")],
  ["guardianSetIndex", lfType.int64],
  ["guardianSets", lfType.map(lfType.int64, GUARDIAN_SET)],
  ["messageFee", lfType.int64],
  ["feeInstrument", INSTRUMENT_ID],
  ["feeRecipient", lfType.party],
  ["consumedGovernance", lfType.map(lfType.bytes("VaaDigest"), lfType.int64)],
  ["evictedGovernanceMaxTimestampSeconds", lfType.optional(lfType.int64)],
]);

/** Wormhole.Core.State.EmitterRegistry (wormhole-core 0.12.3) */
export const EMITTER_REGISTRY_LAYOUT: LfType = lfType.record("EmitterRegistry", [
  ["guardianGovernance", lfType.party],
  ["onboardingFeeAdmin", lfType.party],
  ["registrationFee", lfType.int64],
  ["nextId", lfType.int64],
]);

// ---------------------------------------------------------------------------------------------
// Payload decoders. Each accepts the JSON Ledger API form of a create argument, whether a source
// served it or createArgumentToJson read it from a blob.
// ---------------------------------------------------------------------------------------------

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.slice(0, 80);
}

function objectOf(json: unknown, what: string): Record<string, unknown> {
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new Error(`${what}: expected an object, got ${describe(json)}`);
  return json as Record<string, unknown>;
}

function intInRange(json: unknown, what: string, min: bigint, max: bigint): bigint {
  let value: bigint;
  try {
    value = decodeInt(json);
  } catch (err) {
    throw new Error(`${what}: ${(err as Error).message}`);
  }
  if (value < min || value > max)
    throw new Error(`${what}: expected ${min} to ${max}, got ${value}`);
  return value;
}

/** A stored guardian set: member addresses in order, and its expiry when it has one */
export interface GuardianSetView {
  /** 20-byte guardian addresses, lowercase hex without 0x */
  addresses: string[];
  expirationTime?: Date;
}

/** The CoreState fields this client reads */
export interface CoreStateView {
  guardianGovernance: string;
  chainId: bigint;
  guardianSetIndex: number;
  guardianSets: Map<number, GuardianSetView>;
  /** Per-publish fee, in 10^-10 units of the fee instrument */
  messageFee: bigint;
  feeRecipient: string;
}

function decodeGuardianSet(json: unknown, index: number): GuardianSetView {
  const what = `CoreState.guardianSets[${index}]`;
  const set = objectOf(json, what);
  if (!Array.isArray(set["members"])) throw new Error(`${what}.members is not a list`);
  const members = set["members"];
  if (members.length < 1 || members.length > MAX_GUARDIANS_PER_SET)
    throw new Error(
      `${what}: expected 1 to ${MAX_GUARDIANS_PER_SET} members, got ${members.length}`,
    );
  const addresses = members.map((member, position) =>
    decodeBytesHex(objectOf(member, `${what}.members[${position}]`)["address"], "GuardianAddress"),
  );
  const expirationTime = decodeOptional(set["expirationTime"], decodeTime);
  return { addresses, ...(expirationTime ? { expirationTime } : {}) };
}

/** Decodes a CoreState create argument (JSON Ledger API form) */
export function decodeCoreState(json: unknown): CoreStateView {
  const state = objectOf(json, "CoreState");
  const guardianSetIndex = Number(
    intInRange(state["guardianSetIndex"], "CoreState.guardianSetIndex", 0n, MAX_GUARDIAN_SET_INDEX),
  );
  const storedSets = decodeMap(
    state["guardianSets"],
    (key) => Number(intInRange(key, "CoreState.guardianSets key", 0n, MAX_GUARDIAN_SET_INDEX)),
    (value) => value,
  );
  if (storedSets.length > MAX_STORED_GUARDIAN_SETS)
    throw new Error(
      `CoreState: expected at most ${MAX_STORED_GUARDIAN_SETS} guardian sets, got ${storedSets.length}`,
    );
  const guardianSets = new Map(
    storedSets.map(([index, set]) => [index, decodeGuardianSet(set, index)] as const),
  );
  if (!guardianSets.has(guardianSetIndex))
    throw new Error(`CoreState: the current guardian set ${guardianSetIndex} is not stored`);
  return {
    guardianGovernance: decodeParty(state["guardianGovernance"]),
    chainId: intInRange(state["chainId"], "CoreState.chainId", 0n, 65535n),
    guardianSetIndex,
    guardianSets,
    messageFee: intInRange(state["messageFee"], "CoreState.messageFee", 0n, 2n ** 63n - 1n),
    feeRecipient: decodeParty(state["feeRecipient"]),
  };
}

/** The EmitterRegistry fields this client reads */
export interface EmitterRegistryView {
  guardianGovernance: string;
  /** Registration fee, in 10^-10 units of the fee instrument */
  registrationFee: bigint;
  nextId: bigint;
}

/** Decodes an EmitterRegistry create argument (JSON Ledger API form) */
export function decodeEmitterRegistry(json: unknown): EmitterRegistryView {
  const registry = objectOf(json, "EmitterRegistry");
  return {
    guardianGovernance: decodeParty(registry["guardianGovernance"]),
    registrationFee: intInRange(
      registry["registrationFee"],
      "EmitterRegistry.registrationFee",
      0n,
      2n ** 63n - 1n,
    ),
    nextId: intInRange(registry["nextId"], "EmitterRegistry.nextId", 0n, MAX_EMITTER_ID + 1n),
  };
}

/** An Emitter as its owner's ACS shows it */
export interface EmitterView {
  guardianGovernance: string;
  owner: string;
  emitterId: bigint;
  /** The stored 32-byte emitter address, lowercase hex */
  emitterAddress: string;
  /** The sequence of the next publish */
  sequence: bigint;
}

/** Decodes an Emitter create argument (JSON Ledger API form) */
export function decodeEmitter(json: unknown): EmitterView {
  const emitter = objectOf(json, "Emitter");
  return {
    guardianGovernance: decodeParty(emitter["guardianGovernance"]),
    owner: decodeParty(emitter["owner"]),
    emitterId: intInRange(emitter["emitterId"], "Emitter.emitterId", 0n, MAX_EMITTER_ID),
    emitterAddress: decodeBytesHex(emitter["emitterAddress"], "EmitterAddress"),
    sequence: intInRange(emitter["sequence"], "Emitter.sequence", 0n, 2n ** 63n - 2n),
  };
}

/**
 * Wormhole.Core.State.WormholeMessage, the second element of the PublishMessage result. The
 * ranges are the watcher's (cantongrpc.go decodeWormholeMessage): it drops a message outside them.
 */
export interface WormholeMessageView {
  registrar: string;
  owner: string;
  emitterId: bigint;
  sequence: bigint;
  nonce: number;
  consistencyLevel: number;
  /** Lowercase hex */
  payload: string;
}

/** Decodes the exercise result of PublishMessage: the tuple (ContractId Emitter, WormholeMessage) */
export function decodePublishMessageResult(json: unknown): WormholeMessageView {
  const result = objectOf(json, "PublishMessage result");
  if (!("_2" in result)) throw new Error("PublishMessage result has no _2 (WormholeMessage)");
  const message = objectOf(result["_2"], "WormholeMessage");
  return {
    registrar: decodeParty(message["registrar"]),
    owner: decodeParty(message["owner"]),
    emitterId: intInRange(message["emitterId"], "WormholeMessage.emitterId", 0n, MAX_EMITTER_ID),
    sequence: intInRange(message["sequence"], "WormholeMessage.sequence", 0n, 2n ** 63n - 1n),
    nonce: Number(intInRange(message["nonce"], "WormholeMessage.nonce", 0n, MAX_NONCE)),
    consistencyLevel: Number(
      intInRange(
        message["consistencyLevel"],
        "WormholeMessage.consistencyLevel",
        0n,
        MAX_CONSISTENCY_LEVEL,
      ),
    ),
    payload: decodeBytesHex(message["payload"], "MessagePayload"),
  };
}

// ---------------------------------------------------------------------------------------------
// Choice arguments. Fees above zero are not supported yet, so each fee allocation is None.
// ---------------------------------------------------------------------------------------------

export interface PublishMessageInput {
  owner: string;
  coreStateContractId: string;
  nonce: number;
  consistencyLevel: number;
  payload: Uint8Array;
}

/** Emitter.PublishMessage at fee 0: the owner is the payer */
export function publishMessageArgument(input: PublishMessageInput): DamlJson {
  if (!Number.isInteger(input.nonce) || input.nonce < 0 || BigInt(input.nonce) > MAX_NONCE)
    throw new Error(`nonce must be an integer from 0 to ${MAX_NONCE}, got ${input.nonce}`);
  if (
    !Number.isInteger(input.consistencyLevel) ||
    input.consistencyLevel < 0 ||
    BigInt(input.consistencyLevel) > MAX_CONSISTENCY_LEVEL
  )
    throw new Error(
      `consistencyLevel must be an integer from 0 to ${MAX_CONSISTENCY_LEVEL}, got ${input.consistencyLevel}`,
    );
  const owner = encodeParty(input.owner);
  return {
    nonce: encodeInt(input.nonce),
    payload: encodeBytes("MessagePayload", input.payload) as unknown as DamlJson,
    consistencyLevel: encodeInt(input.consistencyLevel),
    coreStateCid: encodeContractId(input.coreStateContractId),
    payer: owner,
    feeAllocation: null,
  };
}

/** EmitterRegistry.RegisterEmitter at fee 0: the requester is the payer, no CoreState needed */
export function registerEmitterArgument(requester: string, guardianGovernance: string): DamlJson {
  const party = encodeParty(requester);
  return {
    requester: party,
    payer: party,
    coreStateCid: null,
    feeAllocation: null,
    expectedGuardianGovernance: encodeParty(guardianGovernance),
  };
}

/** CoreState.ParseAndVerifyVAA */
export function parseAndVerifyVaaArgument(verifier: string, encodedVaa: Uint8Array): DamlJson {
  return {
    verifier: encodeParty(verifier),
    encodedVAA: encodeBytes("EncodedVaa", encodedVaa) as unknown as DamlJson,
  };
}
