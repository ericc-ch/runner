import { ConfigLoader } from "../src/config/index.ts"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { describe, it, expect } from "vitest"

describe("ConfigLoader", () => {
  it("should load config with no files", async () => {
    const program = Effect.gen(function* () {
      const loader = yield* ConfigLoader
      const config = yield* loader.load()
      return config
    })

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(ConfigLoader.Live),
        Effect.provide(NodeServices.layer),
      ),
    )

    expect(result).toEqual({ plugins: [] })
  })
})
