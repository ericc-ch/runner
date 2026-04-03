import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { ConfigSchema, defineConfig, makeRequiredPlugin } from "./config.ts"
import type { Hooks, Plugin } from "./types.ts"

const makeTestPlugin =
  (hooks: Hooks): Plugin =>
  async () =>
    hooks

describe("makeRequiredPlugin", () => {
  it("preserves all hooks when plugin returns all hooks", async () => {
    const allHooks: Hooks = {
      setup: async () => {},
      teardown: async () => {},
      beforeRun: async () => {},
      afterRun: async () => {},
    }
    const plugin = makeTestPlugin(allHooks)
    const required = makeRequiredPlugin(plugin)
    const result = await required()

    strictEqual(typeof result.setup, "function")
    strictEqual(typeof result.teardown, "function")
    strictEqual(typeof result.beforeRun, "function")
    strictEqual(typeof result.afterRun, "function")
  })

  it("fills missing hooks with defaults", async () => {
    const partialHooks: Hooks = {
      setup: async () => {},
    }
    const plugin = makeTestPlugin(partialHooks)
    const required = makeRequiredPlugin(plugin)
    const result = await required()

    strictEqual(typeof result.setup, "function")
    strictEqual(typeof result.teardown, "function")
    strictEqual(typeof result.beforeRun, "function")
    strictEqual(typeof result.afterRun, "function")
  })

  it("returns all defaults when plugin returns no hooks", async () => {
    const plugin = makeTestPlugin({})
    const required = makeRequiredPlugin(plugin)
    const result = await required()

    strictEqual(typeof result.setup, "function")
    strictEqual(typeof result.teardown, "function")
    strictEqual(typeof result.beforeRun, "function")
    strictEqual(typeof result.afterRun, "function")
  })
})

describe("defineConfig", () => {
  it("returns the config as-is", () => {
    const config = ConfigSchema.empty
    deepStrictEqual(defineConfig(config), config)
  })
})
