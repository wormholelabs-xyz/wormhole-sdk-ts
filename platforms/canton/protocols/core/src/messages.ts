// Wormhole messages of a Canton transaction, read as the guardian watcher reads them
// (node/pkg/watchers/canton, cantonclient messagesFromTx and decodeWormholeMessage).
import type { UniversalAddress } from "@wormhole-foundation/sdk-connect";
import { encoding } from "@wormhole-foundation/sdk-connect";
import {
  CORE_TEMPLATES,
  emitterAddress,
  parseCantonTemplateId,
} from "@wormhole-foundation/sdk-canton";
import { CORE_CHOICES, decodePublishMessageResult } from "./coreContracts.js";

/** Exercises read from one transaction before the reader refuses */
export const TRANSACTION_EVENTS_MAX = 10_000;

/** A message the guardians accept */
export interface PublishedMessage {
  /** Derived from (registrar, owner, emitterId), as the watcher derives it */
  emitter: UniversalAddress;
  registrar: string;
  owner: string;
  emitterId: bigint;
  sequence: bigint;
  nonce: number;
  consistencyLevel: number;
  payload: Uint8Array;
}

export interface MessageFilter {
  /** The configured guardianGovernance: a message counts only with this registrar */
  guardianGovernance: string;
  /** Pinned package ids: the exercise must execute one of them */
  packageIds: readonly string[];
}

function fieldOf(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

/**
 * The Wormhole messages of a ledger-effects transaction. The JSON Ledger API lists every event
 * of the tree in one flat list, so a PublishMessage nested in another exercise (an NTT Transfer)
 * is found like a top-level one. As the watcher does, an exercise counts when it is a consuming
 * PublishMessage on Wormhole.Core.State:Emitter, executed by a pinned package, whose result's
 * registrar is guardianGovernance. Pinned package plus registrar also covers the watcher's
 * signatory check: the pinned Emitter template is signed by its guardianGovernance, which is the
 * registrar. Every other PublishMessage exercise is listed in `dropped` with the reason.
 */
export function extractPublishedMessages(
  events: readonly unknown[],
  filter: MessageFilter,
): { messages: PublishedMessage[]; dropped: string[] } {
  if (events.length > TRANSACTION_EVENTS_MAX)
    throw new Error(
      `The transaction has ${events.length} events; at most ${TRANSACTION_EVENTS_MAX} are read`,
    );
  const messages: PublishedMessage[] = [];
  const dropped: string[] = [];
  for (const event of events) {
    const exercised = fieldOf(event, "ExercisedEvent");
    if (typeof exercised !== "object" || exercised === null) continue;
    if (fieldOf(exercised, "choice") !== CORE_CHOICES.PublishMessage) continue;
    const templateId = fieldOf(exercised, "templateId");
    if (typeof templateId !== "string") continue;
    const { packageId, moduleName, entityName } = parseCantonTemplateId(templateId);
    if (`${moduleName}:${entityName}` !== CORE_TEMPLATES.Emitter) continue;
    const nodeId = String(fieldOf(exercised, "nodeId"));
    if (!filter.packageIds.includes(packageId)) {
      dropped.push(`node ${nodeId} executes package ${packageId}, which is not pinned`);
      continue;
    }
    if (fieldOf(exercised, "consuming") !== true) {
      dropped.push(`node ${nodeId} is not a consuming exercise`);
      continue;
    }
    const message = decodePublishMessageResult(fieldOf(exercised, "exerciseResult"));
    if (message.registrar !== filter.guardianGovernance) {
      dropped.push(
        `node ${nodeId} has registrar ${message.registrar}, not guardianGovernance ${filter.guardianGovernance}`,
      );
      continue;
    }
    messages.push({
      emitter: emitterAddress(message.registrar, message.owner, message.emitterId),
      registrar: message.registrar,
      owner: message.owner,
      emitterId: message.emitterId,
      sequence: message.sequence,
      nonce: message.nonce,
      consistencyLevel: message.consistencyLevel,
      payload: encoding.hex.decode(message.payload),
    });
  }
  return { messages, dropped };
}
