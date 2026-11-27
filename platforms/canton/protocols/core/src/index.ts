import { registerProtocol } from "@wormhole-foundation/sdk-connect";
import { _platform } from "@wormhole-foundation/sdk-canton";
import { CantonWormholeCore } from "./core.js";

registerProtocol(_platform, "WormholeCore", CantonWormholeCore);

export * from "./core.js";
export * from "./coreContracts.js";
export * from "./messages.js";
