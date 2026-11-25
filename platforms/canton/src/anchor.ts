// Trust anchor checks of disclosed contracts (plan 5.7). The configured guardianGovernance party
// is the root of trust: anyone can create a CoreState signed by parties they control, and whoever
// controls a disclosure response chooses which one the SDK uses.
import { readCreatedEventBlob } from "./blob.js";
import type { DisclosedContract } from "./disclosure.js";
import { parseCantonTemplateId } from "./types.js";

/** What a disclosed core contract must satisfy */
export interface AnchorPolicy {
  /** The configured guardianGovernance party; it must sign every disclosed core contract */
  guardianGovernance: string;
  /** Pinned package ids: the current one, and a retiring one during an upgrade window */
  packageIds: readonly string[];
}

/**
 * How the signatory requirement is checked. The blob envelope check is the primary strategy
 * (D9); a strategy that confirms guardianGovernance with a ledger transaction can replace it.
 */
export interface AnchorStrategy {
  checkSignatory(contract: DisclosedContract, requiredSignatory: string): Promise<void>;
}

/** The disclosed template id must carry a pinned package id */
export function checkPinnedPackage(
  contract: DisclosedContract,
  packageIds: readonly string[],
): void {
  if (packageIds.length === 0) throw new Error("No pinned package id to check against");
  const { packageId } = parseCantonTemplateId(contract.templateId);
  if (!packageIds.includes(packageId))
    throw new Error(
      `${contract.role} ${contract.contractId} has package ${packageId}; pinned: ${packageIds.join(
        ", ",
      )}`,
    );
}

/**
 * Checks the signatories in the blob's envelope. The ledger binds the blob to its contract id, so
 * the contract the command uses is the one the envelope describes. The envelope's contract id and
 * template id must also equal the disclosed ones.
 */
export class BlobEnvelopeAnchor implements AnchorStrategy {
  async checkSignatory(contract: DisclosedContract, requiredSignatory: string): Promise<void> {
    const envelope = readCreatedEventBlob(contract.createdEventBlob);
    if (envelope.contractId !== contract.contractId)
      throw new Error(
        `${contract.role}: the blob is for contract ${envelope.contractId}, not ${contract.contractId}`,
      );
    if (envelope.templateId !== contract.templateId)
      throw new Error(
        `${contract.role}: the blob has template ${envelope.templateId}, not ${contract.templateId}`,
      );
    if (!envelope.signatories.includes(requiredSignatory))
      throw new Error(
        `${contract.role} ${contract.contractId} is not signed by ${requiredSignatory}`,
      );
  }
}

/** Checks one disclosed contract: pinned package, then the signatory through the strategy */
export async function checkDisclosedContract(
  contract: DisclosedContract,
  policy: AnchorPolicy,
  strategy: AnchorStrategy = new BlobEnvelopeAnchor(),
): Promise<void> {
  checkPinnedPackage(contract, policy.packageIds);
  await strategy.checkSignatory(contract, policy.guardianGovernance);
}

/** Checks every disclosed contract; returns them unchanged when all pass */
export async function checkDisclosedContracts(
  contracts: readonly DisclosedContract[],
  policy: AnchorPolicy,
  strategy: AnchorStrategy = new BlobEnvelopeAnchor(),
): Promise<DisclosedContract[]> {
  for (const contract of contracts) await checkDisclosedContract(contract, policy, strategy);
  return [...contracts];
}
