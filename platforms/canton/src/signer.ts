import type {
  Network,
  SignAndSendSigner,
  TxHash,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-connect";
import { SUBMIT_MAX_ATTEMPTS } from "./constants.js";
import type { CantonLedgerClient, JsTransaction } from "./ledger.js";
import { CantonLedgerError, isInactiveContractError } from "./ledger.js";
import type { CantonChains } from "./types.js";
import { _platform, parseCantonPartyId } from "./types.js";
import type { CantonCommandEnvelope, CantonUnsignedTransaction } from "./unsignedTransaction.js";
import { checkCommandEnvelope } from "./unsignedTransaction.js";

export interface CantonLocalSignerOptions {
  /** Submissions of one transaction, rebuilds included (default 3) */
  maxAttempts?: number;
  /** User id for a token that is not a user token; set on envelopes that have none */
  userId?: string;
  /** Called with each committed transaction, e.g. to read choice results */
  onTransaction?: (transaction: JsTransaction) => void;
}

/**
 * Signer for a party local to the participant: the participant signs, and a token with actAs
 * rights for the party authorises the submission. Each transaction goes through submit-and-wait;
 * the result is the update id. When the ledger reports an inactive contract and the transaction
 * has a rebuild function, the signer rebuilds it with fresh contract ids and resubmits it under
 * the first command id, a bounded number of times.
 */
export class CantonLocalSigner<N extends Network, C extends CantonChains>
  implements SignAndSendSigner<N, C>
{
  private readonly maxAttempts: number;

  constructor(
    private readonly _chain: C,
    private readonly _ledger: CantonLedgerClient,
    private readonly _party: string,
    private readonly _options: CantonLocalSignerOptions = {},
  ) {
    parseCantonPartyId(_party);
    this.maxAttempts = _options.maxAttempts ?? SUBMIT_MAX_ATTEMPTS;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1)
      throw new Error(`maxAttempts must be a positive integer, got ${this.maxAttempts}`);
  }

  chain(): C {
    return this._chain;
  }

  address(): string {
    return this._party;
  }

  async signAndSend(txs: UnsignedTransaction<N, C>[]): Promise<TxHash[]> {
    const updateIds: TxHash[] = [];
    for (const tx of txs)
      updateIds.push(await this.submitOne(tx as CantonUnsignedTransaction<N, C>));
    return updateIds;
  }

  private checkEnvelope(envelope: CantonCommandEnvelope): void {
    checkCommandEnvelope(envelope);
    if (!envelope.actAs.includes(this._party))
      throw new Error(
        `The command acts as ${envelope.actAs.join(", ")}, not as the signer ${this._party}`,
      );
  }

  private async submitOne(tx: CantonUnsignedTransaction<N, C>): Promise<TxHash> {
    let envelope = tx.transaction;
    this.checkEnvelope(envelope);
    const commandId = envelope.commandId;
    for (let attempt = 1; ; attempt++) {
      const commands = {
        ...envelope,
        commandId,
        ...(envelope.userId === undefined && this._options.userId !== undefined
          ? { userId: this._options.userId }
          : {}),
      };
      try {
        const transaction = await this._ledger.submitAndWaitForTransaction(commands);
        this._options.onTransaction?.(transaction);
        return transaction.updateId;
      } catch (err) {
        if (!(err instanceof CantonLedgerError))
          throw new Error(
            `Canton submit of command ${commandId}: result unknown (${(err as Error).message}). ` +
              `Submitting the same command id again is deduplicated by the participant.`,
          );
        if (attempt >= this.maxAttempts || !tx.rebuild || !isInactiveContractError(err)) throw err;
        envelope = await tx.rebuild();
        this.checkEnvelope(envelope);
      }
    }
  }
}

export interface CantonSignerOptions extends CantonLocalSignerOptions {
  chain?: CantonChains;
}

/**
 * A local-party signer. `party` is the party id the participant hosts; the ledger client's token
 * must carry actAs rights for it.
 */
export async function getCantonSigner(
  rpc: CantonLedgerClient,
  party: string,
  options: CantonSignerOptions = {},
): Promise<SignAndSendSigner<Network, CantonChains>> {
  const { chain, ...signerOptions } = options;
  return new CantonLocalSigner(chain ?? _platform, rpc, party, signerOptions);
}
