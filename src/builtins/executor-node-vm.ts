import { transformSync } from "amaro"
import { Formatter } from "effect"
import { createContext, runInContext } from "node:vm"
import type { Executor, ExecutorInput, Plugin, RunOutput } from "../lib/types.ts"
import { ExecutionError } from "../lib/errors.ts"

export interface NodeVMOptions {
  /** Execution timeout in milliseconds. Default: 30000 */
  timeout?: number
}

const DEFAULT_TIMEOUT = 30000

/**
 * Creates a sandboxed executor using Node.js `vm` module.
 *
 * **Security Warning:** `node:vm` provides weak isolation. Escape hatches exist
 * via constructor chains (e.g., `this.constructor.constructor('return process')()`).
 * This executor is suitable for semi-trusted code where closures and direct
 * property access are needed (e.g., Playwright).
 *
 * **Timeout Limitation:** The `vm` module timeout only interrupts synchronous
 * execution. Async operations (Promises, timers) continue running after timeout.
 * An `AbortSignal` is provided in context (`abortSignal`) for cooperative abort -
 * code should check `abortSignal.aborted` in loops or before critical operations.
 */
export function createNodeVMExecutor(options?: NodeVMOptions): Executor {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT

  return {
    name: "executorNodeVM",
    async execute({ code, context }: ExecutorInput): Promise<RunOutput> {
      const abortController = new AbortController()

      try {
        // Create sandbox with all globals from globalThis
        // Note: spread operator only copies enumerable properties, so we need
        // to explicitly copy non-enumerable globals like URL, URLSearchParams
        const sandbox: Record<string, unknown> = {
          ...globalThis,
          // Explicitly include non-enumerable globals
          URL: globalThis.URL,
          URLSearchParams: globalThis.URLSearchParams,
          // Provide AbortSignal for cooperative abort
          abortSignal: abortController.signal,
          // Override with user-provided context (takes precedence)
          ...context,
        }

        const vmContext = createContext(sandbox)

        // Wrap code in async function before stripping TypeScript
        // This makes top-level return statements valid
        const wrappedCode = `(async () => {\n${code}\n})()`

        // Strip TypeScript annotations
        const { code: strippedCode } = transformSync(wrappedCode, {
          mode: "strip-only",
        })

        // Schedule abort after timeout
        const timeoutId = setTimeout(() => {
          abortController.abort()
        }, timeout)

        // Execute - vm timeout handles synchronous portion
        // Async operations continue unless code cooperatively checks abortSignal
        const result = await runInContext(strippedCode, vmContext, {
          timeout,
          displayErrors: true,
        })

        clearTimeout(timeoutId)
        return { result, error: undefined }
      } catch (cause) {
        // Abort on error too
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
