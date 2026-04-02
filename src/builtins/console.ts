import type { Plugin } from "../types"

export const consolePlugin = (): Plugin => async () => {
  let logs: string[]

  return {
    setup: async () => {},
    teardown: async () => {},
    beforeRun: async () => {
      logs = []
      return {
        context: {
          console: Object.assign(
            {
              log: (...args: unknown[]) => logs.push(args.join(" ")),
              error: (...args: unknown[]) => logs.push("[ERROR] " + args.join(" ")),
              warn: (...args: unknown[]) => logs.push("[WARN] " + args.join(" ")),
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
