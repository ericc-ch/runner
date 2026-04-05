import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { ConfigSchema, defineConfig, normalizePlugin } from "./config.ts"
import type { Executor, Hooks, Plugin } from "./types.ts"

const makeTestPlugin =
  (hooks: Hooks): Plugin =>
  async () =>
    hooks

describe("normalizePlugin", () => {
  it("preserves all hooks when plugin returns all hooks", async () => {
    const allHooks: Hooks = {
      teardown: async () => {},
      beforeRun: async () => {},
      afterRun: async () => {},
    }
    const plugin = makeTestPlugin(allHooks)
    const normalized = normalizePlugin(plugin)
    const result = await normalized()

    strictEqual(typeof result.teardown, "function")
    strictEqual(typeof result.beforeRun, "function")
    strictEqual(typeof result.afterRun, "function")
    strictEqual(result.executor, undefined)
  })

  it("fills missing hooks with defaults", async () => {
    const partialHooks: Hooks = {
      teardown: async () => {},
    }
    const plugin = makeTestPlugin(partialHooks)
    const normalized = normalizePlugin(plugin)
    const result = await normalized()

    strictEqual(typeof result.teardown, "function")
    strictEqual(typeof result.beforeRun, "function")
    strictEqual(typeof result.afterRun, "function")
  })

  it("returns all defaults when plugin returns no hooks", async () => {
    const plugin = makeTestPlugin({})
    const normalized = normalizePlugin(plugin)
    const result = await normalized()

    strictEqual(typeof result.teardown, "function")
    strictEqual(typeof result.beforeRun, "function")
    strictEqual(typeof result.afterRun, "function")
  })

  it("passes through executor from plugin hooks", async () => {
    const mockExecutor: Executor = {
      name: "test",
      execute: async () => ({ result: 1, error: undefined }),
    }
    const plugin = makeTestPlugin({ executor: mockExecutor })
    const result = await normalizePlugin(plugin)()

    strictEqual(result.executor, mockExecutor)
  })
})

describe("defineConfig", () => {
  it("returns the config as-is", () => {
    const config = ConfigSchema.empty
    deepStrictEqual(defineConfig(config), config)
  })
})
