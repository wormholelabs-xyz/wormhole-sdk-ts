import type { ChainToPlatform, Network } from "@wormhole-foundation/sdk-connect";
import { ChainContext } from "@wormhole-foundation/sdk-connect";
import type { CantonChains } from "./types.js";

export class CantonChain<N extends Network, C extends CantonChains> extends ChainContext<
  N,
  C,
  ChainToPlatform<C>
> {}
