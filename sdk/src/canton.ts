/// <reference path="../../platforms/canton/src/index.ts" />
import type { PlatformDefinition } from "./index.js";
const canton = async (): Promise<PlatformDefinition<"Canton">> =>
  (await import("./platforms/canton.js")).default;
export default canton;
