import { describe, it } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import ivm from "isolated-vm"

describe("isolated-vm async callback basics", () => {
  it("async callback returns promise that can be awaited", async () => {
    const isolate = new ivm.Isolate({ memoryLimit: 32 })
    const context = await isolate.createContext()
    const global = context.global

    const asyncRef = new ivm.Reference(async () => {
      return "hello from async"
    })

    global.setSync("asyncFn", asyncRef)

    const result = await context.eval(
      "(async () => { return await asyncFn.applySyncPromise(undefined, []); })()",
      { promise: true },
    )
    strictEqual(result, "hello from async")

    isolate.dispose()
  })

  it("async callback with args", async () => {
    const isolate = new ivm.Isolate({ memoryLimit: 32 })
    const context = await isolate.createContext()
    const global = context.global

    const asyncRef = new ivm.Reference(async (a: number, b: number) => {
      return a + b
    })

    global.setSync("add", asyncRef)

    const result = await context.eval(
      "(async () => { return await add.applySyncPromise(undefined, [1, 2]); })()",
      { promise: true },
    )
    strictEqual(result, 3)

    isolate.dispose()
  })
})
