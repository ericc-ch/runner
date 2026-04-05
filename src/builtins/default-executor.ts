import { Formatter } from "effect"
import type { Executor, Plugin } from "../lib/types.ts"
import { ExecutionError } from "../lib/errors.ts"

export const defaultExecutor: Executor = {
  name: "new-function",
  execute: async ({ code, context }) => {
    try {
      const params = Object.keys(context)
      const values = Object.values(context)
      // oxlint-disable-next-line typescript/no-implied-eval
      const fn = new Function(
        ...params,
        `"use strict"; return (async () => {\n${code}\n})();`,
      )
      const result = await fn(...values)
      return { result, error: undefined }
    } catch (cause) {
      const error = new ExecutionError({ cause })
      return { result: undefined, error: Formatter.format(error) }
    }
  },
}

/** Registers [`defaultExecutor`]. Add this to `plugins` if you want the usual `new Function` execution. */
export const defaultExecutorPlugin = (): Plugin => async () => ({
  executor: defaultExecutor,
})
