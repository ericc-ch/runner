import { NodeServices } from "@effect/platform-node"
import { Layer, ManagedRuntime } from "effect"
import { Mcp } from "../mcp.ts"
import { Runner } from "./runner.ts"
import { Config } from "./config.ts"

const MainLayer = Layer.empty.pipe(
  Layer.merge(Mcp.layer),
  Layer.provideMerge(Config.layer),
  Layer.provideMerge(Runner.layer),
  Layer.provideMerge(NodeServices.layer),
)

export const runtime = ManagedRuntime.make(MainLayer)
