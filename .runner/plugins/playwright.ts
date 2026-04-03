import { execSync } from "node:child_process"
import path from "node:path"
import * as playwright from "playwright"
import { paths, type Plugin, type RunInput } from "../../src/main.ts"

const profilePath = path.join(paths.data, "browser")
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

    const context = await playwright.chromium.launchPersistentContext(profilePath, {
      headless,
      executablePath,
    })
    const browser = context.browser() as playwright.Browser

    return {
      beforeRun: async (_input: RunInput) => {
        const page = await context.newPage()

        return {
          context: {
            browser: Object.assign(browser, {
              description: `Playwright browser instance (shared across runs)`,
            }),
            context: Object.assign(context, {
              description: "Browser context for this execution (isolated state)",
            }),
            page: Object.assign(page, {
              description: "Fresh page for this execution - use this for most operations",
            }),
          },
        }
      },

      teardown: async () => {
        await context.close()
      },
    }
  }
