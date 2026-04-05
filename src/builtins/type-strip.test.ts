import { describe, it } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { typeStripPlugin } from "./type-strip.ts"

describe("typeStripPlugin", () => {
  it("strips type annotations from TypeScript", async () => {
    const plugin = typeStripPlugin()
    const hooks = await plugin()
    const result = await hooks.beforeRun!({
      source: "const x: number = 42",
      context: {},
    })

    strictEqual(result?.source, "const x         = 42")
  })
})
