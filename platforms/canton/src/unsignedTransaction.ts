import type { Network, UnsignedTransaction } from "@wormhole-foundation/sdk-connect";
import { encoding, keccak256 } from "@wormhole-foundation/sdk-connect";
import type { DisclosedContract } from "./disclosure.js";
import type { CantonChains } from "./types.js";
import { parseCantonCommandId, parseCantonContractId } from "./types.js";

/** An ExerciseCommand of the JSON Ledger API */
export interface CantonExerciseCommand {
  ExerciseCommand: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: unknown;
  };
}

/** A CreateCommand of the JSON Ledger API */
export interface CantonCreateCommand {
  CreateCommand: {
    templateId: string;
    createArguments: unknown;
  };
}

/** A CreateAndExerciseCommand of the JSON Ledger API */
export interface CantonCreateAndExerciseCommand {
  CreateAndExerciseCommand: {
    templateId: string;
    createArguments: unknown;
    choice: string;
    choiceArgument: unknown;
  };
}

export type CantonCommand =
  | CantonExerciseCommand
  | CantonCreateCommand
  | CantonCreateAndExerciseCommand;

/** A disclosed contract as a command carries it */
export interface DisclosedContractRef {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
}

/**
 * The command envelope of one Canton transaction. The same object is a JsCommands for
 * submit-and-wait, the body of an interactive-submission prepare request (plus its own options),
 * and the input of a wallet's prepareExecute. It holds exactly one command, because prepare
 * accepts only one.
 */
export interface CantonCommandEnvelope {
  commands: [CantonCommand];
  commandId: string;
  actAs: string[];
  readAs?: string[];
  disclosedContracts: DisclosedContractRef[];
  synchronizerId: string;
  packageIdSelectionPreference: string[];
  /** Required only when the token is not a user token */
  userId?: string;
}

export interface CommandEnvelopeInput {
  command: CantonCommand;
  actAs: readonly string[];
  readAs?: readonly string[];
  disclosedContracts?: readonly (DisclosedContractRef | DisclosedContract)[];
  synchronizerId: string;
  packageIdSelectionPreference?: readonly string[];
  /** Caller-supplied command id; derived from the command content when absent */
  commandId?: string;
  userId?: string;
}

/** Command ids derived by this SDK start with this prefix */
export const DERIVED_COMMAND_ID_PREFIX = "wormhole-sdk-";

/** JSON with object keys in sorted order, so equal content has one text */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol")
      throw new Error(`canonicalJson: unsupported ${typeof value}`);
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("canonicalJson: undefined is not JSON");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`)
    .join(",")}}`;
}

/**
 * A command id derived from the command content: the command, the actAs set and the
 * synchronizer. A resubmission of the same content gets the same id, so the ledger deduplicates
 * it. Callers that rebuild with fresh contract ids must keep the first id (CantonUnsignedTransaction
 * does), and callers that need deduplication across rebuilds should supply an id from their own
 * stable fields (a transfer nonce, a VAA digest).
 */
export function deriveCommandId(
  command: CantonCommand,
  actAs: readonly string[],
  synchronizerId: string,
): string {
  const content = canonicalJson({
    command,
    actAs: [...new Set(actAs)].sort(),
    synchronizerId,
  });
  return `${DERIVED_COMMAND_ID_PREFIX}${encoding.hex.encode(
    keccak256(encoding.bytes.encode(content)),
  )}`;
}

function commandCount(commands: unknown): number {
  return Array.isArray(commands) ? commands.length : 0;
}

/** Checks an envelope: one command, a valid command id, actAs and synchronizer set */
export function checkCommandEnvelope(envelope: CantonCommandEnvelope): void {
  if (commandCount(envelope.commands) !== 1)
    throw new Error(
      `A Canton transaction holds exactly one command, got ${commandCount(envelope.commands)}`,
    );
  parseCantonCommandId(envelope.commandId);
  if (envelope.actAs.length === 0)
    throw new Error("A Canton command needs at least one actAs party");
  if (envelope.synchronizerId === "") throw new Error("A Canton command needs a synchronizer id");
}

/** Builds the envelope of one command, deriving the command id when none is supplied */
export function buildCommandEnvelope(input: CommandEnvelopeInput): CantonCommandEnvelope {
  const disclosedContracts = (input.disclosedContracts ?? []).map((disclosed) => ({
    templateId: disclosed.templateId,
    contractId: parseCantonContractId(disclosed.contractId),
    createdEventBlob: disclosed.createdEventBlob,
    synchronizerId: disclosed.synchronizerId,
  }));
  const envelope: CantonCommandEnvelope = {
    commands: [input.command],
    commandId: input.commandId ?? deriveCommandId(input.command, input.actAs, input.synchronizerId),
    actAs: [...input.actAs],
    ...(input.readAs ? { readAs: [...input.readAs] } : {}),
    disclosedContracts,
    synchronizerId: input.synchronizerId,
    packageIdSelectionPreference: [...(input.packageIdSelectionPreference ?? [])],
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
  };
  checkCommandEnvelope(envelope);
  return envelope;
}

/**
 * Resolves fresh contract ids and returns a new envelope for the same intent. Signers call it
 * after the ledger reports an inactive contract; they keep the command id of the first envelope.
 */
export type CantonRebuild = () => Promise<CantonCommandEnvelope>;

/**
 * An unsigned transaction for the Canton platform
 */
export class CantonUnsignedTransaction<N extends Network, C extends CantonChains>
  implements UnsignedTransaction<N, C>
{
  constructor(
    readonly transaction: CantonCommandEnvelope,
    readonly network: N,
    readonly chain: C,
    readonly description: string,
    readonly parallelizable: boolean = false,
    readonly rebuild?: CantonRebuild,
  ) {
    checkCommandEnvelope(transaction);
  }
}
