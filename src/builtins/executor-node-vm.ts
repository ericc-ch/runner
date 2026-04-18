import { transformSync } from "amaro"
import { Formatter } from "effect"
import { createContext, runInContext } from "node:vm"
import type { Executor, Plugin } from "../lib/types.ts"
import { ExecutionError } from "../lib/errors.ts"

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

      try {
        const sandbox = {
          ...globalThis,
          URL: globalThis.URL,
          URLSearchParams: globalThis.URLSearchParams,
          abortSignal: abortController.signal,
          ...context,
        }

        const vmContext = createContext(sandbox)
        const wrappedCode = `(async () => {\n${code}\n})()`
        const { code: strippedCode } = transformSync(wrappedCode, {
          mode: "strip-only",
        })

        const timeoutId = setTimeout(() => {
          abortController.abort()
        }, timeout)

        const result = await runInContext(strippedCode, vmContext, {
          timeout,
          displayErrors: true,
        })

        clearTimeout(timeoutId)
        return { result, error: undefined }
      } catch (cause) {
        abortController.abort()

        const error = new ExecutionError({ cause })
        return { result: undefined, error: Formatter.format(error) }
      }
    },
  }
}

export const executorNodeVMPlugin =
  (options?: NodeVMOptions): Plugin =>
  async () => ({
    executor: createNodeVMExecutor(options),
  })
