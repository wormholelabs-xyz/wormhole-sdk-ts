import type { Network } from "@wormhole-foundation/sdk-connect";

/** Package name of the Wormhole core bridge Daml package */
export const CORE_PACKAGE_NAME = "wormhole-core";

/** Package id of wormhole-core 0.12.3, the only version on the guardians' approved list */
export const CORE_PACKAGE_ID_0_12_3 =
  "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371";

/**
 * The pinned wormhole-core package of a network. Guardians accept a publish under the current
 * package id, or under one retiring id during an upgrade window.
 */
export interface CorePackageIds {
  current: string;
  retiring?: string;
}

/**
 * Pinned wormhole-core packages per network. Testnet and Mainnet are added once the core is
 * deployed there; until then the caller passes them in its config.
 */
export const corePackageIds: { readonly [N in Network]?: CorePackageIds } = {
  Devnet: { current: CORE_PACKAGE_ID_0_12_3 },
};

/** The pinned package ids of a network, current first. Throws if the network has none. */
export function pinnedCorePackageIds(network: Network, override?: CorePackageIds): string[] {
  const ids = override ?? corePackageIds[network];
  if (!ids) throw new Error(`No wormhole-core package id is known for Canton ${network}`);
  return ids.retiring ? [ids.current, ids.retiring] : [ids.current];
}

/** Module and entity of the core templates */
export const CORE_TEMPLATES = {
  CoreState: "Wormhole.Core.State:CoreState",
  EmitterRegistry: "Wormhole.Core.State:EmitterRegistry",
  Emitter: "Wormhole.Core.State:Emitter",
  ReplayRootRegistry: "Wormhole.Core.State:ReplayRootRegistry",
} as const;

/** CIP-0056 Holding interface, by package-name reference */
export const HOLDING_INTERFACE_ID =
  "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";
/** "<module>:<entity>" of the CIP-0056 Holding interface */
export const HOLDING_INTERFACE_MODULE_AND_ENTITY = "Splice.Api.Token.HoldingV1:Holding";

/** A Daml Decimal has 10 fractional digits, so every CIP-0056 amount fits 10 decimals */
export const DAML_DECIMAL_SCALE = 10;

/** Domain-separation tag of the party hash (D1) */
export const PARTY_ADDRESS_TAG = "wormhole:v1";
/** Domain-separation tag of the NTT token address of an instrument */
export const TOKEN_ADDRESS_TAG = "wormhole:ntt-token:v1";
/** Domain-separation tag of the emitter address (State.daml emitterAddressTag) */
export const EMITTER_ADDRESS_TAG = "wormhole:emitter:v1";

/** Timeout of a read request to the JSON Ledger API */
export const LEDGER_REQUEST_TIMEOUT_MS = 15_000;
/**
 * Timeout of a submit-and-wait request. It returns after the synchronizer commits; confirmation by
 * all stakeholder participants can take longer than a read.
 */
export const LEDGER_SUBMIT_TIMEOUT_MS = 120_000;
/** Size cap of a JSON Ledger API response */
export const LEDGER_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
/** One request plus one retry with a new token after a 401 */
export const LEDGER_REQUEST_MAX_ATTEMPTS = 2;

/** Submissions of one transaction, including rebuilds after an inactive-contract rejection */
export const SUBMIT_MAX_ATTEMPTS = 3;
/** Holdings read for one party before the reader refuses */
export const HOLDINGS_MAX = 1000;
/** Holdings selected as inputs of one transfer */
export const INPUT_HOLDINGS_MAX = 16;

/** Module and entity of the core replay trie node */
export const CORE_REPLAY_NODE_TEMPLATE = "Wormhole.Core.Replay:ReplayNode";

/**
 * Base URL of the guardians' core disclosure service (`guardiand canton-disclosure-service`) per
 * network. The service is public and the same for every user of a network, unlike the JSON
 * Ledger API, which is the user's own participant. A network is added once its service is live;
 * until then the caller passes a URL or a disclosure source of its own.
 */
export const coreDisclosureServiceUrls: { readonly [N in Network]?: string } = {};

/** Timeout of a request to a disclosure service */
export const DISCLOSURE_REQUEST_TIMEOUT_MS = 15_000;
/** Size cap of a disclosure service response; one entry is one created event blob */
export const DISCLOSURE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
