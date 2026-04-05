import { consolePlugin, defineConfig, executorNewFnPlugin, searchPlugin } from "../src/main.ts"
import { playwrightPlugin } from "./plugins/playwright.ts"

export default defineConfig({
  plugins: [
    consolePlugin(),
    searchPlugin(),
    playwrightPlugin(),

    executorNewFnPlugin(),
  ],
})
