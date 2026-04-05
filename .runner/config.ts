import {
  consolePlugin,
  defineConfig,
  executorNewFnPlugin,
  searchPlugin,
  typeStripPlugin,
} from "../src/main.ts"
import { playwrightPlugin } from "./plugins/playwright.ts"

export default defineConfig({
  plugins: [
    typeStripPlugin(),

    consolePlugin(),
    searchPlugin(),
    playwrightPlugin(),

    executorNewFnPlugin(),
  ],
})
