import { Formatter } from "effect"
import type { Plugin } from "../lib/types.ts"

export const consolePlugin = (): Plugin => async () => {
  let logs: string[]

  return {
    beforeRun: async () => {
      logs = []
      return {
        context: {
          console: Object.assign(
            {
              log: (...args: unknown[]) =>
                logs.push(args.map((arg) => Formatter.format(arg)).join(" ")),
              error: (...args: unknown[]) =>
                logs.push("[ERROR] " + args.map((arg) => Formatter.format(arg)).join(" ")),
              warn: (...args: unknown[]) =>
                logs.push("[WARN] " + args.map((arg) => Formatter.format(arg)).join(" ")),
            },
            { description: "Captured console for logging" },
          ),
        },
      }
    },
    afterRun: async () => {
      return { logs }
    },
  }
}
