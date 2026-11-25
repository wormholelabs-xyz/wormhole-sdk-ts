import { applyChainsConfigConfigOverrides } from "@wormhole-foundation/sdk-connect";
import type { PlatformDefinition } from "../index.js";
import * as _canton from "@wormhole-foundation/sdk-canton";

export const canton: PlatformDefinition<typeof _canton._platform> = {
  Address: _canton.CantonAddress,
  Platform: _canton.CantonPlatform,
  getSigner: _canton.getCantonSigner,
  protocols: {
    WormholeCore: () => import("@wormhole-foundation/sdk-canton-core"),
  },
  getChain: (network, chain, overrides?) =>
    new _canton.CantonChain(
      chain,
      new _canton.CantonPlatform(
        network,
        applyChainsConfigConfigOverrides(network, _canton._platform, {
          [chain]: overrides,
        }),
      ),
    ),
};
export default canton;
