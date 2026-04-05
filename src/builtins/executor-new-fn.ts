import { transformSync } from "amaro"
import { Formatter } from "effect"
import type { Executor, ExecutorInput, Plugin, RunOutput } from "../lib/types.ts"
import { ExecutionError } from "../lib/errors.ts"

export const executorNewFn: Executor = {
  name: "executorNewFn",
  async execute({ code, context }: ExecutorInput): Promise<RunOutput> {
    try {
      // Strip TypeScript annotations before execution
      const { code: strippedCode } = transformSync(code, {
        mode: "strip-only",
      })
      const params = Object.keys(context)
      const values = Object.values(context)
      // oxlint-disable-next-line typescript/no-implied-eval
      const fn = new Function(
        ...params,
        `"use strict"; return (async () => {\n${strippedCode}\n})();`,
      )
      const result = await fn(...values)
      return { result, error: undefined }
    } catch (cause) {
      const error = new ExecutionError({ cause })
      return { result: undefined, error: Formatter.format(error) }
    }
  },
}

export const executorNewFnPlugin = (): Plugin => async () => ({
  executor: executorNewFn,
})
