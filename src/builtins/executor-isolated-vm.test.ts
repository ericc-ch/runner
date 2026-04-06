import { describe, it } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { createIsolatedVmExecutor } from "./executor-isolated-vm.ts"

describe("createIsolatedVmExecutor", () => {
  const executor = createIsolatedVmExecutor({ timeoutMs: 5000, memoryLimitMb: 32 })

  it("runs async user code and returns the result", async () => {
    const out = await executor.execute({
      code: "return 1 + await Promise.resolve(2)",
      context: {},
    })
    strictEqual(out.error, undefined)
    strictEqual(out.result, 3)
  })

  it("injects structured-cloneable context values", async () => {
    const out = await executor.execute({
      code: "return ctx.n + ctx.m",
      context: { ctx: { n: 40, m: 2 } },
    })
    strictEqual(out.error, undefined)
    strictEqual(out.result, 42)
  })

  it("exposes context keys on global and supports sync function callbacks", async () => {
    const out = await executor.execute({
      code: "return double(21)",
      context: {
        double: (x: number) => x * 2,
      },
    })
    strictEqual(out.error, undefined)
    strictEqual(out.result, 42)
  })

  it("returns an error string when user code throws", async () => {
    const out = await executor.execute({
      code: "throw new Error('boom')",
      context: {},
    })
    strictEqual(out.result, undefined)
    strictEqual(typeof out.error, "string")
    strictEqual((out.error as string).includes("boom"), true)
  })

  it("rejects async functions in context with a clear message", async () => {
    const out = await executor.execute({
      code: "return 1",
      context: { f: async () => 1 },
    })
    strictEqual(out.result, undefined)
    strictEqual(typeof out.error, "string")
    strictEqual((out.error as string).includes("async functions"), true)
  })
})
