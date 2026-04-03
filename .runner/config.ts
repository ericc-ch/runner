import { defineConfig } from "../src/main.ts"
import { playwrightPlugin } from "./plugins/playwright.ts"

export default defineConfig({
  plugins: [playwrightPlugin()],
})
