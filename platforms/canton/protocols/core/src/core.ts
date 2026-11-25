import type {
  AccountAddress,
  ChainConfig,
  ChainsConfig,
  Contracts,
  Network,
  TxHash,
  UniversalAddress,
  VAA,
  WormholeCore,
  WormholeMessageId,
} from "@wormhole-foundation/sdk-connect";
import { createVAA, encoding, serialize } from "@wormhole-foundation/sdk-connect";
import type {
  AnchorStrategy,
  AnyCantonAddress,
  CantonChains,
  CantonCommand,
  CantonCommandEnvelope,
  CantonLedgerClient,
  CantonPlatformType,
  CorePackageIds,
  DisclosedContract,
  DisclosureSource,
  JsTransaction,
  LfType,
  TransactionReaders,
} from "@wormhole-foundation/sdk-canton";
import {
  BlobEnvelopeAnchor,
  CORE_TEMPLATES,
  CantonAddress,
  CantonUnsignedTransaction,
  GuardianDisclosureSource,
  buildCommandEnvelope,
  checkDisclosedContract,
  coreDisclosureServiceUrls,
  createArgumentToJson,
  decodeTime,
  emitterAddress,
  parseCantonPartyId,
  pinnedCorePackageIds,
  readCreatedEventBlob,
  templateModuleAndEntity,
} from "@wormhole-foundation/sdk-canton";
import type { CoreStateView, EmitterRegistryView, EmitterView } from "./coreContracts.js";
import {
  CORE_CHOICES,
  CORE_STATE_LAYOUT,
  CORE_TEMPLATE_REFERENCES,
  EMITTER_REGISTRY_LAYOUT,
  decodeCoreState,
  decodeEmitter,
  decodeEmitterRegistry,
  parseAndVerifyVaaArgument,
  publishMessageArgument,
  registerEmitterArgument,
} from "./coreContracts.js";
import type { PublishedMessage } from "./messages.js";
import { extractPublishedMessages } from "./messages.js";

/** Entries a disclosure source may return for the core contracts before the client refuses */
export const CORE_DISCLOSURE_ENTRIES_MAX = 16;
/** Emitters read for one owner before the client refuses */
export const EMITTERS_MAX = 100;

const UPDATE_ID_PATTERN = /^1220[0-9a-f]{64}$/;

/** Settings of a CantonWormholeCore beyond the network, the connection and the contracts */
export interface CantonWormholeCoreOptions {
  /**
   * Where CoreState and EmitterRegistry come from. Default: the source of the connection
   * (CantonPlatform options), else the guardians' core disclosure service of the network.
   */
  disclosureSource?: DisclosureSource;
  /** Pinned wormhole-core package ids; default: the network's entry of corePackageIds */
  corePackageIds?: CorePackageIds;
  /** How the guardianGovernance signature of a disclosed contract is checked; default: blob envelope */
  anchorStrategy?: AnchorStrategy;
  /**
   * Parties whose view parseTransaction and parseMessages read when the call names none. Without
   * them, the transaction is read for any party, which needs a token with CanReadAsAnyParty.
   */
  readAs?: readonly string[];
}

/** Per-call options of the commands this client builds */
export interface CantonCommandOptions {
  /** Command id of the transaction; derived from the command content when absent */
  commandId?: string;
}

export interface CantonPublishOptions extends CantonCommandOptions {
  /** The emitter to publish from; required when the sender has several */
  emitterId?: bigint | number;
}

/** An Emitter of an owner under the configured guardianGovernance */
export interface CantonEmitter extends EmitterView {
  contractId: string;
  templateId: string;
  synchronizerId: string;
  /** The Wormhole emitter address, derived as the guardians derive it */
  address: UniversalAddress;
}

function senderParty(sender: AccountAddress<CantonChains> | string): string {
  return new CantonAddress(sender as AnyCantonAddress).toParty();
}

function feeError(what: string, fee: bigint): Error {
  return new Error(
    `The ${what} is ${fee} (10^-10 units of the fee instrument); this client supports only a zero fee until milestone M5`,
  );
}

/** Picks the sender's emitter: the only one, or the one with the requested id */
export function selectEmitter(
  emitters: readonly CantonEmitter[],
  owner: string,
  emitterId?: bigint | number,
): CantonEmitter {
  if (emitterId !== undefined) {
    const wanted = BigInt(emitterId);
    const match = emitters.find((emitter) => emitter.emitterId === wanted);
    if (!match)
      throw new Error(
        `${owner} has no Emitter with id ${wanted}; its emitter ids: ${
          emitters.map((emitter) => emitter.emitterId).join(", ") || "none"
        }`,
      );
    return match;
  }
  if (emitters.length === 0)
    throw new Error(
      `${owner} has no Emitter under this guardianGovernance; register one with registerEmitter first`,
    );
  if (emitters.length > 1)
    throw new Error(
      `${owner} has ${emitters.length} Emitters (ids ${emitters
        .map((emitter) => emitter.emitterId)
        .join(", ")}); pass the emitterId to publish from`,
    );
  return emitters[0]!;
}

/**
 * The Canton core bridge client (wormhole-core). The configured guardianGovernance party
 * (`contracts.coreBridge`) is its root of trust: every disclosed core contract must carry a pinned
 * package id and be signed by that party (plan 5.7), and a published message counts only when its
 * registrar is that party, as the guardian watcher requires.
 */
export class CantonWormholeCore<N extends Network, C extends CantonChains>
  implements WormholeCore<N, C>
{
  /** The configured guardianGovernance party */
  readonly guardianGovernance: string;
  /** Pinned wormhole-core package ids, current first */
  readonly packageIds: readonly string[];
  private readonly anchorStrategy: AnchorStrategy;
  private defaultDisclosureSource: DisclosureSource | undefined;

  readonly options: CantonWormholeCoreOptions;

  /**
   * `_version` is unused: the protocol initializer signature reserves the fifth position for it.
   * CantonWormholeCore.withOptions is the readable way to pass options.
   */
  constructor(
    readonly network: N,
    readonly chain: C,
    readonly connection: CantonLedgerClient,
    readonly contracts: Contracts,
    _version?: string,
    options: CantonWormholeCoreOptions = {},
  ) {
    this.options = options;
    if (!contracts.coreBridge)
      throw new Error(
        `No guardianGovernance party (contracts.coreBridge) is configured for Canton ${network}`,
      );
    this.guardianGovernance = parseCantonPartyId(contracts.coreBridge);
    this.packageIds = pinnedCorePackageIds(network, options.corePackageIds);
    this.anchorStrategy = options.anchorStrategy ?? new BlobEnvelopeAnchor();
  }

  /** A client with options (disclosure source, pinned package ids, anchor strategy, readers) */
  static withOptions<N extends Network, C extends CantonChains>(
    network: N,
    chain: C,
    connection: CantonLedgerClient,
    contracts: Contracts,
    options: CantonWormholeCoreOptions,
  ): CantonWormholeCore<N, C> {
    return new CantonWormholeCore(network, chain, connection, contracts, undefined, options);
  }

  /**
   * Builds the client from the platform config. Canton has one chain, and its network cannot be
   * read from the participant until the synchronizer ids are known, so the config must hold
   * exactly one Canton chain; its network and contracts are used. No ledger call is made.
   */
  static async fromRpc<N extends Network>(
    connection: CantonLedgerClient,
    config: ChainsConfig<N, CantonPlatformType>,
  ): Promise<CantonWormholeCore<N, CantonChains>> {
    const configured = Object.entries(config).filter(([, chainConfig]) => !!chainConfig) as Array<
      [CantonChains, ChainConfig<N, CantonChains>]
    >;
    if (configured.length !== 1)
      throw new Error(
        `CantonWormholeCore.fromRpc needs exactly one configured Canton chain, found ${configured.length}`,
      );
    const [chain, chainConfig] = configured[0]!;
    return new CantonWormholeCore<N, CantonChains>(
      chainConfig.network,
      chain,
      connection,
      chainConfig.contracts,
    );
  }

  /** The disclosure source: configured, from the connection, or the network's service */
  disclosureSource(): DisclosureSource {
    const configured = this.options.disclosureSource ?? this.connection.disclosureSource;
    if (configured) return configured;
    if (!this.defaultDisclosureSource) {
      const baseUrl = coreDisclosureServiceUrls[this.network];
      if (!baseUrl)
        throw new Error(
          `No Canton disclosure source is configured and ${this.network} has no core disclosure service URL`,
        );
      this.defaultDisclosureSource = new GuardianDisclosureSource({ baseUrl });
    }
    return this.defaultDisclosureSource;
  }

  /**
   * The current disclosed CoreState or EmitterRegistry, after the anchor checks: the template is
   * the expected one, its package id is pinned, and guardianGovernance signs it.
   */
  async disclosedCoreContract(role: "CoreState" | "EmitterRegistry"): Promise<DisclosedContract> {
    const entries = await this.disclosureSource().core();
    if (!Array.isArray(entries) || entries.length > CORE_DISCLOSURE_ENTRIES_MAX)
      throw new Error(
        `The disclosure source returned ${
          Array.isArray(entries) ? entries.length : "no list of"
        } entries; expected at most ${CORE_DISCLOSURE_ENTRIES_MAX}`,
      );
    const matches = entries.filter((entry) => entry.role === role);
    if (matches.length !== 1)
      throw new Error(
        `The disclosure source returned ${matches.length} ${role} entries; expected one`,
      );
    const contract = matches[0]!;
    if (templateModuleAndEntity(contract.templateId) !== CORE_TEMPLATES[role])
      throw new Error(
        `The disclosed ${role} has template ${contract.templateId}, expected ${CORE_TEMPLATES[role]}`,
      );
    await checkDisclosedContract(
      contract,
      { guardianGovernance: this.guardianGovernance, packageIds: this.packageIds },
      this.anchorStrategy,
    );
    return contract;
  }

  /**
   * The create argument of a disclosed contract as JSON: the served payload when the source has
   * one, else read from the created event blob with the template's record layout. Either way it
   * has the trust of an RPC read (plan 5.7); only the anchor checks are trusted.
   */
  private createArgumentJson(contract: DisclosedContract, layout: LfType): unknown {
    if (contract.payload !== undefined) return contract.payload;
    return createArgumentToJson(
      readCreatedEventBlob(contract.createdEventBlob).createArgument,
      layout,
    );
  }

  /** The current CoreState and its decoded fields */
  async coreState(): Promise<{ contract: DisclosedContract; state: CoreStateView }> {
    const contract = await this.disclosedCoreContract("CoreState");
    const state = decodeCoreState(this.createArgumentJson(contract, CORE_STATE_LAYOUT));
    if (state.guardianGovernance !== this.guardianGovernance)
      throw new Error(
        `The CoreState payload names guardianGovernance ${state.guardianGovernance}, not ${this.guardianGovernance}`,
      );
    return { contract, state };
  }

  /** The current EmitterRegistry and its decoded fields */
  async emitterRegistry(): Promise<{ contract: DisclosedContract; registry: EmitterRegistryView }> {
    const contract = await this.disclosedCoreContract("EmitterRegistry");
    const registry = decodeEmitterRegistry(
      this.createArgumentJson(contract, EMITTER_REGISTRY_LAYOUT),
    );
    if (registry.guardianGovernance !== this.guardianGovernance)
      throw new Error(
        `The EmitterRegistry payload names guardianGovernance ${registry.guardianGovernance}, not ${this.guardianGovernance}`,
      );
    return { contract, registry };
  }

  async getMessageFee(): Promise<bigint> {
    return (await this.coreState()).state.messageFee;
  }

  async getGuardianSetIndex(): Promise<number> {
    return (await this.coreState()).state.guardianSetIndex;
  }

  /** A stored guardian set: member addresses as 0x-prefixed hex, expiry in seconds (0 when none) */
  async getGuardianSet(index: number): Promise<WormholeCore.GuardianSet> {
    const { state } = await this.coreState();
    const set = state.guardianSets.get(index);
    if (!set)
      throw new Error(
        `Guardian set ${index} is not stored in the CoreState; stored: ${[
          ...state.guardianSets.keys(),
        ].join(", ")}`,
      );
    return {
      index,
      keys: set.addresses.map((address) => `0x${address}`),
      expiry: set.expirationTime ? BigInt(Math.floor(set.expirationTime.getTime() / 1000)) : 0n,
    };
  }

  /**
   * The owner's Emitters under the configured guardianGovernance, read from the owner's own ACS
   * and sorted by id. An Emitter counts only when guardianGovernance signs it.
   */
  async getEmitters(owner: AccountAddress<C> | string): Promise<CantonEmitter[]> {
    const party = senderParty(owner);
    const contracts = await this.connection.activeContracts(party, {
      kind: "templates",
      templateIds: [CORE_TEMPLATE_REFERENCES.Emitter],
    });
    if (contracts.length > EMITTERS_MAX)
      throw new Error(
        `${party} sees ${contracts.length} Emitters; at most ${EMITTERS_MAX} are read`,
      );
    const emitters: CantonEmitter[] = [];
    for (const { createdEvent, synchronizerId } of contracts) {
      if (templateModuleAndEntity(createdEvent.templateId) !== CORE_TEMPLATES.Emitter) continue;
      if (!(createdEvent.signatories ?? []).includes(this.guardianGovernance)) continue;
      const view = decodeEmitter(createdEvent.createArgument);
      if (view.guardianGovernance !== this.guardianGovernance || view.owner !== party) continue;
      const address = emitterAddress(this.guardianGovernance, party, view.emitterId);
      if (encoding.hex.encode(address.toUint8Array()) !== view.emitterAddress)
        throw new Error(
          `Emitter ${createdEvent.contractId} stores address ${view.emitterAddress}, but its identity derives ${address}`,
        );
      emitters.push({
        ...view,
        contractId: createdEvent.contractId,
        templateId: createdEvent.templateId,
        synchronizerId,
        address,
      });
    }
    return emitters.sort((left, right) =>
      left.emitterId < right.emitterId ? -1 : left.emitterId > right.emitterId ? 1 : 0,
    );
  }

  private envelope(
    command: CantonCommand,
    sender: string,
    disclosed: DisclosedContract,
    options: CantonCommandOptions,
  ): CantonCommandEnvelope {
    return buildCommandEnvelope({
      command,
      actAs: [sender],
      disclosedContracts: [disclosed],
      synchronizerId: disclosed.synchronizerId,
      packageIdSelectionPreference: [this.packageIds[0]!],
      ...(options.commandId !== undefined ? { commandId: options.commandId } : {}),
    });
  }

  private unsignedTransaction(
    envelope: CantonCommandEnvelope,
    description: string,
    rebuild: () => Promise<CantonCommandEnvelope>,
  ): CantonUnsignedTransaction<N, C> {
    return new CantonUnsignedTransaction(
      envelope,
      this.network,
      this.chain,
      description,
      false,
      rebuild,
    );
  }

  private async registerEmitterEnvelope(
    requester: string,
    options: CantonCommandOptions,
  ): Promise<CantonCommandEnvelope> {
    const { contract, registry } = await this.emitterRegistry();
    if (registry.registrationFee !== 0n)
      throw feeError("registration fee", registry.registrationFee);
    const command: CantonCommand = {
      ExerciseCommand: {
        templateId: CORE_TEMPLATE_REFERENCES.EmitterRegistry,
        contractId: contract.contractId,
        choice: CORE_CHOICES.RegisterEmitter,
        choiceArgument: registerEmitterArgument(requester, this.guardianGovernance),
      },
    };
    return this.envelope(command, requester, contract, options);
  }

  /**
   * Registers a new Emitter for the sender (Canton only). The registry allocates its id; read it
   * afterwards with getEmitters. Fails when the registration fee is above zero.
   */
  async *registerEmitter(
    sender: AccountAddress<C> | string,
    options: CantonCommandOptions = {},
  ): AsyncGenerator<CantonUnsignedTransaction<N, C>> {
    const requester = senderParty(sender);
    const build = () => this.registerEmitterEnvelope(requester, options);
    yield this.unsignedTransaction(await build(), "CantonWormholeCore.registerEmitter", build);
  }

  private async publishEnvelope(
    owner: string,
    payload: Uint8Array,
    nonce: number,
    consistencyLevel: number,
    options: CantonPublishOptions,
  ): Promise<CantonCommandEnvelope> {
    const [{ contract, state }, emitters] = await Promise.all([
      this.coreState(),
      this.getEmitters(owner),
    ]);
    if (state.messageFee !== 0n) throw feeError("message fee", state.messageFee);
    const emitter = selectEmitter(emitters, owner, options.emitterId);
    if (emitter.synchronizerId !== contract.synchronizerId)
      throw new Error(
        `Emitter ${emitter.emitterId} is on synchronizer ${emitter.synchronizerId}, the CoreState on ${contract.synchronizerId}`,
      );
    const command: CantonCommand = {
      ExerciseCommand: {
        templateId: CORE_TEMPLATE_REFERENCES.Emitter,
        contractId: emitter.contractId,
        choice: CORE_CHOICES.PublishMessage,
        choiceArgument: publishMessageArgument({
          owner,
          coreStateContractId: contract.contractId,
          nonce,
          consistencyLevel,
          payload,
        }),
      },
    };
    return this.envelope(command, owner, contract, options);
  }

  /**
   * Publishes a message from the sender's Emitter, with the CoreState disclosed. The sender pays
   * (fee zero only). With several Emitters, pass `options.emitterId`. No emitter is registered
   * on the way (D4).
   */
  async *publishMessage(
    sender: AccountAddress<C>,
    message: string | Uint8Array,
    nonce: number,
    consistencyLevel: number,
    options: CantonPublishOptions = {},
  ): AsyncGenerator<CantonUnsignedTransaction<N, C>> {
    const owner = senderParty(sender);
    const payload = typeof message === "string" ? encoding.bytes.encode(message) : message;
    const build = () => this.publishEnvelope(owner, payload, nonce, consistencyLevel, options);
    yield this.unsignedTransaction(await build(), "CantonWormholeCore.publishMessage", build);
  }

  private async verifyEnvelope(
    verifier: string,
    encodedVaa: Uint8Array,
    options: CantonCommandOptions,
  ): Promise<CantonCommandEnvelope> {
    const contract = await this.disclosedCoreContract("CoreState");
    const command: CantonCommand = {
      ExerciseCommand: {
        templateId: CORE_TEMPLATE_REFERENCES.CoreState,
        contractId: contract.contractId,
        choice: CORE_CHOICES.ParseAndVerifyVAA,
        choiceArgument: parseAndVerifyVaaArgument(verifier, encodedVaa),
      },
    };
    return this.envelope(command, verifier, contract, options);
  }

  /**
   * Verifies a VAA on the ledger: ParseAndVerifyVAA on the CoreState, with the sender as
   * verifier. It is a transaction, so it uses synchronizer traffic; it fails when the VAA does not
   * verify.
   */
  async *verifyMessage(
    sender: AccountAddress<C>,
    vaa: VAA,
    options: CantonCommandOptions = {},
  ): AsyncGenerator<CantonUnsignedTransaction<N, C>> {
    const verifier = senderParty(sender);
    const encodedVaa = serialize(vaa);
    const build = () => this.verifyEnvelope(verifier, encodedVaa, options);
    yield this.unsignedTransaction(await build(), "CantonWormholeCore.verifyMessage", build);
  }

  private readers(readAs: string | readonly string[] | undefined): TransactionReaders {
    const parties =
      readAs === undefined ? this.options.readAs : typeof readAs === "string" ? [readAs] : readAs;
    if (parties === undefined) return { anyParty: true };
    if (parties.length === 0) throw new Error("readAs is empty");
    return parties.map((party) => parseCantonPartyId(party));
  }

  /** The messages the guardians accept from a transaction, and the transaction */
  async publishedMessages(
    txid: TxHash,
    readAs?: string | readonly string[],
  ): Promise<{ transaction: JsTransaction; messages: PublishedMessage[] }> {
    if (!UPDATE_ID_PATTERN.test(txid))
      throw new Error(
        `A Canton transaction id is an update id: "1220" and 64 lowercase hex, got "${txid}"`,
      );
    const transaction = await this.connection.transactionById(txid, this.readers(readAs));
    const { messages, dropped } = extractPublishedMessages(transaction.events, {
      guardianGovernance: this.guardianGovernance,
      packageIds: this.packageIds,
    });
    if (messages.length === 0 && dropped.length > 0)
      throw new Error(
        `Update ${txid} has ${
          dropped.length
        } PublishMessage exercise(s) that the guardians drop: ${dropped.join("; ")}`,
      );
    return { transaction, messages };
  }

  /**
   * The Wormhole messages of a transaction: each PublishMessage exercise at any depth of the
   * transaction tree, on the pinned package, whose registrar is guardianGovernance. The reader
   * (`readAs`, `options.readAs`, or any party) must be an informee of the transaction.
   */
  async parseTransaction(
    txid: TxHash,
    readAs?: string | readonly string[],
  ): Promise<WormholeMessageId[]> {
    const { messages } = await this.publishedMessages(txid, readAs);
    return messages.map((message) => ({
      chain: this.chain,
      emitter: message.emitter,
      sequence: message.sequence,
    }));
  }

  /**
   * The messages of a transaction as unsigned VAAs. The timestamp is the transaction's ledger
   * effective time in seconds, as the watcher sets it; the guardian set is the current one.
   */
  async parseMessages(
    txid: TxHash,
    readAs?: string | readonly string[],
  ): Promise<VAA<"Uint8Array">[]> {
    const { transaction, messages } = await this.publishedMessages(txid, readAs);
    if (messages.length === 0) return [];
    const effectiveAt = decodeTime(transaction.effectiveAt);
    const timestamp = Math.floor(effectiveAt.getTime() / 1000);
    const guardianSet = await this.getGuardianSetIndex();
    return messages.map((message) =>
      createVAA("Uint8Array", {
        guardianSet,
        timestamp,
        nonce: message.nonce,
        emitterChain: this.chain,
        emitterAddress: message.emitter,
        sequence: message.sequence,
        consistencyLevel: message.consistencyLevel,
        signatures: [],
        payload: message.payload,
      }),
    );
  }
}
