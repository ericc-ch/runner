import { transformSync } from "amaro"
import { Formatter } from "effect"
import type { Executor, ExecutorInput, Plugin, RunOutput } from "../lib/types.ts"
import { ExecutionError } from "../lib/errors.ts"

export const executorNewFn: Executor = {
  name: "executorNewFn",
  async execute({ code, context }: ExecutorInput): Promise<RunOutput> {
    try {
      const params = Object.keys(context)
      const values = Object.values(context)

      // Wrap code in async function before stripping TypeScript
      // This makes top-level return statements valid
      const wrappedCode = `(async () => {\n${code}\n})()`

      // Strip TypeScript annotations
      const { code: strippedCode } = transformSync(wrappedCode, {
        mode: "strip-only",
      })

      // oxlint-disable-next-line typescript/no-implied-eval
      const fn = new Function(...params, `"use strict"; return ${strippedCode}`)
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
