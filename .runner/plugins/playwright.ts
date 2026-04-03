import { chromium, firefox, webkit, type Browser } from "playwright"
import type { Plugin, RunInput } from "../../src/lib/types.ts"

interface PlaywrightPluginOptions {
  browser?: "chromium" | "firefox" | "webkit"
  headless?: boolean
  launchOptions?: Parameters<typeof chromium.launch>[0]
}

export const playwrightPlugin =
  (options: PlaywrightPluginOptions = {}): Plugin =>
  async () => {
    const { browser: browserType = "chromium", headless = true, launchOptions = {} } = options

    const browsers = { chromium, firefox, webkit }
    let browser: Browser

    return {
      setup: async () => {
        browser = await browsers[browserType].launch({
          headless,
          ...launchOptions,
        })
      },

      beforeRun: async (_input: RunInput) => {
        const context = await browser.newContext()
        const page = await context.newPage()

        return {
          context: {
            browser: Object.assign(browser, {
              description: `Playwright ${browserType} browser instance (shared across runs)`,
            }),
            context: Object.assign(context, {
              description: "Browser context for this execution (isolated state)",
            }),
            page: Object.assign(page, {
              description: "Fresh page for this execution - use this for most operations",
            }),
            playwright: Object.assign(
              { chromium, firefox, webkit },
              {
                description: "Playwright browser types - use to launch additional browsers",
              },
            ),
          },
        }
      },

      teardown: async () => {
        if (browser) {
          await browser.close()
        }
      },
    }
  }
