import type { Chain, Network } from "@wormhole-foundation/sdk-base";
import {
  amount,
  encoding,
  finality,
  guardians,
  time,
  toChain as toChainName,
} from "@wormhole-foundation/sdk-base";
import type {
  AttestationId,
  AutomaticTokenBridge,
  ChainContext,
  Signer,
  NativeAddress,
  TokenId,
  TokenTransferDetails,
  TransactionId,
  TxHash,
  UnsignedTransaction,
  WormholeMessageId,
} from "@wormhole-foundation/sdk-definitions";
import {
  TokenBridge,
  UniversalAddress,
  canonicalAddress,
  deserialize,
  isNative,
  isSameToken,
  isTokenId,
  isTokenTransferDetails,
  isTransactionIdentifier,
  isWormholeMessageId,
  serialize,
  toNative,
  toUniversal,
} from "@wormhole-foundation/sdk-definitions";
import { signSendWait } from "../../common.js";
import { DEFAULT_TASK_TIMEOUT } from "../../config.js";
import { chainToPlatform } from "@wormhole-foundation/sdk-base";
import type {
  AttestationReceipt as _AttestationReceipt,
  AttestedTransferReceipt,
  CompletedTransferReceipt,
  RedeemedTransferReceipt,
  SourceFinalizedTransferReceipt,
  SourceInitiatedTransferReceipt,
  TransferQuote,
  TransferReceipt as _TransferReceipt,
  InReviewTransferReceipt,
} from "../../types.js";
import {
  TransferState,
  isAttested,
  isInReview,
  isRedeemed,
  isSourceFinalized,
  isSourceInitiated,
} from "../../types.js";
import { getGovernedTokens, getGovernorLimits } from "../../whscan-api.js";
import { Wormhole } from "../../wormhole.js";
import type { WormholeTransfer } from "../wormholeTransfer.js";
import type { QuoteWarning } from "../../warnings.js";

export class TokenTransfer<N extends Network = Network>
  implements WormholeTransfer<TokenTransfer.Protocol>
{
  private readonly wh: Wormhole<N>;

  fromChain: ChainContext<N, Chain>;
  toChain: ChainContext<N, Chain>;

  // state machine tracker
  private _state: TransferState;

  // transfer details
  transfer: TokenTransferDetails;

  // txids, populated once transactions are submitted
  txids: TransactionId[] = [];

  // The corresponding vaa representing the TokenTransfer
  // on the source chain (if its been completed and finalized)
  attestations?: TokenTransfer.AttestationReceipt[];

  private constructor(
    wh: Wormhole<N>,
    transfer: TokenTransferDetails,
    fromChain?: ChainContext<N, Chain>,
    toChain?: ChainContext<N, Chain>,
  ) {
    this._state = TransferState.Created;
    this.wh = wh;
    this.transfer = transfer;

    this.fromChain = fromChain ?? wh.getChain(transfer.from.chain);
    this.toChain = toChain ?? wh.getChain(transfer.to.chain);
  }

  getTransferState(): TransferState {
    return this._state;
  }

  // Static initializers for in flight transfers that have not been completed
  static async from<N extends Network>(
    wh: Wormhole<N>,
    from: TokenTransferDetails,
    timeout?: number,
    fromChain?: ChainContext<N, Chain>,
    toChain?: ChainContext<N, Chain>,
  ): Promise<TokenTransfer<N>>;
  static async from<N extends Network>(
    wh: Wormhole<N>,
    from: WormholeMessageId,
    timeout?: number,
    fromChain?: ChainContext<N, Chain>,
    toChain?: ChainContext<N, Chain>,
  ): Promise<TokenTransfer<N>>;
  static async from<N extends Network>(
    wh: Wormhole<N>,
    from: TransactionId,
    timeout?: number,
    fromChain?: ChainContext<N, Chain>,
    toChain?: ChainContext<N, Chain>,
  ): Promise<TokenTransfer<N>>;
  static async from<N extends Network>(
    wh: Wormhole<N>,
    from: TokenTransferDetails | WormholeMessageId | TransactionId,
    timeout: number = 6000,
    fromChain?: ChainContext<N, Chain>,
    toChain?: ChainContext<N, Chain>,
  ): Promise<TokenTransfer<N>> {
    if (isTokenTransferDetails(from)) {
      fromChain = fromChain ?? wh.getChain(from.from.chain);
      toChain = toChain ?? wh.getChain(from.to.chain);

      // throws if invalid
      TokenTransfer.validateTransferDetails(wh, from, fromChain, toChain);

      // Apply hackery
      from = {
        ...from,
        ...(await TokenTransfer.destinationOverrides(fromChain, toChain, from)),
      };

      return new TokenTransfer(wh, from, fromChain, toChain);
    }

    let tt: TokenTransfer<N>;
    if (isWormholeMessageId(from)) {
      tt = await TokenTransfer.fromIdentifier(wh, from, timeout);
    } else if (isTransactionIdentifier(from)) {
      tt = await TokenTransfer.fromTransaction(wh, from, timeout, fromChain);
    } else {
      throw new Error("Invalid `from` parameter for TokenTransfer");
    }

    tt.fromChain = fromChain ?? wh.getChain(tt.transfer.from.chain);
    tt.toChain = toChain ?? wh.getChain(tt.transfer.to.chain);

    await tt.fetchAttestation(timeout);
    return tt;
  }

  // init from the seq id
  private static async fromIdentifier<N extends Network>(
    wh: Wormhole<N>,
    id: WormholeMessageId,
    timeout?: number,
  ): Promise<TokenTransfer<N>> {
    const vaa = await TokenTransfer.getTransferVaa(wh, id, timeout);
    if (!vaa) throw new Error("VAA not found");
    const automatic = vaa.protocolName === "AutomaticTokenBridge";

    // TODO: the `from.address` here is a lie, but we don't
    // immediately have enough info to get the _correct_ one
    let from = { chain: vaa.emitterChain, address: vaa.emitterAddress };
    let { token, to } = vaa.payload;

    let nativeAddress: NativeAddress<Chain>;
    if (token.chain === from.chain) {
      nativeAddress = await wh.getTokenNativeAddress(from.chain, token.chain, token.address);
    } else {
      const fromChain = await wh.getChain(from.chain);
      const tb = await fromChain.getTokenBridge();
      const wrapped = await tb.getWrappedAsset(token);
      nativeAddress = toNative(from.chain, wrapped.toString());
    }

    const decimals = await wh.getDecimals(from.chain, nativeAddress);
    const scaledAmount = amount.scale(
      amount.fromBaseUnits(token.amount, Math.min(decimals, TokenTransfer.MAX_DECIMALS)),
      decimals,
    );

    let nativeGasAmount: bigint = 0n;
    if (automatic) {
      nativeGasAmount = vaa.payload.payload.toNativeTokenAmount;
      from = { chain: vaa.emitterChain, address: vaa.payload.from };
      to = { chain: vaa.payload.to.chain, address: vaa.payload.payload.targetRecipient };
    }

    const details: TokenTransferDetails = {
      token: token,
      amount: amount.units(scaledAmount),
      from,
      to,
      automatic,
      nativeGas: nativeGasAmount,
    };

    // TODO: grab at least the init tx from the api
    const tt = new TokenTransfer(wh, details);
    tt.attestations = [{ id: id, attestation: vaa }];
    tt._state = TransferState.Attested;
    return tt;
  }

  private static async fromTransaction<N extends Network>(
    wh: Wormhole<N>,
    from: TransactionId,
    timeout: number,
    fromChain?: ChainContext<N, Chain>,
  ): Promise<TokenTransfer<N>> {
    fromChain = fromChain ?? wh.getChain(from.chain);
    const msg = await TokenTransfer.getTransferMessage(fromChain, from.txid, timeout);
    const tt = await TokenTransfer.fromIdentifier(wh, msg, timeout);
    tt.txids = [from];
    return tt;
  }

  // start the WormholeTransfer by submitting transactions to the source chain
  // returns a transaction hash
  async initiateTransfer(signer: Signer): Promise<TxHash[]> {
    if (this._state !== TransferState.Created)
      throw new Error("Invalid state transition in `initiateTransfer`");

    this.txids = await TokenTransfer.transfer<N>(this.fromChain, this.transfer, signer);
    this._state = TransferState.SourceInitiated;
    return this.txids.map(({ txid }) => txid);
  }

  // wait for the VAA to be ready
  // returns the sequence number
  async fetchAttestation(timeout?: number): Promise<AttestationId[]> {
    if (this._state < TransferState.SourceInitiated || this._state > TransferState.Attested)
      throw new Error(
        "Invalid state transition in `fetchAttestation`, expected at least `SourceInitiated`",
      );

    if (!this.attestations || this.attestations.length === 0) {
      if (this.txids.length === 0)
        throw new Error("No VAAs set and txids available to look them up");

      // TODO: assuming the _last_ transaction in the list will contain the msg id
      const txid = this.txids[this.txids.length - 1]!;
      const msgId = await TokenTransfer.getTransferMessage(this.fromChain, txid.txid, timeout);
      this.attestations = [{ id: msgId }];
    }

    for (const idx in this.attestations) {
      // Check if we already have the VAA
      if (this.attestations[idx]!.attestation) continue;

      const vaa = await TokenTransfer.getTransferVaa(this.wh, this.attestations[idx]!.id, timeout);
      if (!vaa) throw new Error("VAA not found");
      this.attestations[idx]!.attestation = vaa;
    }
    this._state = TransferState.Attested;

    if (this.attestations.length > 0) {
      // Check if the transfer has been completed
      const { attestation } = this.attestations[0]!;
      const completed = await TokenTransfer.isTransferComplete(
        this.toChain,
        attestation as TokenTransfer.VAA,
      );
      if (completed) this._state = TransferState.DestinationFinalized;
    }

    return this.attestations.map((vaa) => vaa.id);
  }

  // finish the WormholeTransfer by submitting transactions to the destination chain
  // returns a transaction hash
  async completeTransfer(signer: Signer): Promise<TxHash[]> {
    if (this._state < TransferState.Attested)
      throw new Error(
        "Invalid state transition, must be attested prior to calling `completeTransfer`.",
      );

    if (!this.attestations) throw new Error("No VAA details available");

    const { attestation } = this.attestations[0]!;
    if (!attestation) throw new Error(`No VAA found for ${this.attestations[0]!.id.sequence}`);

    const redeemTxids = await TokenTransfer.redeem<N>(
      this.toChain,
      attestation as TokenTransfer.VAA,
      signer,
    );
    this.txids.push(...redeemTxids);
    this._state = TransferState.DestinationInitiated;
    return redeemTxids.map(({ txid }) => txid);
  }
}

export namespace TokenTransfer {
  /**  8 is maximum precision supported by the token bridge VAA */
  export const MAX_DECIMALS = 8;

  export type Protocol = "TokenBridge" | "AutomaticTokenBridge";
  export type VAA = TokenBridge.TransferVAA | AutomaticTokenBridge.VAA;

  export type AttestationReceipt = _AttestationReceipt<TokenTransfer.Protocol>;
  export type TransferReceipt<
    SC extends Chain = Chain,
    DC extends Chain = Chain,
  > = _TransferReceipt<TokenTransfer.AttestationReceipt, SC, DC>;

  // Static method to perform the transfer so a custom RPC may be used
  // Note: this assumes the transfer has already been validated with `validateTransfer`
  export async function transfer<N extends Network>(
    fromChain: ChainContext<N, Chain>,
    transfer: TokenTransferDetails,
    signer: Signer<N, Chain>,
  ): Promise<TransactionId[]> {
    const senderAddress = toNative(signer.chain(), signer.address());

    const token = isTokenId(transfer.token) ? transfer.token.address : transfer.token;
    let xfer: AsyncGenerator<UnsignedTransaction<N>>;
    if (transfer.automatic) {
      const tb = await fromChain.getAutomaticTokenBridge();
      xfer = tb.transfer(senderAddress, transfer.to, token, transfer.amount, transfer.nativeGas);
    } else {
      const tb = await fromChain.getTokenBridge();
      xfer = tb.transfer(senderAddress, transfer.to, token, transfer.amount, transfer.payload);
    }

    return signSendWait<N, Chain>(fromChain, xfer, signer);
  }

  // Static method to allow passing a custom RPC
  export async function redeem<N extends Network>(
    toChain: ChainContext<N, Chain>,
    vaa: TokenTransfer.VAA,
    signer: Signer<N, Chain>,
  ): Promise<TransactionId[]> {
    const signerAddress = toNative(signer.chain(), signer.address());

    const xfer =
      vaa.protocolName === "AutomaticTokenBridge"
        ? (await toChain.getAutomaticTokenBridge()).redeem(signerAddress, vaa)
        : (await toChain.getTokenBridge()).redeem(signerAddress, vaa);

    return signSendWait<N, Chain>(toChain, xfer, signer);
  }

  // AsyncGenerator fn that produces status updates through an async generator
  // eventually producing a receipt
  // can be called repeatedly so the receipt is updated as it moves through the
  // steps of the transfer
  export async function* track<N extends Network, SC extends Chain, DC extends Chain>(
    wh: Wormhole<N>,
    receipt: TokenTransfer.TransferReceipt<SC, DC>,
    timeout: number = DEFAULT_TASK_TIMEOUT,
    fromChain?: ChainContext<N, SC>,
    toChain?: ChainContext<N, DC>,
  ): AsyncGenerator<TokenTransfer.TransferReceipt<SC, DC>> {
    const start = Date.now();
    const leftover = (start: number, max: number) => Math.max(max - (Date.now() - start), 0);

    fromChain = fromChain ?? wh.getChain(receipt.from);

    // Check the source chain for initiation transaction
    // and capture the message id
    if (isSourceInitiated(receipt)) {
      if (receipt.originTxs.length === 0) throw "Origin transactions required to fetch message id";
      const { txid } = receipt.originTxs[receipt.originTxs.length - 1]!;
      const msg = await TokenTransfer.getTransferMessage(fromChain, txid, leftover(start, timeout));
      receipt = {
        ...receipt,
        state: TransferState.SourceFinalized,
        attestation: { id: msg },
      } satisfies SourceFinalizedTransferReceipt<TokenTransfer.AttestationReceipt>;
      yield receipt;
    }

    // If the source is finalized or in review (governor held), we need to fetch the signed attestation
    // (once it's available) so that we may deliver it to the destination chain
    // or at least track the transfer through its progress
    if (isSourceFinalized(receipt) || isInReview(receipt)) {
      if (!receipt.attestation.id) throw "Attestation id required to fetch attestation";
      const { id } = receipt.attestation;
      const attestation = await TokenTransfer.getTransferVaa(wh, id, leftover(start, timeout));
      if (attestation) {
        receipt = {
          ...receipt,
          attestation: { id, attestation },
          state: TransferState.Attested,
        } satisfies AttestedTransferReceipt<TokenTransfer.AttestationReceipt>;
        yield receipt;
      } else {
        // If the attestation is not found, check if the transfer is held by the governor
        const isEnqueued = await TokenTransfer.isTransferEnqueued(wh, id);
        if (isEnqueued) {
          receipt = {
            ...receipt,
            state: TransferState.InReview,
          } satisfies InReviewTransferReceipt<TokenTransfer.AttestationReceipt>;
          yield receipt;
        }
      }
      throw new Error("Attestation not found");
    }

    // First try to grab the tx status from the API
    // Note: this requires a subsequent async step on the backend
    // to have the dest txid populated, so it may be delayed by some time
    if (isAttested(receipt) || isSourceFinalized(receipt) || isInReview(receipt)) {
      if (!receipt.attestation.id) throw "Attestation id required to fetch redeem tx";
      const { id } = receipt.attestation;
      const txStatus = await wh.getTransactionStatus(id, leftover(start, timeout));
      if (txStatus && txStatus.globalTx?.destinationTx?.txHash) {
        const { chainId, txHash } = txStatus.globalTx.destinationTx;
        receipt = {
          ...receipt,
          destinationTxs: [{ chain: toChainName(chainId) as DC, txid: txHash }],
          state: TransferState.DestinationInitiated,
        } satisfies RedeemedTransferReceipt<TokenTransfer.AttestationReceipt>;
      }
      yield receipt;
    }

    // Fall back to asking the destination chain if this VAA has been redeemed
    // Note: We do not get any destinationTxs with this method
    if (isAttested(receipt) || isRedeemed(receipt)) {
      if (!receipt.attestation.attestation) throw "Signed Attestation required to check for redeem";

      if (receipt.attestation.attestation.payloadName === "AttestMeta") {
        throw new Error("Unable to track an AttestMeta receipt");
      }

      let isComplete = await TokenTransfer.isTransferComplete(
        toChain ?? wh.getChain(receipt.attestation.attestation.payload.to.chain),
        receipt.attestation.attestation as TokenTransfer.VAA,
      );

      if (isComplete) {
        receipt = {
          ...receipt,
          state: TransferState.DestinationFinalized,
        } satisfies CompletedTransferReceipt<TokenTransfer.AttestationReceipt>;
      }

      yield receipt;
    }

    yield receipt;
  }

  export function getReceipt<N extends Network>(xfer: TokenTransfer<N>): TransferReceipt {
    const { transfer } = xfer;

    const from = transfer.from.chain;
    const to = transfer.to.chain;

    let receipt: TransferReceipt = {
      from: from,
      to: to,
      state: TransferState.Created,
    };

    const originTxs = xfer.txids.filter((txid) => txid.chain === transfer.from.chain);
    if (originTxs.length > 0) {
      receipt = {
        ...receipt,
        state: TransferState.SourceInitiated,
        originTxs: originTxs,
      } satisfies SourceInitiatedTransferReceipt;
    }

    const att =
      xfer.attestations && xfer.attestations.length > 0 ? xfer.attestations![0]! : undefined;
    const attestation = att && att.id ? { id: att.id, attestation: att.attestation } : undefined;
    if (attestation) {
      if (attestation.id) {
        receipt = {
          ...(receipt as SourceInitiatedTransferReceipt),
          state: TransferState.SourceFinalized,
          attestation: { id: attestation.id },
        } satisfies SourceFinalizedTransferReceipt<TokenTransfer.AttestationReceipt>;

        if (attestation.attestation) {
          receipt = {
            ...receipt,
            state: TransferState.Attested,
            attestation: { id: attestation.id, attestation: attestation.attestation },
          } satisfies AttestedTransferReceipt<TokenTransfer.AttestationReceipt>;
        }
      }
    }

    const destinationTxs = xfer.txids.filter((txid) => txid.chain === transfer.to.chain);
    if (destinationTxs.length > 0) {
      receipt = {
        ...(receipt as AttestedTransferReceipt<TokenTransfer.AttestationReceipt>),
        state: TransferState.DestinationFinalized,
        destinationTxs: destinationTxs,
      } satisfies CompletedTransferReceipt<TokenTransfer.AttestationReceipt>;
    }

    return receipt;
  }

  // Lookup the token id for the destination chain given the source chain
  // and token id
  export async function lookupDestinationToken<
    N extends Network,
    SC extends Chain,
    DC extends Chain,
  >(
    srcChain: ChainContext<N, SC>,
    dstChain: ChainContext<N, DC>,
    token: TokenId<SC>,
  ): Promise<TokenId<DC>> {
    let lookup: TokenId;
    const tb = await srcChain.getTokenBridge();
    if (isNative(token.address)) {
      // if native, get the wrapped asset id
      const wrappedNative = await tb.getWrappedNative();
      lookup = {
        chain: token.chain,
        address: await tb.getTokenUniversalAddress(wrappedNative),
      };
    } else {
      try {
        // otherwise, check to see if it is a wrapped token locally
        let address: NativeAddress<SC>;
        if (UniversalAddress.instanceof(token.address)) {
          address = (await tb.getWrappedAsset(token)) as NativeAddress<SC>;
        } else {
          address = token.address;
        }
        lookup = await tb.getOriginalAsset(address);
      } catch (e: any) {
        if (!e.message.includes("not a wrapped asset")) throw e;
        // not a from-chain native wormhole-wrapped one
        let address: NativeAddress<SC>;
        if (UniversalAddress.instanceof(token.address)) {
          address = await tb.getTokenNativeAddress(srcChain.chain, token.address);
        } else {
          address = token.address;
        }
        lookup = { chain: token.chain, address: await tb.getTokenUniversalAddress(address) };
      }
    }

    // if the token id is actually native to the destination, return it
    const dstTb = await dstChain.getTokenBridge();
    if (lookup.chain === dstChain.chain) {
      const nativeAddress = await dstTb.getTokenNativeAddress(
        lookup.chain,
        lookup.address as UniversalAddress,
      );
      const destWrappedNative = await dstTb.getWrappedNative();
      if (
        canonicalAddress({ chain: dstChain.chain, address: destWrappedNative }) ===
        canonicalAddress({ chain: dstChain.chain, address: nativeAddress })
      ) {
        return { chain: dstChain.chain, address: "native" };
      }
      return { chain: dstChain.chain, address: nativeAddress };
    }

    // otherwise, figure out what the token address representing the wormhole-wrapped token we're transferring
    const dstAddress = await dstTb.getWrappedAsset(lookup);
    return { chain: dstChain.chain, address: dstAddress };
  }

  export async function isTransferComplete<N extends Network, C extends Chain>(
    toChain: ChainContext<N, C>,
    vaa: TokenTransfer.VAA,
  ): Promise<boolean> {
    if (vaa.protocolName === "AutomaticTokenBridge")
      vaa = deserialize("TokenBridge:TransferWithPayload", serialize(vaa));

    const tb = await toChain.getTokenBridge();
    return tb.isTransferCompleted(vaa);
  }

  export async function getTransferMessage<N extends Network, C extends Chain>(
    chain: ChainContext<N, C>,
    txid: TxHash,
    timeout?: number,
  ): Promise<WormholeMessageId> {
    // A Single wormhole message will be returned for a standard token transfer
    const whm = await Wormhole.parseMessageFromTx(chain, txid, timeout);
    if (whm.length !== 1) throw new Error("Expected a single Wormhole Message, got: " + whm.length);
    return whm[0]!;
  }

  export async function getTransferVaa<N extends Network>(
    wh: Wormhole<N>,
    key: WormholeMessageId | TxHash,
    timeout?: number,
  ): Promise<TokenTransfer.VAA | null> {
    const vaa = await wh.getVaa(key, TokenBridge.getTransferDiscriminator(), timeout);
    if (!vaa) return null;

    // Check if its automatic and re-de-serialize
    if (vaa.payloadName === "TransferWithPayload") {
      const { chain, address } = vaa.payload.to;
      const { tokenBridgeRelayer } = wh.config.chains[chain]!.contracts;
      const relayerAddress = tokenBridgeRelayer ? toUniversal(chain, tokenBridgeRelayer) : null;
      // If the target address is the relayer address, expect its an automatic token bridge vaa
      if (!!relayerAddress && address.equals(relayerAddress)) {
        return deserialize("AutomaticTokenBridge:TransferWithRelay", serialize(vaa));
      }
    }

    return vaa;
  }

  export async function isTransferEnqueued<N extends Network>(
    wh: Wormhole<N>,
    key: WormholeMessageId,
  ): Promise<boolean> {
    return await wh.getIsVaaEnqueued(key);
  }

  export function validateTransferDetails<N extends Network>(
    wh: Wormhole<N>,
    transfer: TokenTransferDetails,
    fromChain?: ChainContext<N, Chain>,
    toChain?: ChainContext<N, Chain>,
  ): void {
    if (transfer.amount === 0n) throw new Error("Amount cannot be 0");

    if (transfer.from.chain === transfer.to.chain)
      throw new Error("Cannot transfer to the same chain");

    fromChain = fromChain ?? wh.getChain(transfer.from.chain);
    toChain = toChain ?? wh.getChain(transfer.to.chain);

    if (transfer.automatic) {
      if (transfer.payload) throw new Error("Payload with automatic delivery is not supported");

      if (!fromChain.supportsAutomaticTokenBridge())
        throw new Error(`Automatic Token Bridge not supported on ${transfer.from.chain}`);

      if (!toChain.supportsAutomaticTokenBridge())
        throw new Error(`Automatic Token Bridge not supported on ${transfer.to.chain}`);

      const nativeGas = transfer.nativeGas ?? 0n;
      if (nativeGas > transfer.amount)
        throw new Error(`Native gas amount  > amount (${nativeGas} > ${transfer.amount})`);
    } else {
      if (transfer.nativeGas)
        throw new Error("Gas Dropoff is only supported for automatic transfers");

      if (!fromChain.supportsTokenBridge())
        throw new Error(`Token Bridge not supported on ${transfer.from.chain}`);

      if (!toChain.supportsTokenBridge())
        throw new Error(`Token Bridge not supported on ${transfer.to.chain}`);
    }
  }

  export async function quoteTransfer<N extends Network>(
    wh: Wormhole<N>,
    srcChain: ChainContext<N, Chain>,
    dstChain: ChainContext<N, Chain>,
    transfer: Omit<TokenTransferDetails, "from" | "to">,
  ): Promise<TransferQuote> {
    const srcTb = await srcChain.getTokenBridge();
    let srcToken: NativeAddress<Chain>;
    if (isNative(transfer.token.address)) {
      srcToken = await srcTb.getWrappedNative();
    } else if (UniversalAddress.instanceof(transfer.token.address)) {
      try {
        srcToken = (await srcTb.getWrappedAsset(transfer.token)) as NativeAddress<Chain>;
      } catch (e: any) {
        if (!e.message.includes("not a wrapped asset")) throw e;
        srcToken = await srcTb.getTokenNativeAddress(srcChain.chain, transfer.token.address);
      }
    } else {
      srcToken = transfer.token.address;
    }
    // @ts-ignore: TS2339
    const srcTokenId = Wormhole.tokenId(srcChain.chain, srcToken.toString());

    const srcDecimals = await srcChain.getDecimals(srcToken);
    const srcAmount = amount.fromBaseUnits(transfer.amount, srcDecimals);
    const srcAmountTruncated = amount.truncate(srcAmount, TokenTransfer.MAX_DECIMALS);

    // Ensure the transfer would not violate governor transfer limits
    const [tokens, limits] = await Promise.all([
      getGovernedTokens(wh.config.api),
      getGovernorLimits(wh.config.api),
    ]);

    const warnings: QuoteWarning[] = [];
    if (limits !== null && srcChain.chain in limits && tokens !== null) {
      let origAsset: TokenId;
      if (isNative(transfer.token.address)) {
        origAsset = {
          chain: srcChain.chain,
          address: await srcTb.getTokenUniversalAddress(srcToken),
        };
      } else {
        try {
          origAsset = await srcTb.getOriginalAsset(transfer.token.address);
        } catch (e: any) {
          if (!e.message.includes("not a wrapped asset")) throw e;
          origAsset = {
            chain: srcChain.chain,
            address: await srcTb.getTokenUniversalAddress(srcToken),
          };
        }
      }

      if (origAsset.chain in tokens && origAsset.address.toString() in tokens[origAsset.chain]!) {
        const limit = limits[srcChain.chain]!;
        const tokenPrice = tokens[origAsset.chain]![origAsset.address.toString()]!;
        const notionalTransferAmt = tokenPrice * amount.whole(srcAmountTruncated);

        if (limit.maxSize && notionalTransferAmt > limit.maxSize) {
          warnings.push({
            type: "GovernorLimitWarning",
            reason: "ExceedsLargeTransferLimit",
          });
        }

        if (notionalTransferAmt > limit.available) {
          warnings.push({
            type: "GovernorLimitWarning",
            reason: "ExceedsRemainingNotional",
          });
        }
      }
    }

    const dstToken = await TokenTransfer.lookupDestinationToken(srcChain, dstChain, transfer.token);
    const dstDecimals = await dstChain.getDecimals(dstToken.address);
    const dstAmountReceivable = amount.scale(srcAmountTruncated, dstDecimals);

    const eta = finality.estimateFinalityTime(srcChain.chain) + guardians.guardianAttestationEta;
    if (!transfer.automatic) {
      return {
        sourceToken: {
          token: transfer.token,
          amount: amount.units(srcAmountTruncated),
        },
        destinationToken: { token: dstToken, amount: amount.units(dstAmountReceivable) },
        warnings: warnings.length > 0 ? warnings : undefined,
        eta,
        expires: time.expiration(24, 0, 0), // manual transfer quote is good for 24 hours
      };
    }

    // Otherwise automatic

    // The fee is removed from the amount transferred
    // quoted on the source chain
    const stb = await srcChain.getAutomaticTokenBridge();
    const fee = await stb.getRelayerFee(dstChain.chain, srcToken);
    const feeAmountDest = amount.scale(
      amount.truncate(amount.fromBaseUnits(fee, srcDecimals), TokenTransfer.MAX_DECIMALS),
      dstDecimals,
    );

    // nativeGas is in source chain decimals
    const srcNativeGasAmountRequested = transfer.nativeGas ?? 0n;
    // convert to destination chain decimals
    const dstNativeGasAmountRequested = amount.units(
      amount.scale(
        amount.truncate(
          amount.fromBaseUnits(srcNativeGasAmountRequested, srcDecimals),
          TokenTransfer.MAX_DECIMALS,
        ),
        dstDecimals,
      ),
    );

    // TODO: consider moving these solana specific checks to its protocol implementation
    const solanaMinBalanceForRentExemptAccount = 890880n;

    let destinationNativeGas = 0n;
    if (transfer.nativeGas) {
      const dtb = await dstChain.getAutomaticTokenBridge();

      // There is a limit applied to the amount of the source
      // token that may be swapped for native gas on the destination
      const [maxNativeAmountIn, _destinationNativeGas] = await Promise.all([
        dtb.maxSwapAmount(dstToken.address),
        // Get the actual amount we should receive
        dtb.nativeTokenAmount(dstToken.address, dstNativeGasAmountRequested),
      ]);

      if (dstNativeGasAmountRequested > maxNativeAmountIn)
        throw new Error(
          `Native gas amount exceeds maximum swap amount: ${amount.fmt(
            dstNativeGasAmountRequested,
            dstDecimals,
          )}>${amount.fmt(maxNativeAmountIn, dstDecimals)}`,
        );

      // when native gas is requested on solana, the amount must be at least the rent-exempt amount
      // or the transaction could fail if the account does not have enough lamports
      if (
        chainToPlatform(dstChain.chain) === "Solana" &&
        _destinationNativeGas < solanaMinBalanceForRentExemptAccount
      ) {
        throw new Error(
          `Native gas amount must be at least ${solanaMinBalanceForRentExemptAccount} lamports`,
        );
      }

      destinationNativeGas = _destinationNativeGas;
    }

    const destAmountLessFee =
      amount.units(dstAmountReceivable) - dstNativeGasAmountRequested - amount.units(feeAmountDest);

    // when sending wsol to solana, the amount must be at least the rent-exempt amount
    // or the transaction could fail if the account does not have enough lamports
    if (chainToPlatform(dstToken.chain) === "Solana") {
      const nativeWrappedTokenId = await dstChain.getNativeWrappedTokenId();
      const isNativeSol = isNative(dstToken.address) || isSameToken(dstToken, nativeWrappedTokenId);
      if (isNativeSol && destAmountLessFee < solanaMinBalanceForRentExemptAccount) {
        throw new Error(
          `Destination amount must be at least ${solanaMinBalanceForRentExemptAccount} lamports`,
        );
      }
    }

    return {
      sourceToken: {
        token: transfer.token,
        amount: amount.units(srcAmountTruncated),
      },
      destinationToken: { token: dstToken, amount: destAmountLessFee },
      relayFee: { token: dstToken, amount: amount.units(feeAmountDest) },
      destinationNativeGas,
      warnings: warnings.length > 0 ? warnings : undefined,
      eta,
      expires: time.expiration(0, 5, 0), // automatic transfer quote is good for 5 minutes
    };
  }

  export async function destinationOverrides<N extends Network>(
    srcChain: ChainContext<N, Chain>,
    dstChain: ChainContext<N, Chain>,
    transfer: TokenTransferDetails,
  ): Promise<TokenTransferDetails> {
    const _transfer = { ...transfer };

    // Bit of (temporary) hackery until solana contracts support being
    // sent a VAA with the primary address
    // Note: Do _not_ override if automatic or if the destination token is native
    // gas token
    if (chainToPlatform(transfer.to.chain) === "Solana" && !_transfer.automatic) {
      const destinationToken = await TokenTransfer.lookupDestinationToken(
        srcChain,
        dstChain,
        _transfer.token,
      );
      if (isNative(destinationToken.address)) {
        const nativeWrappedTokenId = await dstChain.getNativeWrappedTokenId();
        _transfer.to = await dstChain.getTokenAccount(
          _transfer.to.address,
          nativeWrappedTokenId.address,
        );
      } else {
        _transfer.to = await dstChain.getTokenAccount(
          _transfer.to.address,
          destinationToken.address,
        );
      }
    }

    if (_transfer.to.chain === "Sei") {
      if (_transfer.to.chain === "Sei" && _transfer.payload)
        throw new Error("Arbitrary payloads unsupported for Sei");

      // For sei, we reserve the payload for a token transfer through the sei bridge.
      _transfer.payload = encoding.bytes.encode(
        JSON.stringify({
          basic_recipient: {
            recipient: encoding.b64.encode(_transfer.to.address.toString()),
          },
        }),
      );
      const translator = dstChain.config.contracts!.translator;

      if (translator === undefined || translator === "")
        throw new Error("Unexpected empty translator address");

      _transfer.to = Wormhole.chainAddress(_transfer.to.chain, translator);
    }

    return _transfer;
  }
}
