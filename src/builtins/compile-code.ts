import { transformSync } from "amaro"

/** Wrap user code in an async IIFE and strip TypeScript syntax. */
export function compileUserCode(code: string): string {
  const wrappedCode = `(async () => {\n${code}\n})()`
  const { code: strippedCode } = transformSync(wrappedCode, {
    mode: "strip-only",
  })
  return strippedCode
}
