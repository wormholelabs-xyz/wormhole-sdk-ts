// Disclosure sources: where a submitter that is not a stakeholder gets the contract id and the
// created event blob of each contract its command references. Every source's output must pass
// the anchor checks (anchor.ts) before use; a served payload is never trusted for them.
import {
  CORE_PACKAGE_NAME,
  CORE_REPLAY_NODE_TEMPLATE,
  CORE_TEMPLATES,
  DISCLOSURE_REQUEST_TIMEOUT_MS,
  DISCLOSURE_RESPONSE_MAX_BYTES,
} from "./constants.js";
import type { ActiveContract, CantonLedgerClient, FetchFunction } from "./ledger.js";
import { fetchJsonBounded } from "./ledger.js";
import { parseCantonContractId, templateModuleAndEntity } from "./types.js";

/** A contract a command references, with what the ledger needs to use it */
export interface DisclosedContract {
  /** What the contract is to the caller: "CoreState", "EmitterRegistry", "transceiver Emitter", ... */
  role: string;
  templateId: string;
  contractId: string;
  /** Base64 created event blob */
  createdEventBlob: string;
  synchronizerId: string;
  /** The decoded create argument, when the source has it. Never a trusted input. */
  payload?: unknown;
}

/** A source of disclosed contracts, used by the core protocol and by NTT */
export interface DisclosureSource {
  /** The current CoreState and EmitterRegistry */
  core(): Promise<DisclosedContract[]>;
  /** The replay node of a consumer namespace that covers a VAA digest */
  replayNode?(consumer: string, namespace: string, digest: string): Promise<DisclosedContract>;
  /** The claimed-roots node of a consumer namespace */
  claimedRootsNode?(consumer: string, namespace: string): Promise<DisclosedContract>;
}

/** Roles of the core contracts */
export const CORE_ROLES = {
  CoreState: "CoreState",
  EmitterRegistry: "EmitterRegistry",
} as const;

/** The disclosed contract of an active contract read with its created event blob */
export function disclosedContractFromActive(
  contract: ActiveContract,
  role: string,
): DisclosedContract {
  const { createdEvent, synchronizerId } = contract;
  if (typeof createdEvent.createdEventBlob !== "string" || createdEvent.createdEventBlob === "")
    throw new Error(`${role} ${createdEvent.contractId} has no created event blob`);
  return {
    role,
    templateId: createdEvent.templateId,
    contractId: parseCantonContractId(createdEvent.contractId),
    createdEventBlob: createdEvent.createdEventBlob,
    synchronizerId,
    ...(createdEvent.createArgument !== undefined ? { payload: createdEvent.createArgument } : {}),
  };
}

function fieldOf(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

export interface AcsDisclosureSourceOptions {
  ledger: CantonLedgerClient;
  /** A party on this participant that can read the core contracts */
  reader: string;
  /** The guardianGovernance party; contracts of any other governance party are ignored */
  guardianGovernance: string;
}

/**
 * Reads the core contracts from the participant's active contract set, as a party that can read
 * them. It returns payloads; they are a convenience, not a trust anchor.
 */
export class AcsDisclosureSource implements DisclosureSource {
  constructor(private readonly options: AcsDisclosureSourceOptions) {}

  async core(): Promise<DisclosedContract[]> {
    const wanted = [CORE_ROLES.CoreState, CORE_ROLES.EmitterRegistry] as const;
    const contracts = await this.options.ledger.activeContracts(
      this.options.reader,
      {
        kind: "templates",
        templateIds: wanted.map((role) => `#${CORE_PACKAGE_NAME}:${CORE_TEMPLATES[role]}`),
      },
      { includeCreatedEventBlob: true },
    );
    return wanted.map((role) => {
      const matches = contracts.filter(
        (contract) =>
          templateModuleAndEntity(contract.createdEvent.templateId) === CORE_TEMPLATES[role] &&
          fieldOf(contract.createdEvent.createArgument, "guardianGovernance") ===
            this.options.guardianGovernance,
      );
      if (matches.length !== 1)
        throw new Error(
          `expected one active ${role} of ${this.options.guardianGovernance} visible to ${this.options.reader}, found ${matches.length}`,
        );
      return disclosedContractFromActive(matches[0]!, role);
    });
  }
}

export interface StaticReplayNodeEntry {
  consumer: string;
  namespace: string;
  digest: string;
  contract: DisclosedContract;
}

export interface StaticClaimedRootsNodeEntry {
  consumer: string;
  namespace: string;
  contract: DisclosedContract;
}

export interface StaticDisclosureSourceEntries {
  core: readonly DisclosedContract[];
  replayNodes?: readonly StaticReplayNodeEntry[];
  claimedRootsNodes?: readonly StaticClaimedRootsNodeEntry[];
}

/** Disclosed contracts the caller supplies: tests, and integrators with their own index */
export class StaticDisclosureSource implements DisclosureSource {
  constructor(private readonly entries: StaticDisclosureSourceEntries) {}

  async core(): Promise<DisclosedContract[]> {
    return [...this.entries.core];
  }

  async replayNode(
    consumer: string,
    namespace: string,
    digest: string,
  ): Promise<DisclosedContract> {
    const entry = (this.entries.replayNodes ?? []).find(
      (candidate) =>
        candidate.consumer === consumer &&
        candidate.namespace === namespace &&
        candidate.digest === digest,
    );
    if (!entry)
      throw new Error(
        `no replay node for consumer ${consumer}, namespace ${namespace}, digest ${digest}`,
      );
    return entry.contract;
  }

  async claimedRootsNode(consumer: string, namespace: string): Promise<DisclosedContract> {
    const entry = (this.entries.claimedRootsNodes ?? []).find(
      (candidate) => candidate.consumer === consumer && candidate.namespace === namespace,
    );
    if (!entry)
      throw new Error(`no claimed-roots node for consumer ${consumer}, namespace ${namespace}`);
    return entry.contract;
  }
}

/** Routes of the guardians' core disclosure service */
export const GUARDIAN_DISCLOSURE_ROUTES = {
  CoreState: "/v1/core-state",
  EmitterRegistry: "/v1/emitter-registry",
  ReplayRootRegistry: "/v1/replay-root-registry",
  replayNode: "/v1/replay-node",
  claimedRootsNode: "/v1/claimed-roots-node",
} as const;

/** Roles of the entries that GuardianDisclosureSource returns beyond CORE_ROLES */
export const GUARDIAN_DISCLOSURE_ROLES = {
  ReplayRootRegistry: "ReplayRootRegistry",
  coveringReplayNode: "covering ReplayNode",
  coveringClaimedRootsNode: "covering claimed-roots ReplayNode",
} as const;

export interface GuardianDisclosureSourceOptions {
  /** Base URL of the service, for example the entry of coreDisclosureServiceUrls */
  baseUrl: string;
  fetch?: FetchFunction;
}

/** A request the disclosure service refused or could not serve */
export class DisclosureServiceError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    /** The service's fixed public message, when it sent one */
    readonly publicMessage: string | undefined,
    /** The service's request id, to quote to its operator */
    readonly requestId: string | undefined,
  ) {
    super(
      `disclosure service ${route} answered HTTP ${status}` +
        (publicMessage ? `: ${publicMessage}` : "") +
        (requestId ? ` (request ${requestId})` : ""),
    );
    this.name = "DisclosureServiceError";
  }

  /** True when the index is not ready or busy; the same request can succeed later */
  get retryable(): boolean {
    return this.status === 503;
  }
}

const LOWERCASE_HEX_64 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Reads the core contracts from the guardians' core disclosure service
 * (`guardiand canton-disclosure-service`). The service returns one contract per route, with the
 * created event blob and no decoded payload. It is trusted for liveness only: every entry must
 * still pass the anchor checks, and the ledger rejects a wrong or stale one.
 */
export class GuardianDisclosureSource implements DisclosureSource {
  private readonly baseUrl: string;
  private readonly fetchFunction: FetchFunction | undefined;

  constructor(options: GuardianDisclosureSourceOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new Error(`Disclosure service URL must be http or https, got ${parsed.protocol}`);
    if (parsed.search !== "" || parsed.hash !== "")
      throw new Error("Disclosure service URL must not have a query or a fragment");
    this.baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    this.fetchFunction = options.fetch;
  }

  /** The current CoreState and EmitterRegistry */
  async core(): Promise<DisclosedContract[]> {
    return Promise.all([
      this.lookup(
        GUARDIAN_DISCLOSURE_ROUTES.CoreState,
        CORE_ROLES.CoreState,
        CORE_TEMPLATES.CoreState,
      ),
      this.lookup(
        GUARDIAN_DISCLOSURE_ROUTES.EmitterRegistry,
        CORE_ROLES.EmitterRegistry,
        CORE_TEMPLATES.EmitterRegistry,
      ),
    ]);
  }

  /** The current ReplayRootRegistry, which ClaimReplayRoot needs */
  async replayRootRegistry(): Promise<DisclosedContract> {
    return this.lookup(
      GUARDIAN_DISCLOSURE_ROUTES.ReplayRootRegistry,
      GUARDIAN_DISCLOSURE_ROLES.ReplayRootRegistry,
      CORE_TEMPLATES.ReplayRootRegistry,
    );
  }

  async replayNode(
    consumer: string,
    namespace: string,
    digest: string,
  ): Promise<DisclosedContract> {
    if (!LOWERCASE_HEX_64.test(digest))
      throw new Error("A replay digest is 64 lowercase hex characters");
    return this.lookup(
      GUARDIAN_DISCLOSURE_ROUTES.replayNode,
      GUARDIAN_DISCLOSURE_ROLES.coveringReplayNode,
      CORE_REPLAY_NODE_TEMPLATE,
      { consumer, namespace, digest },
    );
  }

  async claimedRootsNode(consumer: string, namespace: string): Promise<DisclosedContract> {
    return this.lookup(
      GUARDIAN_DISCLOSURE_ROUTES.claimedRootsNode,
      GUARDIAN_DISCLOSURE_ROLES.coveringClaimedRootsNode,
      CORE_REPLAY_NODE_TEMPLATE,
      { consumer, namespace },
    );
  }

  private async lookup(
    route: string,
    role: string,
    expectedModuleAndEntity: string,
    parameters: Record<string, string> = {},
  ): Promise<DisclosedContract> {
    const query = new URLSearchParams(parameters).toString();
    const url = `${this.baseUrl}${route}${query ? `?${query}` : ""}`;
    const response = await fetchJsonBounded(
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      { timeoutMs: DISCLOSURE_REQUEST_TIMEOUT_MS, maxBytes: DISCLOSURE_RESPONSE_MAX_BYTES },
      this.fetchFunction,
    );
    if (response.status !== 200) {
      const publicMessage = fieldOf(response.json, "error");
      const requestId = fieldOf(response.json, "requestId");
      throw new DisclosureServiceError(
        route,
        response.status,
        typeof publicMessage === "string" ? publicMessage.slice(0, 200) : undefined,
        typeof requestId === "string" ? requestId.slice(0, 64) : undefined,
      );
    }
    const templateId = fieldOf(response.json, "templateId");
    const contractId = fieldOf(response.json, "contractId");
    const createdEventBlob = fieldOf(response.json, "createdEventBlob");
    const synchronizerId = fieldOf(response.json, "synchronizerId");
    if (
      typeof templateId !== "string" ||
      typeof contractId !== "string" ||
      typeof createdEventBlob !== "string" ||
      typeof synchronizerId !== "string" ||
      synchronizerId === ""
    )
      throw new Error(`disclosure service ${route} returned a malformed entry`);
    if (!BASE64.test(createdEventBlob))
      throw new Error(
        `disclosure service ${route} returned a created event blob that is not base64`,
      );
    if (templateModuleAndEntity(templateId) !== expectedModuleAndEntity)
      throw new Error(
        `disclosure service ${route} returned template ${templateId.slice(
          0,
          200,
        )}, expected ${expectedModuleAndEntity}`,
      );
    return {
      role,
      templateId,
      contractId: parseCantonContractId(contractId),
      createdEventBlob,
      synchronizerId,
    };
  }
}
