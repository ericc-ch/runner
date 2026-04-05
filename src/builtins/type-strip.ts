import { transformSync } from "amaro"
import type { Plugin } from "../lib/types.ts"

export const typeStripPlugin = (): Plugin => async () => ({
  beforeRun: async (input) => {
    const { code } = transformSync(input.source, { mode: "strip-only" })
    return { source: code }
  },
})
