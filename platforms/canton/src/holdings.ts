// CIP-0056 holdings, read through the Holding interface view.
import {
  DAML_DECIMAL_SCALE,
  HOLDING_INTERFACE_ID,
  HOLDING_INTERFACE_MODULE_AND_ENTITY,
  HOLDINGS_MAX,
  INPUT_HOLDINGS_MAX,
} from "./constants.js";
import type { CantonLedgerClient } from "./ledger.js";
import type { CantonInstrumentId } from "./types.js";
import { parseCantonContractId, parseCantonPartyId } from "./types.js";

/** One holding of a party, from its Holding interface view */
export interface CantonHolding {
  contractId: string;
  owner: string;
  instrumentId: CantonInstrumentId;
  /** The Daml Decimal amount as text */
  amount: string;
  locked: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function interfaceModuleAndEntity(interfaceId: string): string {
  const parts = interfaceId.split(":");
  return parts.length === 3 ? `${parts[1]}:${parts[2]}` : "";
}

/**
 * Holdings owned by the party, from an active-contracts response read with the Holding interface
 * filter and its view. Entries without a Holding view or owned by another party are skipped.
 */
export function parseHoldings(activeContracts: unknown, owner: string): CantonHolding[] {
  if (!Array.isArray(activeContracts)) throw new Error("active-contracts response is not an array");
  if (activeContracts.length > HOLDINGS_MAX)
    throw new Error(`the party has more than ${HOLDINGS_MAX} holdings; merge holdings first`);
  const holdings: CantonHolding[] = [];
  for (const entry of activeContracts) {
    const contractEntry = isObject(entry) ? entry["contractEntry"] : undefined;
    const active = isObject(contractEntry) ? contractEntry["JsActiveContract"] : undefined;
    const createdEvent = isObject(active) ? active["createdEvent"] : undefined;
    if (!isObject(createdEvent)) continue;
    const views = Array.isArray(createdEvent["interfaceViews"])
      ? createdEvent["interfaceViews"]
      : [];
    const holdingView = views.find(
      (view: unknown) =>
        isObject(view) &&
        typeof view["interfaceId"] === "string" &&
        interfaceModuleAndEntity(view["interfaceId"]) === HOLDING_INTERFACE_MODULE_AND_ENTITY,
    ) as Record<string, unknown> | undefined;
    const viewValue = holdingView?.["viewValue"];
    if (!isObject(viewValue) || viewValue["owner"] !== owner) continue;
    const instrumentId = viewValue["instrumentId"];
    if (
      typeof viewValue["amount"] !== "string" ||
      !isObject(instrumentId) ||
      typeof instrumentId["admin"] !== "string" ||
      typeof instrumentId["id"] !== "string"
    )
      continue;
    holdings.push({
      contractId: parseCantonContractId(String(createdEvent["contractId"])),
      owner,
      instrumentId: { admin: parseCantonPartyId(instrumentId["admin"]), id: instrumentId["id"] },
      amount: viewValue["amount"],
      locked: viewValue["lock"] !== null && viewValue["lock"] !== undefined,
    });
  }
  return holdings;
}

/** Reads the CIP-0056 holdings the party owns, through the Holding interface view */
export async function readHoldings(
  ledger: CantonLedgerClient,
  owner: string,
): Promise<CantonHolding[]> {
  const activeAtOffset = await ledger.ledgerEnd();
  const response = await ledger.request("POST", "/v2/state/active-contracts", {
    eventFormat: {
      filtersByParty: {
        [owner]: {
          cumulative: [
            {
              identifierFilter: {
                InterfaceFilter: {
                  value: {
                    interfaceId: HOLDING_INTERFACE_ID,
                    includeInterfaceView: true,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
      verbose: false,
    },
    activeAtOffset,
  });
  return parseHoldings(response, owner);
}

export function sameInstrument(left: CantonInstrumentId, right: CantonInstrumentId): boolean {
  return left.admin === right.admin && left.id === right.id;
}

/**
 * Daml Decimal text to raw units of `decimals` digits. A non-zero digit past `decimals` is
 * rejected; a negative amount is rejected.
 */
export function holdingAmountRaw(
  amountDecimal: string,
  decimals: number = DAML_DECIMAL_SCALE,
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error(`invalid decimals ${decimals}`);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amountDecimal);
  if (!match) throw new Error(`holding amount "${amountDecimal}" is not a non-negative Decimal`);
  const fractionDigits = match[2] ?? "";
  if (/[^0]/.test(fractionDigits.slice(decimals)))
    throw new Error(`holding amount "${amountDecimal}" exceeds ${decimals} decimals`);
  return BigInt(match[1]! + fractionDigits.slice(0, decimals).padEnd(decimals, "0"));
}

/**
 * Unlocked holdings of the instrument, in contract id order, until their sum covers the amount.
 * Throws when at most `maxInputs` holdings do not cover it.
 */
export function selectInputHoldings(
  holdings: readonly CantonHolding[],
  instrumentId: CantonInstrumentId,
  rawAmount: bigint,
  decimals: number,
  maxInputs: number = INPUT_HOLDINGS_MAX,
): string[] {
  const candidates = holdings
    .filter((holding) => !holding.locked && sameInstrument(holding.instrumentId, instrumentId))
    .sort((left, right) =>
      left.contractId < right.contractId ? -1 : left.contractId > right.contractId ? 1 : 0,
    );
  const selected: string[] = [];
  let selectedRaw = 0n;
  for (const holding of candidates) {
    if (selectedRaw >= rawAmount) break;
    if (selected.length === maxInputs) break;
    selected.push(holding.contractId);
    selectedRaw += holdingAmountRaw(holding.amount, decimals);
  }
  if (selectedRaw < rawAmount)
    throw new Error(
      `unlocked holdings of ${instrumentId.id} (admin ${instrumentId.admin}) cover ${selectedRaw} raw in ${maxInputs} holdings or fewer; ${rawAmount} raw needed`,
    );
  return selected;
}

/** Sum of the unlocked holdings of the instrument, in raw units of `decimals` digits */
export function unlockedBalance(
  holdings: readonly CantonHolding[],
  instrumentId: CantonInstrumentId,
  decimals: number = DAML_DECIMAL_SCALE,
): bigint {
  return holdings
    .filter((holding) => !holding.locked && sameInstrument(holding.instrumentId, instrumentId))
    .reduce((sum, holding) => sum + holdingAmountRaw(holding.amount, decimals), 0n);
}
