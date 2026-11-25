import { isSignAndSendSigner } from "@wormhole-foundation/sdk-connect";
import type { JsTransaction } from "../../src/ledger.js";
import { CantonLedgerError } from "../../src/ledger.js";
import { CantonLocalSigner, getCantonSigner } from "../../src/signer.js";
import type { CantonCommandEnvelope } from "../../src/unsignedTransaction.js";
import { CantonUnsignedTransaction, buildCommandEnvelope } from "../../src/unsignedTransaction.js";
import { mockLedger } from "../mocks/ledger.js";

const PARTY = `publisher::1220${"ab".repeat(32)}`;
const OTHER = `other::1220${"cd".repeat(32)}`;
const SYNCHRONIZER = "global-domain::1220aa";
const SUBMIT = "/v2/commands/submit-and-wait-for-transaction";
const PACKAGE_ID = "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371";

function envelopeFor(
  coreStateNumber: number,
  commandId?: string,
  actAs = [PARTY],
): CantonCommandEnvelope {
  const coreStateId = `00${coreStateNumber.toString(16).padStart(64, "0")}`;
  return buildCommandEnvelope({
    command: {
      ExerciseCommand: {
        templateId: `${PACKAGE_ID}:Wormhole.Core.State:Emitter`,
        contractId: `00${"ee".repeat(32)}`,
        choice: "PublishMessage",
        choiceArgument: { coreStateCid: coreStateId },
      },
    },
    actAs,
    disclosedContracts: [
      {
        templateId: `${PACKAGE_ID}:Wormhole.Core.State:CoreState`,
        contractId: coreStateId,
        createdEventBlob: `blob-${coreStateNumber}`,
        synchronizerId: SYNCHRONIZER,
      },
    ],
    synchronizerId: SYNCHRONIZER,
    ...(commandId ? { commandId } : {}),
  });
}

const committed = (updateId: string) => ({ json: { transaction: { updateId, events: [] } } });
const inactive = {
  status: 409,
  json: {
    code: "LOCAL_VERDICT_INACTIVE_CONTRACTS",
    cause: "inactive",
    context: {},
    errorCategory: 9,
  },
};

describe("CantonLocalSigner", () => {
  it("is a SignAndSendSigner for the party", async () => {
    const { ledger } = mockLedger({});
    const signer = await getCantonSigner(ledger, PARTY);
    expect(isSignAndSendSigner(signer)).toBe(true);
    expect(signer.chain()).toBe("Canton");
    expect(signer.address()).toBe(PARTY);
    expect(() => new CantonLocalSigner("Canton", ledger, "not-a-party")).toThrow(/party id/);
    expect(() => new CantonLocalSigner("Canton", ledger, PARTY, { maxAttempts: 0 })).toThrow(
      /maxAttempts/,
    );
  });

  it("submits each transaction in order and returns update ids", async () => {
    const { ledger, requests } = mockLedger({
      [SUBMIT]: [committed("1220aa"), committed("1220bb")],
    });
    const seen: JsTransaction[] = [];
    const signer = new CantonLocalSigner("Canton", ledger, PARTY, {
      onTransaction: (t) => seen.push(t),
    });
    const first = envelopeFor(1);
    const second = envelopeFor(2);
    const updateIds = await signer.signAndSend([
      new CantonUnsignedTransaction(first, "Devnet", "Canton", "one"),
      new CantonUnsignedTransaction(second, "Devnet", "Canton", "two"),
    ]);
    expect(updateIds).toEqual(["1220aa", "1220bb"]);
    expect(seen.map((t) => t.updateId)).toEqual(["1220aa", "1220bb"]);
    expect(requests.map((request) => (request.body as any).commands)).toEqual([first, second]);
    expect((requests[0]!.body as any).transactionFormat.transactionShape).toBe(
      "TRANSACTION_SHAPE_LEDGER_EFFECTS",
    );
  });

  it("sets the configured userId on an envelope without one", async () => {
    const { ledger, requests } = mockLedger({ [SUBMIT]: [committed("1220aa")] });
    const signer = new CantonLocalSigner("Canton", ledger, PARTY, { userId: "app-user" });
    await signer.signAndSend([
      new CantonUnsignedTransaction(envelopeFor(1), "Devnet", "Canton", "one"),
    ]);
    expect((requests[0]!.body as any).commands.userId).toBe("app-user");
  });

  it("rebuilds after an inactive contract and resubmits under the first command id", async () => {
    const { ledger, requests } = mockLedger({
      [SUBMIT]: [inactive, inactive, committed("1220cc")],
    });
    const signer = new CantonLocalSigner("Canton", ledger, PARTY);
    let rebuilds = 0;
    const tx = new CantonUnsignedTransaction(
      envelopeFor(1, "publish-1"),
      "Devnet",
      "Canton",
      "publish",
      false,
      async () =>
        // A rebuild that derives its own id: the signer still uses the first one.
        envelopeFor(1 + ++rebuilds),
    );
    expect(await signer.signAndSend([tx])).toEqual(["1220cc"]);
    expect(rebuilds).toBe(2);
    const submitted = requests.map((request) => (request.body as any).commands);
    expect(submitted.map((commands) => commands.commandId)).toEqual([
      "publish-1",
      "publish-1",
      "publish-1",
    ]);
    expect(submitted.map((commands) => commands.disclosedContracts[0].createdEventBlob)).toEqual([
      "blob-1",
      "blob-2",
      "blob-3",
    ]);
  });

  it("stops after maxAttempts", async () => {
    const { ledger, requests } = mockLedger({ [SUBMIT]: [inactive, inactive, inactive] });
    const signer = new CantonLocalSigner("Canton", ledger, PARTY, { maxAttempts: 2 });
    const tx = new CantonUnsignedTransaction(
      envelopeFor(1),
      "Devnet",
      "Canton",
      "publish",
      false,
      async () => envelopeFor(2),
    );
    await expect(signer.signAndSend([tx])).rejects.toBeInstanceOf(CantonLedgerError);
    expect(requests).toHaveLength(2);
  });

  it("does not retry other rejections, or without a rebuild", async () => {
    const { ledger, requests } = mockLedger({
      [SUBMIT]: [{ status: 403, json: { code: "PERMISSION_DENIED" } }, inactive],
    });
    const signer = new CantonLocalSigner("Canton", ledger, PARTY);
    const withRebuild = new CantonUnsignedTransaction(
      envelopeFor(1),
      "Devnet",
      "Canton",
      "a",
      false,
      async () => envelopeFor(2),
    );
    await expect(signer.signAndSend([withRebuild])).rejects.toThrow(/HTTP 403/);
    const withoutRebuild = new CantonUnsignedTransaction(envelopeFor(1), "Devnet", "Canton", "b");
    await expect(signer.signAndSend([withoutRebuild])).rejects.toThrow(/HTTP 409/);
    expect(requests).toHaveLength(2);
  });

  it("reports an unknown result when the request itself fails", async () => {
    const { ledger } = mockLedger({ [SUBMIT]: [new TypeError("fetch failed")] });
    const signer = new CantonLocalSigner("Canton", ledger, PARTY);
    const tx = new CantonUnsignedTransaction(
      envelopeFor(1, "publish-9"),
      "Devnet",
      "Canton",
      "publish",
    );
    await expect(signer.signAndSend([tx])).rejects.toThrow(
      /Canton submit of command publish-9: result unknown \(fetch failed\)/,
    );
  });

  it("refuses a command that does not act as the signer", async () => {
    const { ledger, requests } = mockLedger({ [SUBMIT]: [committed("1220aa")] });
    const signer = new CantonLocalSigner("Canton", ledger, PARTY);
    const tx = new CantonUnsignedTransaction(
      envelopeFor(1, undefined, [OTHER]),
      "Devnet",
      "Canton",
      "x",
    );
    await expect(signer.signAndSend([tx])).rejects.toThrow(/not as the signer/);
    expect(requests).toHaveLength(0);
  });
});
