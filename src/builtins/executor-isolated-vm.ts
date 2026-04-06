import { transformSync } from "amaro"
import { Formatter } from "effect"
import ivm from "isolated-vm"
import type { Executor, ExecutorInput, Plugin, RunOutput } from "../lib/types.ts"
import { ExecutionError } from "../lib/errors.ts"

const defaultMemoryLimitMb = 128
const defaultTimeoutMs = 30_000

export type IsolatedVmExecutorOptions = {
  /** Isolate memory limit in MB (isolated-vm default is 128, minimum 8). */
  memoryLimitMb?: number
  /** Max script runtime in ms (`0` = no limit). */
  timeoutMs?: number
}

function injectContextValue(globalRef: ivm.Reference, key: string, value: unknown): void {
  if (value === null || value === undefined) {
    globalRef.setSync(key, value as null | undefined)
    return
  }
  const t = typeof value
  if (t === "string" || t === "number" || t === "boolean") {
    globalRef.setSync(key, value as string | number | boolean)
    return
  }
  if (t === "bigint") {
    globalRef.setSync(key, new ivm.ExternalCopy(value as bigint))
    return
  }
  if (t === "function") {
    const fn = value as (...args: unknown[]) => unknown
    if (fn.constructor.name === "AsyncFunction") {
      throw new Error(
        "isolated-vm executor: async functions in `context` are not supported (Callback cannot return Promises across the isolate boundary). Use a synchronous function or the `new Function` executor for full async host bindings.",
      )
    }
    globalRef.setSync(
      key,
      new ivm.Callback((...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args), {
        sync: true,
      }),
    )
    return
  }
  try {
    globalRef.setSync(key, value as object, { copy: true })
  } catch {
    globalRef.setSync(key, new ivm.Reference(value as object), { reference: true })
  }
}

export function createIsolatedVmExecutor(options?: IsolatedVmExecutorOptions): Executor {
  const memoryLimit = options?.memoryLimitMb ?? defaultMemoryLimitMb
  const timeout = options?.timeoutMs ?? defaultTimeoutMs

  return {
    name: "executorIsolatedVm",
    async execute({ code, context }: ExecutorInput): Promise<RunOutput> {
      const isolate = new ivm.Isolate({ memoryLimit })
      try {
        const wrappedCode = `(async () => {\n${code}\n})()`

        const { code: strippedCode } = transformSync(wrappedCode, {
          mode: "strip-only",
        })

        const contextHandle = await isolate.createContext()
        const globalRef = contextHandle.global

        for (const key of Object.keys(context)) {
          injectContextValue(globalRef, key, context[key])
        }

        const script = await isolate.compileScript(
          `"use strict";\n` + strippedCode,
          { filename: "file:///runner-user-code.js" },
        )

        const rawResult = await script.run(contextHandle, {
          ...(timeout > 0 ? { timeout } : {}),
          promise: true,
        })

        let result: unknown = undefined
        if (rawResult instanceof ivm.Reference) {
          result = rawResult.copySync()
        } else {
          result = rawResult
        }

        return { result, error: undefined }
      } catch (cause) {
        const error = new ExecutionError({ cause })
        return { result: undefined, error: Formatter.format(error) }
      } finally {
        isolate.dispose()
      }
    },
  }
}

export const executorIsolatedVm: Executor = createIsolatedVmExecutor()

export const executorIsolatedVmPlugin =
  (options?: IsolatedVmExecutorOptions): Plugin =>
  async () => ({
    executor: createIsolatedVmExecutor(options),
  })
