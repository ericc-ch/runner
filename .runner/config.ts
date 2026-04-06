import { consolePlugin, executorNewFnPlugin, defineConfig, searchPlugin } from "../src/main.ts"
import { playwrightPlugin } from "./plugins/playwright.ts"

export default defineConfig({
  plugins: [
    executorNewFnPlugin(),
    consolePlugin(),
    searchPlugin(),
    playwrightPlugin({ headless: true }),
  ],
})
