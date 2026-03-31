# Runner - TypeScript Execution Engine

Simple TypeScript execution for AI agents. No sandbox, no permissions. Let the agent run wild.

## Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────┐     ┌─────────────┐
│  Agent/AI   │────▶│  Runner (Node.js)                        │────▶│  External   │
│  (MCP client)│     │                                          │     │  APIs       │
└─────────────┘     │  Code runs directly in main process      │           ▲
  ┌─────────────┐   │  - Full access to fetch, fs, child_process│           │
  │  CLI        │──▶│  - Can import any npm package            │───────────┘
  │  user       │   │  - Plugins inject globals via hooks      │
  └─────────────┘   │                                          │
                    └──────────────────────────────────────────┘
```

No sandbox, no worker, no IPC. Code executes in the same Node.js process.

## Configuration

Runner uses config files for plugin composition (Vite-style). Configs cascade: global → local.

### Config Files

```
~/.config/runner/config.ts    # Global config (applies everywhere)
./.runner/config.ts            # Local config (extends global)
```

### Config API

```ts
// .runner/config.ts
import { defineConfig, preset } from "runner"
import playwright from "runner-plugin-playwright" // npm package
import { consolePlugin } from "./plugins/console" // local file

export default defineConfig({
  extends: preset.recommended, // optional: start from preset

  plugins: [
    playwright(), // npm plugin
    consolePlugin(), // local plugin
    async () => ({
      // inline plugin
      beforeRun() {
        return { globals: { foo: "bar" } }
      },
    }),
  ],
})
```

### Loading Order

1. Load global config (`~/.config/runner/config.ts`) if exists
2. Load local config (`./.runner/config.ts`) if exists
3. Merge: `{ ...global, ...local }` with plugins concatenated
4. Plugins run in array order (first to last)

### Presets

Presets are predefined plugin sets for common use cases:

```ts
// Built-in presets
preset.recommended // console, security
preset.browser // playwright

// Custom preset (in a separate file)
// my-preset.ts
import { defineConfig } from "runner"
import consolePlugin from "runner-plugin-console"

export const myPreset = defineConfig({
  plugins: [consolePlugin()],
})
```

## Plugin System

Plugins extend Runner via hooks. Inspired by OpenCode's plugin architecture.

### Plugin API

```ts
// Plugin returns Hooks object
type Plugin = () => Promise<Hooks>

interface Hooks {
  // Global lifecycle
  setup?: () => Promise<void> // Plugin init (once)
  teardown?: () => Promise<void> // Plugin cleanup (once)

  // Per-run lifecycle - return partial to merge
  beforeRun?: (input: RunInput) => Promise<Partial<RunInput> | void>
  afterRun?: (input: RunOutput) => Promise<Partial<RunOutput> | void>
}

interface RunInput {
  source: string
  globals: Record<string, unknown>
}

interface RunOutput {
  value: unknown
}
```

Each hook returns a partial object that gets shallow-merged into state. Return nothing or empty object to skip.

### Hook Flow

```
plugins.map(p => p())  →  hooks[]
         ↓
    hooks.setup (each once)
         ↓
──────────────────────────────────────────
│  state = { source, globals: {} }        │
│         ↓                               │
│  hooks.beforeRun (each, merge return)  │
│    state = { ...state, ...returned }    │
│         ↓                               │
│      execute (core)                     │
│         ↓                               │
│  hooks.afterRun (each, merge return)   │
│    state = { ...state, ...returned }   │
──────────────────────────────────────────
         ↓ (if beforeRun throws, skip to teardown)
    hooks.teardown (each once)
```

**Rules:**

- Hooks run in plugin array order
- Each hook returns partial object → shallow merged into state
- `beforeRun` throws → skip execute → go directly to teardown
- Return nothing/empty object to skip transformation
- Plugins manage their own state

### Plugin Examples

**Console capture**

```ts
const consolePlugin = async () => {
  let logs: string[]

  return {
    beforeRun() {
      logs = [] // Reset each run
      return {
        globals: {
          console: {
            log: (...args) => logs.push(args.join(" ")),
          },
        },
      }
    },
    afterRun(input) {
      return {
        value: { result: input.result, logs, error: input.error },
      }
    },
  }
}
```

**Playwright browser**

```ts
import { chromium } from "playwright"

const playwrightPlugin = async () => {
  let browser: Browser

  return {
    async setup() {
      browser = await chromium.launch()
    },
    async beforeRun() {
      const page = await browser.newPage()
      return {
        globals: {
          page,
          browser,
          playwright: require("playwright"),
        },
      }
    },
    async teardown() {
      await browser?.close()
    },
  }
}
```

**Security/Lint**

```ts
const securityPlugin = async () => {
  return {
    beforeRun(input) {
      // Block dangerous patterns
      if (input.source.includes("eval(")) {
        throw new Error("eval is not allowed")
      }
      if (input.source.includes("process.exit")) {
        throw new Error("process.exit is blocked")
      }

      // Transform source
      return {
        source: input.source.replace(/import.*fs/g, "// fs blocked"),
      }
    },
  }
}
```

**Tools helper**

```ts
const githubPlugin = async () => {
  return {
    beforeRun() {
      return {
        globals: {
          tools: {
            github: {
              issues: {
                list: async (opts: { owner: string; repo: string }) => {
                  const res = await fetch(
                    `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues`,
                  )
                  return res.json()
                },
              },
            },
          },
        },
      }
    },
  }
}
```

**Database**

```ts
import Database from "better-sqlite3"

const databasePlugin = async () => {
  let db: Database

  return {
    async setup() {
      db = new Database("./data.db")
    },
    beforeRun() {
      return { globals: { db } }
    },
    teardown() {
      db?.close()
    },
  }
}
```

## Core Implementation

### types.ts

```ts
export type Plugin = () => Promise<Hooks>

export interface Hooks {
  setup?: () => Promise<void>
  teardown?: () => Promise<void>
  beforeRun?: (input: RunInput) => Promise<Partial<RunInput> | void>
  afterRun?: (input: RunOutput) => Promise<Partial<RunOutput> | void>
}

export interface RunInput {
  source: string
  globals: Record<string, unknown>
}

export interface RunOutput {
  value: unknown
}

export interface Config {
  extends?: Config
  plugins?: Plugin[]
}
```

### config.ts

```ts
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { Config, Plugin } from "./types.js"

const globalConfigPath = join(homedir(), ".config/runner/config.ts")
const localConfigPath = join(process.cwd(), ".runner/config.ts")

export async function loadConfig(): Promise<{ plugins: Plugin[] }> {
  let config: Config = { plugins: [] }

  // Load global config
  if (existsSync(globalConfigPath)) {
    const global = await import(globalConfigPath)
    config = merge(config, global.default)
  }

  // Load local config
  if (existsSync(localConfigPath)) {
    const local = await import(localConfigPath)
    config = merge(config, local.default)
  }

  // Resolve extends
  if (config.extends) {
    config = merge(config.extends, config)
  }

  return config
}

function merge(base: Config, override: Config): Config {
  return {
    ...base,
    ...override,
    plugins: [...(base.plugins ?? []), ...(override.plugins ?? [])],
  }
}

export function defineConfig(config: Config): Config {
  return config
}

// Built-in presets (importable)
export const preset = {
  recommended: defineConfig({
    plugins: [
      async () => ({
        /* console plugin */
      }),
      async () => ({
        /* security plugin */
      }),
    ],
  }),
  browser: defineConfig({
    plugins: [
      async () => ({
        /* playwright plugin */
      }),
    ],
  }),
}
```

### runner.ts

```ts
export async function run(source: string, plugins: Plugin[]): Promise<unknown> {
  const hooks = await Promise.all(plugins.map((p) => p()))

  // Setup phase
  for (const hook of hooks) {
    await hook.setup?.()
  }

  try {
    // beforeRun phase - functional transform
    let state: RunInput = { source, globals: {} }
    for (const hook of hooks) {
      const result = await hook.beforeRun?.(state)
      if (result) state = { ...state, ...result }
    }

    // Execute
    let result: unknown
    let error: Error | null = null
    try {
      result = await execute(state.source, state.globals)
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e))
    }

    // afterRun phase - functional transform
    let output: RunOutput = { value: { result, error } }
    for (const hook of hooks) {
      const result = await hook.afterRun?.({ result, error })
      if (result) output = { ...output, ...result }
    }

    return output.value
  } finally {
    // Teardown phase
    for (const hook of hooks) {
      await hook.teardown?.()
    }
  }
}

async function execute(
  source: string,
  globals: Record<string, unknown>,
): Promise<unknown> {
  const params = Object.keys(globals)
  const fn = new Function(
    ...params,
    `"use strict"; return (async () => {\n${source}\n})();`,
  )
  return fn(...Object.values(globals))
}
```

## Project Structure

```
runner/
├── package.json           # Dependencies
├── src/
│   ├── index.ts           # Main exports (defineConfig, preset, run, types)
│   ├── runner.ts          # Execution engine + hooks orchestration
│   ├── types.ts           # Plugin, Hooks, Config types
│   ├── config.ts          # Config loading (global + local)
│   ├── cli.ts             # CLI entry
│   └── mcp.ts             # MCP server
└── REWRITE.md

# User's project
project/
├── .runner/
│   └── config.ts          # Local config
├── plugins/               # Optional: local plugin files
│   ├── console.ts
│   └── custom.ts
└── package.json           # With runner + plugin deps
```

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.0.0"
  }
}
```

Plugin dependencies (playwright, better-sqlite3, etc.) are peer dependencies - users install what they need.

## Plugin Packages

Plugins are published as npm packages with the `runner-plugin-` prefix:

```bash
npm install runner-plugin-playwright runner-plugin-console
```

```ts
// .runner/config.ts
import playwright from "runner-plugin-playwright"
import console from "runner-plugin-console"

export default defineConfig({
  plugins: [playwright(), console()],
})
```

### Creating a Plugin Package

```ts
// runner-plugin-example/index.ts
import type { Plugin } from 'runner'

export default function examplePlugin(): Plugin {
  return async () => ({
    beforeRun() {
      return { globals: { example: true } }
    }
  })
}

// runner-plugin-example/package.json
{
  "name": "runner-plugin-example",
  "main": "index.ts",
  "peerDependencies": {
    "runner": "^0.1.0"
  }
}
```

## MCP Server

```ts
// mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { loadConfig } from "./config.js"

const config = await loadConfig() // loads global + local
const plugins = config.plugins

const server = new McpServer({ name: "runner", version: "0.1.0" })

server.tool(
  "execute",
  "Execute TypeScript with full Node.js access. Plugins provide globals (browser, db) via hooks.",
  { code: z.string() },
  async ({ code }) => {
    const result = await run(code, plugins)
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: result.error != null,
    }
  },
)

await server.connect(new StdioServerTransport())
```

## CLI

```ts
// cli.ts
import { loadConfig } from "./config.js"

const config = await loadConfig()
const code = process.argv[2] ?? (await readStdin())
const result = await run(code, config.plugins)
console.log(JSON.stringify(result, null, 2))
```

## Security Note

**No security boundary.** Agent code has full Node.js access:

- Filesystem (fs module)
- Network (fetch, http)
- Child processes
- Environment variables
- Any npm imports

This is for trusted agents only. Not for running untrusted code.

Security plugins can block patterns via `beforeRun` hook, but this is advisory - agent can bypass if clever.

## Comparison with Original Executor

| Feature          | Original Executor | Runner                     |
| ---------------- | ----------------- | -------------------------- |
| Runtime          | Bun + Effect.ts   | Node.js (plain)            |
| Sandbox          | Yes (3 runtimes)  | No                         |
| IPC              | Yes               | No                         |
| Permissions      | Yes               | No                         |
| Plugin context   | No                | Yes (hooks inject globals) |
| Plugin lifecycle | Complex           | Simple (setup/teardown)    |
| Lines of code    | ~50,000+          | ~100                       |
| Package count    | 50+               | 1                          |
