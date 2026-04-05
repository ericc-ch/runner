import {
  consolePlugin,
  defaultExecutorPlugin,
  defineConfig,
  searchPlugin,
} from "../src/main.ts"
import { playwrightPlugin } from "./plugins/playwright.ts"

export default defineConfig({
  plugins: [
    defaultExecutorPlugin(),
    consolePlugin(),
    searchPlugin(),
    playwrightPlugin(),
  ],
})
