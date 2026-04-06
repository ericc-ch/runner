import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { createIsolatedVmExecutor } from "./executor-isolated-vm.ts"

class MockPage {
  private urlValue = "https://example.com"

  async url(): Promise<string> {
    return this.urlValue
  }

  async goto(url: string): Promise<MockPage> {
    this.urlValue = url
    return this
  }

  async locator(selector: string): Promise<MockLocator> {
    return new MockLocator(selector)
  }
}

class MockLocator {
  constructor(private selector: string) {}

  async click(): Promise<void> {}

  async textContent(): Promise<string> {
    return `text from ${this.selector}`
  }
}

describe("createIsolatedVmExecutor", () => {
  const executor = createIsolatedVmExecutor({
    timeoutMs: 5000,
    memoryLimitMb: 32,
  })

  it("runs async user code and returns the result", async () => {
    const out = await executor({
      code: "return 1 + await Promise.resolve(2)",
      context: {},
    })
    strictEqual(out.error, undefined)
    strictEqual(out.result, 3)
  })

  it("injects structured-cloneable context values", async () => {
    const out = await executor({
      code: "return ctx.n + ctx.m",
      context: { ctx: { n: 40, m: 2 } },
    })
    strictEqual(out.error, undefined)
    strictEqual(out.result, 42)
  })

  it("exposes context keys on global and supports sync function callbacks", async () => {
    const out = await executor({
      code: "return double(21)",
      context: {
        double: (x: number) => x * 2,
      },
    })
    strictEqual(out.error, undefined)
    strictEqual(out.result, 42)
  })

  it("returns an error string when user code throws", async () => {
    const out = await executor({
      code: "throw new Error('boom')",
      context: {},
    })
    strictEqual(out.result, undefined)
    strictEqual(typeof out.error, "string")
    strictEqual((out.error as string).includes("boom"), true)
  })

  it("rejects async functions in context with a clear message", async () => {
    const out = await executor({
      code: "return 1",
      context: { f: async () => 1 },
    })
    strictEqual(out.result, undefined)
    strictEqual(typeof out.error, "string")
    strictEqual((out.error as string).includes("async functions"), true)
  })

  describe("live object proxy", () => {
    const executor = createIsolatedVmExecutor({
      timeoutMs: 5000,
      memoryLimitMb: 32,
    })

    it("calls async methods on live objects", async () => {
      const page = new MockPage()
      const out = await executor({
        code: "return await page.url()",
        context: { page },
      })
      strictEqual(out.error, undefined)
      strictEqual(out.result, "https://example.com")
    })

    it("method returning live object creates new proxy", async () => {
      const page = new MockPage()
      const out = await executor({
        code: "const locator = await page.locator('.btn'); return await locator.textContent()",
        context: { page },
      })
      strictEqual(out.error, undefined)
      strictEqual(out.result, "text from .btn")
    })

    it("chains multiple async calls", async () => {
      const page = new MockPage()
      const out = await executor({
        code: "await page.goto('https://test.com'); return await page.url()",
        context: { page },
      })
      strictEqual(out.error, undefined)
      strictEqual(out.result, "https://test.com")
    })
  })
})
