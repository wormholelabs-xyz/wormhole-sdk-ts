import type {
  Chain,
  ChainContext,
  ChainsConfig,
  ChainToPlatform,
  Network,
  SignedTx,
  StaticPlatformMethods,
  TokenAddress,
  TokenId,
  TxHash,
} from "@wormhole-foundation/sdk-connect";
import {
  PlatformContext,
  chainToPlatform,
  decimals,
  isNative,
  nativeChainIds,
  networkPlatformConfigs,
} from "@wormhole-foundation/sdk-connect";
import { CantonAddress } from "./address.js";
import { CantonChain } from "./chain.js";
import { DAML_DECIMAL_SCALE, coreDisclosureServiceUrls } from "./constants.js";
import type { DisclosureSource } from "./disclosure.js";
import { GuardianDisclosureSource } from "./disclosure.js";
import { readHoldings, unlockedBalance } from "./holdings.js";
import type { FetchFunction, TokenProvider } from "./ledger.js";
import { CantonLedgerClient, staticTokenProvider } from "./ledger.js";
import type { CantonChains, CantonPlatformType } from "./types.js";
import { _platform } from "./types.js";

/** Canton settings that the generic chain config has no field for */
export interface CantonPlatformOptions {
  /**
   * Bearer tokens for the JSON Ledger API. Without one, a chain config `httpHeaders`
   * `Authorization: Bearer <token>` is used as a static token.
   */
  tokenProvider?: TokenProvider;
  /**
   * Where disclosed contracts come from (core protocol, NTT). Without one, the platform uses the
   * guardians' core disclosure service of the network.
   */
  disclosureSource?: DisclosureSource;
  /** Base URL of the core disclosure service, for a network that has no entry in coreDisclosureServiceUrls */
  coreDisclosureServiceUrl?: string;
  /**
   * Token decimals of instruments ("<admin>/<id>") with fewer than 10 decimals, such as an NTT
   * token (its manager's tokenDecimals). getDecimals and getBalance use them.
   */
  instrumentDecimals?: Readonly<Record<string, number>>;
  fetch?: FetchFunction;
}

// A physical synchronizer id ends with "::<protocol>-<serial>"; the Ledger API takes the logical id.
const PHYSICAL_SUFFIX = /::\d+-\d+$/;

function bearerToken(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization");
  const match = entry ? /^Bearer\s+(.+)$/i.exec(entry[1]) : null;
  return match ? match[1] : undefined;
}

function notImplemented(method: string, milestone: string): Error {
  return new Error(`CantonPlatform.${method} is not implemented yet (${milestone})`);
}

/**
 * The Canton platform. The RPC connection is a JSON Ledger API client of the user's own
 * participant; there is no default endpoint.
 */
export class CantonPlatform<N extends Network>
  extends PlatformContext<N, CantonPlatformType>
  implements StaticPlatformMethods<CantonPlatformType, typeof CantonPlatform>
{
  static _platform = _platform;

  readonly options: CantonPlatformOptions;
  private guardianDisclosureSource: GuardianDisclosureSource | undefined;

  constructor(
    network: N,
    config?: ChainsConfig<N, CantonPlatformType>,
    options: CantonPlatformOptions = {},
  ) {
    super(network, config ?? networkPlatformConfigs(network, CantonPlatform._platform));
    this.options = options;
  }

  /**
   * The disclosure source: the configured one, or the guardians' core disclosure service at the
   * static URL of the network. Throws when there is neither.
   */
  disclosureSource(): DisclosureSource {
    if (this.options.disclosureSource) return this.options.disclosureSource;
    if (!this.guardianDisclosureSource) {
      const baseUrl =
        this.options.coreDisclosureServiceUrl ?? coreDisclosureServiceUrls[this.network];
      if (!baseUrl)
        throw new Error(
          `No Canton disclosure source is configured and ${this.network} has no core disclosure service URL`,
        );
      this.guardianDisclosureSource = new GuardianDisclosureSource({
        baseUrl,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
    }
    return this.guardianDisclosureSource;
  }

  override getRpc<C extends CantonChains>(chain: C): CantonLedgerClient {
    const chainConfig = this.config[chain];
    if (!chainConfig?.rpc)
      throw new Error(
        `No JSON Ledger API URL is configured for ${chain}; there is no default, set the chain's rpc`,
      );
    const token = bearerToken(chainConfig.httpHeaders);
    // A configured source travels with the connection, so protocol clients built from it
    // (chain.getWormholeCore()) use it. Without one they use the network's disclosure service.
    const configuredSource =
      this.options.disclosureSource !== undefined ||
      this.options.coreDisclosureServiceUrl !== undefined;
    return new CantonLedgerClient({
      baseUrl: chainConfig.rpc,
      ...(configuredSource ? { disclosureSource: this.disclosureSource() } : {}),
      ...(this.options.instrumentDecimals
        ? { instrumentDecimals: this.options.instrumentDecimals }
        : {}),
      ...(this.options.tokenProvider
        ? { tokenProvider: this.options.tokenProvider }
        : token
        ? { tokenProvider: staticTokenProvider(token) }
        : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }

  override getChain<C extends CantonChains>(
    chain: C,
    rpc?: CantonLedgerClient,
  ): ChainContext<N, C, ChainToPlatform<C>> {
    if (chain in this.config) return new CantonChain<N, C>(chain, this, rpc);
    throw new Error("No configuration available for chain: " + chain);
  }

  static isSupportedChain(chain: Chain): boolean {
    return chainToPlatform(chain) === CantonPlatform._platform;
  }

  static nativeTokenId<N extends Network, C extends CantonChains>(
    _network: N,
    _chain: C,
  ): TokenId<C> {
    throw notImplemented("nativeTokenId", "milestone M5: the Canton Coin instrument");
  }

  static isNativeTokenId<N extends Network, C extends CantonChains>(
    _network: N,
    _chain: C,
    _tokenId: TokenId<C>,
  ): boolean {
    throw notImplemented("isNativeTokenId", "milestone M5: the Canton Coin instrument");
  }

  /**
   * The decimals of a token. A CIP-0056 amount is a Daml Decimal, which has 10 fractional digits,
   * and the ledger keeps no decimals per instrument. An instrument listed in the connection's
   * instrumentDecimals (CantonPlatformOptions) has those decimals, for example an NTT token with
   * its manager's tokenDecimals; every other instrument has 10.
   */
  static async getDecimals<C extends CantonChains>(
    _network: Network,
    _chain: C,
    rpc: CantonLedgerClient,
    token: TokenAddress<C>,
  ): Promise<number> {
    if (isNative(token)) return decimals.nativeDecimals(CantonPlatform._platform);
    const instrument = new CantonAddress(token.toString());
    instrument.toInstrument();
    return rpc.instrumentDecimals[instrument.address] ?? DAML_DECIMAL_SCALE;
  }

  /**
   * The unlocked CIP-0056 balance of a party in an instrument ("<admin>/<id>"), in units of the
   * instrument's decimals (see getDecimals), rounded down. Locked holdings are not counted.
   */
  static async getBalance<C extends CantonChains>(
    network: Network,
    chain: C,
    rpc: CantonLedgerClient,
    walletAddr: string,
    token: TokenAddress<C>,
  ): Promise<bigint | null> {
    if (isNative(token))
      throw notImplemented(
        "getBalance of the native token",
        "milestone M5: the Canton Coin instrument",
      );
    const instrument = new CantonAddress(token.toString()).toInstrument();
    const owner = new CantonAddress(walletAddr).toParty();
    const tokenDecimals = await CantonPlatform.getDecimals(network, chain, rpc, token);
    const balance = unlockedBalance(await readHoldings(rpc, owner), instrument, DAML_DECIMAL_SCALE);
    return balance / 10n ** BigInt(DAML_DECIMAL_SCALE - tokenDecimals);
  }

  /** The participant's ledger end offset. Offsets are local to each participant. */
  static async getLatestBlock(rpc: CantonLedgerClient): Promise<number> {
    return rpc.ledgerEnd();
  }

  /** Same as getLatestBlock: finality on Canton is immediate */
  static async getLatestFinalizedBlock(rpc: CantonLedgerClient): Promise<number> {
    return rpc.ledgerEnd();
  }

  static async sendWait<C extends CantonChains>(
    _chain: C,
    _rpc: CantonLedgerClient,
    _stxns: SignedTx[],
  ): Promise<TxHash[]> {
    throw notImplemented("sendWait", "milestone M4: external-party execution");
  }

  /** The network of a synchronizer id, physical or logical, through the native chain ids */
  static chainFromChainId(chainId: string | bigint): [Network, CantonChains] {
    const synchronizerId = String(chainId).replace(PHYSICAL_SUFFIX, "");
    let pair: readonly [Network, Chain] | undefined;
    try {
      // The Canton entries are typed `never` until a network has a synchronizer id.
      pair = nativeChainIds.platformNativeChainIdToNetworkChain(
        CantonPlatform._platform,
        synchronizerId as never,
      ) as readonly [Network, Chain] | undefined;
    } catch {
      pair = undefined;
    }
    if (!pair || !CantonPlatform.isSupportedChain(pair[1]))
      throw new Error(`Unknown Canton synchronizer id ${synchronizerId}`);
    return [pair[0], pair[1] as CantonChains];
  }

  /** The network of the synchronizers the participant is connected to */
  static async chainFromRpc(rpc: CantonLedgerClient): Promise<[Network, CantonChains]> {
    const synchronizers = await rpc.connectedSynchronizers();
    const known = new Map<string, [Network, CantonChains]>();
    for (const { synchronizerId } of synchronizers) {
      try {
        const pair = CantonPlatform.chainFromChainId(synchronizerId);
        known.set(pair.join("/"), pair);
      } catch {
        // A participant may also be connected to private synchronizers.
      }
    }
    if (known.size !== 1)
      throw new Error(
        `The participant is connected to ${
          synchronizers.map((s) => s.synchronizerId).join(", ") || "no synchronizer"
        }; ` + `expected exactly one known Canton synchronizer, found ${known.size}`,
      );
    return [...known.values()][0]!;
  }
}
