import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual, assertTrue } from "@effect/vitest/utils"
import { createNodeVMExecutor } from "./executor-node-vm.ts"

describe("executorNodeVM", () => {
  const executor = createNodeVMExecutor()

  describe("basic execution", () => {
    it("executes simple code and returns result", async () => {
      const output = await executor.execute({
        code: "return 1 + 1",
        context: {},
      })
      deepStrictEqual(output.result, 2)
      deepStrictEqual(output.error, undefined)
    })

    it("executes async code", async () => {
      const output = await executor.execute({
        code: "return await Promise.resolve(42)",
        context: {},
      })
      deepStrictEqual(output.result, 42)
      deepStrictEqual(output.error, undefined)
    })

    it("handles TypeScript syntax", async () => {
      const output = await executor.execute({
        code: "const x: number = 10\nreturn x * 2",
        context: {},
      })
      deepStrictEqual(output.result, 20)
      deepStrictEqual(output.error, undefined)
    })
  })

  describe("context variables", () => {
    it("accesses context variables", async () => {
      const output = await executor.execute({
        code: "return foo * 2",
        context: { foo: 21 },
      })
      deepStrictEqual(output.result, 42)
    })

    it("context overrides globalThis properties", async () => {
      const output = await executor.execute({
        code: "return customValue",
        context: { customValue: "from-context" },
      })
      deepStrictEqual(output.result, "from-context")
    })
  })

  describe("globals", () => {
    it("has access to console", async () => {
      const output = await executor.execute({
        code: "return typeof console",
        context: {},
      })
      deepStrictEqual(output.result, "object")
    })

    it("has access to setTimeout", async () => {
      const output = await executor.execute({
        code: "return typeof setTimeout",
        context: {},
      })
      deepStrictEqual(output.result, "function")
    })

    it("has access to fetch", async () => {
      const output = await executor.execute({
        code: "return typeof fetch",
        context: {},
      })
      deepStrictEqual(output.result, "function")
    })

    it("has access to URL and URLSearchParams", async () => {
      const output = await executor.execute({
        code: "return typeof URL + ' ' + typeof URLSearchParams",
        context: {},
      })
      deepStrictEqual(output.result, "function function")
    })

    it("provides abortSignal in sandbox", async () => {
      const output = await executor.execute({
        code: "return abortSignal !== undefined && typeof abortSignal.aborted === 'boolean'",
        context: {},
      })
      deepStrictEqual(output.result, true)
    })
  })

  describe("closures", () => {
    it("can create closures over passed objects", async () => {
      const obj = { value: 10 }
      const output = await executor.execute({
        code: "const fn = () => obj.value * 2\nreturn fn()",
        context: { obj },
      })
      deepStrictEqual(output.result, 20)
    })

    it("can modify passed objects", async () => {
      const obj = { count: 0 }
      await executor.execute({
        code: "obj.count += 5",
        context: { obj },
      })
      deepStrictEqual(obj.count, 5)
    })
  })

  describe("timeout", () => {
    it("enforces default timeout (30s)", async () => {
      // This test just verifies the executor accepts the default timeout
      const output = await executor.execute({
        code: "return 'fast'",
        context: {},
      })
      deepStrictEqual(output.result, "fast")
    })

    it("interrupts synchronous execution on timeout", async () => {
      const fastExecutor = createNodeVMExecutor({ timeout: 50 })
      const output = await fastExecutor.execute({
        // Infinite synchronous loop - vm timeout will interrupt
        code: "while (true) {}\nreturn 'done'",
        context: {},
      })
      assertTrue(output.error !== undefined)
    })

    it("provides abortSignal for cooperative abort in async loops", async () => {
      const fastExecutor = createNodeVMExecutor({ timeout: 50 })
      const arr: number[] = []
      const output = await fastExecutor.execute({
        // Cooperative abort - code checks abortSignal.aborted
        code: `for (let i = 0; i < 100 && !abortSignal.aborted; i++) {
          arr.push(i)
          await new Promise(r => setTimeout(r, 10))
        }
        return arr.length`,
        context: { arr },
      })

      // Should have stopped early due to abortSignal
      // With 50ms timeout and 10ms per iteration, expect ~5 iterations
      assertTrue(output.result !== undefined && (output.result as number) < 100)
      // Array should not grow after executor returns
      const lengthAfterReturn = arr.length
      await new Promise((r) => setTimeout(r, 100))
      deepStrictEqual(arr.length, lengthAfterReturn)
    })

    it("context can override abortSignal if needed", async () => {
      // User-provided abortSignal takes precedence
      const customSignal = new AbortController().signal
      const output = await executor.execute({
        code: "return abortSignal === customSignal",
        context: { abortSignal: customSignal, customSignal },
      })
      deepStrictEqual(output.result, true)
    })
  })

  describe("error handling", () => {
    it("returns error for syntax errors", async () => {
      const output = await executor.execute({
        code: "this is not valid",
        context: {},
      })
      assertTrue(output.error !== undefined)
      deepStrictEqual(output.result, undefined)
    })

    it("returns error for runtime errors", async () => {
      const output = await executor.execute({
        code: "throw new Error('test error')",
        context: {},
      })
      assertTrue(output.error !== undefined)
      assertTrue(typeof output.error === "string" && output.error.includes("test error"))
    })

    it("returns error for undefined variable access", async () => {
      const output = await executor.execute({
        code: "return nonexistentVariable",
        context: {},
      })
      assertTrue(output.error !== undefined)
    })
  })

  describe("executor metadata", () => {
    it("has correct name", () => {
      strictEqual(executor.name, "executorNodeVM")
    })
  })
})
