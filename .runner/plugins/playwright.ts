import { execSync } from "node:child_process"
import * as playwright from "playwright"
import { type Plugin, type RunInput } from "../../src/main.ts"

const executablePath = execSync("command -v helium", {
  encoding: "utf-8",
}).trim()

interface PlaywrightPluginOptions {
  headless?: boolean
}

export const playwrightPlugin =
  (options: PlaywrightPluginOptions = {}): Plugin =>
  async () => {
    const { headless = false } = options

    const browser = await playwright.chromium.launch({
      headless,
      executablePath,
    })
    const context = await browser.newContext()
    const page = await browser.newPage()

    return {
      beforeRun: async (_input: RunInput) => {
        return {
          context: {
            browser: Object.assign(browser, {
              description: `Playwright browser instance (shared across runs)`,
            }),
            context: Object.assign(context, {
              description: "Browser context for this execution (isolated state)",
            }),
            page: Object.assign(page, {
              description: "Playwright page for browser automation",
            }),
          },
        }
      },

      teardown: async () => {
        await browser.close()
      },
    }
  }
