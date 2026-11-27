import type { CantonCommand, CantonCommandEnvelope } from "../../src/unsignedTransaction.js";
import {
  CantonUnsignedTransaction,
  DERIVED_COMMAND_ID_PREFIX,
  buildCommandEnvelope,
  canonicalJson,
  deriveCommandId,
} from "../../src/unsignedTransaction.js";

const PARTY = `publisher::1220${"ab".repeat(32)}`;
const OTHER = `other::1220${"cd".repeat(32)}`;
const SYNCHRONIZER = "global-domain::1220aa";
const CORE_STATE_ID = `00${"11".repeat(32)}`;
const EMITTER_ID = `00${"22".repeat(32)}`;
const PACKAGE_ID = "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371";

function publishCommand(payload = "cafe"): CantonCommand {
  return {
    ExerciseCommand: {
      templateId: `${PACKAGE_ID}:Wormhole.Core.State:Emitter`,
      contractId: EMITTER_ID,
      choice: "PublishMessage",
      choiceArgument: {
        nonce: "2",
        payload: { tag: "MessagePayload", value: payload },
        consistencyLevel: "0",
        coreStateCid: CORE_STATE_ID,
        payer: PARTY,
        feeAllocation: null,
      },
    },
  };
}

const coreStateDisclosure = {
  role: "CoreState",
  templateId: `${PACKAGE_ID}:Wormhole.Core.State:CoreState`,
  contractId: CORE_STATE_ID,
  createdEventBlob: "AAAA",
  synchronizerId: SYNCHRONIZER,
  payload: { messageFee: "0" },
};

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined fields", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: null, e: "x" }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"e":"x","f":null}]},"b":1}',
    );
  });

  it("rejects values JSON cannot carry", () => {
    expect(() => canonicalJson(1n)).toThrow(/bigint/);
    expect(() => canonicalJson(undefined)).toThrow(/undefined/);
  });
});

describe("command id policy", () => {
  it("derives the same id for the same content, whatever the key order", () => {
    const reordered = JSON.parse(JSON.stringify(publishCommand())) as CantonCommand;
    const shuffled = {
      ExerciseCommand: Object.fromEntries(
        Object.entries((reordered as any).ExerciseCommand).reverse(),
      ),
    } as CantonCommand;
    const first = deriveCommandId(publishCommand(), [PARTY], SYNCHRONIZER);
    expect(first).toMatch(new RegExp(`^${DERIVED_COMMAND_ID_PREFIX}[0-9a-f]{64}$`));
    expect(deriveCommandId(shuffled, [PARTY], SYNCHRONIZER)).toBe(first);
    expect(deriveCommandId(publishCommand(), [OTHER, PARTY], SYNCHRONIZER)).toBe(
      deriveCommandId(publishCommand(), [PARTY, OTHER, PARTY], SYNCHRONIZER),
    );
  });

  it("derives different ids for different content", () => {
    const base = deriveCommandId(publishCommand(), [PARTY], SYNCHRONIZER);
    expect(deriveCommandId(publishCommand("beef"), [PARTY], SYNCHRONIZER)).not.toBe(base);
    expect(deriveCommandId(publishCommand(), [OTHER], SYNCHRONIZER)).not.toBe(base);
    expect(deriveCommandId(publishCommand(), [PARTY], "other::1220bb")).not.toBe(base);
  });

  it("uses a caller-supplied id, and checks it", () => {
    const envelope = buildCommandEnvelope({
      command: publishCommand(),
      actAs: [PARTY],
      synchronizerId: SYNCHRONIZER,
      commandId: "ntt-private-redeem-abc",
    });
    expect(envelope.commandId).toBe("ntt-private-redeem-abc");
    expect(() =>
      buildCommandEnvelope({
        command: publishCommand(),
        actAs: [PARTY],
        synchronizerId: SYNCHRONIZER,
        commandId: "not valid!",
      }),
    ).toThrow(/Command id/);
  });
});

describe("buildCommandEnvelope", () => {
  it("builds the JsCommands envelope of one command", () => {
    const envelope = buildCommandEnvelope({
      command: publishCommand(),
      actAs: [PARTY],
      disclosedContracts: [coreStateDisclosure],
      synchronizerId: SYNCHRONIZER,
      packageIdSelectionPreference: [PACKAGE_ID],
    });
    expect(envelope).toEqual({
      commands: [publishCommand()],
      commandId: deriveCommandId(publishCommand(), [PARTY], SYNCHRONIZER),
      actAs: [PARTY],
      disclosedContracts: [
        {
          templateId: coreStateDisclosure.templateId,
          contractId: CORE_STATE_ID,
          createdEventBlob: "AAAA",
          synchronizerId: SYNCHRONIZER,
        },
      ],
      synchronizerId: SYNCHRONIZER,
      packageIdSelectionPreference: [PACKAGE_ID],
    });
  });

  it("carries readAs and userId when given", () => {
    const envelope = buildCommandEnvelope({
      command: publishCommand(),
      actAs: [PARTY],
      readAs: [OTHER],
      synchronizerId: SYNCHRONIZER,
      userId: "app-user",
    });
    expect(envelope.readAs).toEqual([OTHER]);
    expect(envelope.userId).toBe("app-user");
  });

  it("rejects an envelope without actAs or synchronizer, or with a bad disclosure", () => {
    expect(() =>
      buildCommandEnvelope({ command: publishCommand(), actAs: [], synchronizerId: SYNCHRONIZER }),
    ).toThrow(/actAs/);
    expect(() =>
      buildCommandEnvelope({ command: publishCommand(), actAs: [PARTY], synchronizerId: "" }),
    ).toThrow(/synchronizer/);
    expect(() =>
      buildCommandEnvelope({
        command: publishCommand(),
        actAs: [PARTY],
        synchronizerId: SYNCHRONIZER,
        disclosedContracts: [{ ...coreStateDisclosure, contractId: "bad" }],
      }),
    ).toThrow(/contract id/);
  });
});

describe("CantonUnsignedTransaction", () => {
  const envelope = () =>
    buildCommandEnvelope({
      command: publishCommand(),
      actAs: [PARTY],
      synchronizerId: SYNCHRONIZER,
    });

  it("holds the envelope and an optional rebuild", async () => {
    const rebuilt = envelope();
    const tx = new CantonUnsignedTransaction(
      envelope(),
      "Devnet",
      "Canton",
      "publish",
      false,
      async () => rebuilt,
    );
    expect(tx.transaction.commands).toHaveLength(1);
    expect(tx.parallelizable).toBe(false);
    expect(await tx.rebuild!()).toBe(rebuilt);
    expect(
      new CantonUnsignedTransaction(envelope(), "Devnet", "Canton", "publish").rebuild,
    ).toBeUndefined();
  });

  it("refuses more than one command", () => {
    const twoCommands = {
      ...envelope(),
      commands: [publishCommand(), publishCommand()],
    } as unknown as CantonCommandEnvelope;
    expect(() => new CantonUnsignedTransaction(twoCommands, "Devnet", "Canton", "two")).toThrow(
      /exactly one command, got 2/,
    );
  });
});
