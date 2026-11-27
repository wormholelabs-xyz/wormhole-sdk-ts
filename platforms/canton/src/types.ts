import type { PlatformToChains, UniversalOrNative } from "@wormhole-foundation/sdk-connect";

/**
 * Runtime value for the Canton Platform
 */
export const _platform: "Canton" = "Canton";

/**
 * Type for the Canton Platform
 */
export type CantonPlatformType = typeof _platform;

export type CantonChains = PlatformToChains<CantonPlatformType>;
export type UniversalOrCanton = UniversalOrNative<CantonChains>;
export type AnyCantonAddress = UniversalOrCanton | string | Uint8Array;

/** A CIP-0056 instrument: the admin party and the instrument id */
export interface CantonInstrumentId {
  admin: string;
  id: string;
}

// Canton party id: "<hint>::1220<64 lowercase hex>". The hint rule is Canton's
// (UniqueIdentifier.verifyValidString): 1 to 185 characters of [A-Za-z0-9 :_-], split at the
// first "::", and the hint does not end with ":".
const PARTY_SEPARATOR = "::";
const PARTY_HINT_MAX_LENGTH = 185;
const PARTY_HINT_PATTERN = /^[A-Za-z0-9 :_-]+$/;
const PARTY_FINGERPRINT_PATTERN = /^1220[0-9a-f]{64}$/;
export const CANTON_PARTY_ID_MAX_LENGTH = 255;

/** Why a string is not a Canton party id, or undefined when it is one */
function partyIdProblem(text: string): string | undefined {
  const separatorIndex = text.indexOf(PARTY_SEPARATOR);
  if (separatorIndex < 0) return 'no "::"';
  const hint = text.slice(0, separatorIndex);
  const fingerprint = text.slice(separatorIndex + PARTY_SEPARATOR.length);
  if (hint.length < 1 || hint.length > PARTY_HINT_MAX_LENGTH)
    return `the hint has ${hint.length} characters; it must have 1 to ${PARTY_HINT_MAX_LENGTH}`;
  if (!PARTY_HINT_PATTERN.test(hint)) return "the hint has a character outside [A-Za-z0-9 :_-]";
  if (hint.endsWith(":")) return 'the hint ends with ":"';
  if (!PARTY_FINGERPRINT_PATTERN.test(fingerprint))
    return 'the namespace is not "1220" followed by 64 lowercase hex characters';
  if (text.length > CANTON_PARTY_ID_MAX_LENGTH)
    return `it is longer than ${CANTON_PARTY_ID_MAX_LENGTH} characters`;
  return undefined;
}

export function isCantonPartyId(text: string): boolean {
  return partyIdProblem(text) === undefined;
}

/** Returns the text if it is a Canton party id, and throws otherwise */
export function parseCantonPartyId(text: string): string {
  const problem = partyIdProblem(text);
  if (problem !== undefined)
    throw new Error(`Invalid Canton party id "${text.slice(0, 80)}": ${problem}`);
  return text;
}

// Contract id version prefix "00" (V1) or "01" (V2), then lowercase hex.
const CONTRACT_ID_PATTERN = /^0[01](?:[0-9a-f]{2}){32,}$/;
const CONTRACT_ID_MAX_LENGTH = 512;

export function isCantonContractId(text: string): boolean {
  return text.length <= CONTRACT_ID_MAX_LENGTH && CONTRACT_ID_PATTERN.test(text);
}

/** Returns the text if it is a Canton contract id, and throws otherwise */
export function parseCantonContractId(text: string): string {
  if (!isCantonContractId(text))
    throw new Error(`Invalid Canton contract id "${text.slice(0, 80)}"`);
  return text;
}

const PACKAGE_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Returns the text if it is a Daml package id (64 lowercase hex), and throws otherwise */
export function parseCantonPackageId(text: string): string {
  if (!PACKAGE_ID_PATTERN.test(text))
    throw new Error(`Daml package id must be 64 lowercase hex characters, got "${text}"`);
  return text;
}

/** The parts of a "<package id>:<module>:<entity>" template or interface id */
export interface CantonTemplateId {
  packageId: string;
  moduleName: string;
  entityName: string;
}

/**
 * Parses a template id in the package-id reference format. A package-name reference
 * ("#name:Module:Entity") is rejected: it does not pin a package.
 */
export function parseCantonTemplateId(templateId: string): CantonTemplateId {
  const parts = templateId.split(":");
  if (parts.length !== 3 || !parts[1] || !parts[2])
    throw new Error(`Template id must be "<package id>:<module>:<entity>", got "${templateId}"`);
  return {
    packageId: parseCantonPackageId(parts[0]!),
    moduleName: parts[1],
    entityName: parts[2],
  };
}

/** "<module>:<entity>" part of a template id */
export function templateModuleAndEntity(templateId: string): string {
  const parsed = parseCantonTemplateId(templateId);
  return `${parsed.moduleName}:${parsed.entityName}`;
}

// A Ledger API LedgerString: 1 to 255 characters of [A-Za-z0-9#:\-_/ ].
const LEDGER_STRING_PATTERN = /^[A-Za-z0-9#:\-_/ ]{1,255}$/;

/** Returns the text if it is a valid command id (a Ledger API LedgerString), and throws otherwise */
export function parseCantonCommandId(text: string): string {
  if (!LEDGER_STRING_PATTERN.test(text))
    throw new Error(
      `Command id must be 1 to 255 characters of [A-Za-z0-9#:-_/ ], got "${text.slice(0, 80)}"`,
    );
  return text;
}
