import { Formatter } from "effect"
import { createContext, runInContext } from "node:vm"
import type { Executor, Plugin } from "../lib/types.ts"
import { ExecutionError } from "../lib/errors.ts"
import { compileUserCode } from "./compile-code.ts"

export interface NodeVMOptions {
  /** Execution timeout in milliseconds. Default: 30000 */
  timeout?: number
}

const DEFAULT_TIMEOUT = 30000

export function createNodeVMExecutor(options?: NodeVMOptions): Executor {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT

  return {
    name: "executorNodeVM",
    async execute({ code, context }) {
      const abortController = new AbortController()
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      try {
        // Full Node access via globalThis — VM provides timeout and cooperative abort, not isolation.
        // URL globals must be set explicitly; they are not inherited from globalThis in vm contexts.
        const sandbox = {
          ...globalThis,
          ...context,
          URL: globalThis.URL,
          URLSearchParams: globalThis.URLSearchParams,
          abortSignal: abortController.signal,
        }

        const vmContext = createContext(sandbox)
        const strippedCode = compileUserCode(code)

        // VM timeout interrupts synchronous infinite loops; abortSignal lets async code exit cooperatively.
        timeoutId = setTimeout(() => {
          abortController.abort()
        }, timeout)

        const result = await runInContext(strippedCode, vmContext, {
          timeout,
          displayErrors: true,
        })

        return { result, error: undefined }
      } catch (cause) {
        abortController.abort()

        const error = new ExecutionError({ cause })
        return { result: undefined, error: Formatter.format(error) }
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId)
        }
      }
    },
  }
}

export const executorNodeVMPlugin =
  (options?: NodeVMOptions): Plugin =>
  async () => ({
    executor: createNodeVMExecutor(options),
  })
