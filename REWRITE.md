# Runner - TypeScript Execution Engine

Simple TypeScript execution for AI agents. No sandbox, no permissions. Let the agent run wild.

Built with [Effect v4](https://github.com/Effect-TS/effect-smol/blob/main/LLMS.md).

## Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────┐     ┌─────────────┐
│  Agent/AI   │────▶│  Runner (Node.js)                        │────▶│  External   │
│  (MCP client)│     │                                          │     │  APIs       │
└─────────────┘     │  Code runs directly in main process      │           ▲
  ┌─────────────┐   │  - Full access to fetch, fs, child_process│           │
  │  CLI        │──▶│  - Can import any npm package            │───────────┘
  │  user       │   │  - Plugins inject context via hooks     │
  └─────────────┘   │                                          │
                    └──────────────────────────────────────────┘
```

No sandbox, no worker, no IPC. Code executes in the same Node.js process.

## Configuration

Runner uses config files for plugin composition (Vite-style). Configs cascade: global → local.

### Config Files

```
~/.config/runner/config.ts    # Global config (applies everywhere)
./.runner/config.ts            # Local config
```

### Config API

```ts
// .runner/config.ts
import { defineConfig } from "@ericc-ch/runner"
import playwright from "runner-plugin-playwright" // npm package
import { consolePlugin } from "./plugins/console" // local file

export default defineConfig({
  plugins: [
    playwright(), // npm plugin
    consolePlugin(), // local plugin
    async () => ({
      // inline plugin
      beforeRun() {
        return {
          context: {
            // Simple: just pass the value
            db: someDatabase,
            // With description: attach .description property
            browser: Object.assign(browser, {
              description: "Playwright browser for web automation",
            }),
          },
        }
      },
    }),
  ],
})
```

### Loading Order

1. Load global config (`~/.config/runner/config.ts`) if exists
2. Load local config (`./.runner/config.ts`) if exists
3. Merge with `defu`: local overlays global
4. Plugins run in array order (first to last)

## Plugin System

Plugins extend Runner via hooks. Inspired by OpenCode's plugin architecture.

### Plugin API

```ts
// Plugin returns Hooks object
type Plugin = () => Promise<Hooks>

interface Hooks {
  // Global lifecycle
  setup: () => Promise<void> // Plugin init (once)
  teardown: () => Promise<void> // Plugin cleanup (once)

  // Per-run lifecycle - return partial to merge
  beforeRun: (input: RunInput) => Promise<Partial<RunInput> | void>
  afterRun: (input: RunOutput) => Promise<Partial<RunOutput> | void>
}

interface RunInput {
  source: string
  context: Record<string, unknown> // Just values, no wrapper
}

interface RunOutput {
  result: unknown
  error: Error | null
}
```

**Context Registration:**

Plugins return bare values in `context`. Descriptions are optional - just attach a `.description` property:

```ts
// Simple - no description
context: {
  db: database
}

// With description - use Object.assign or spread
context: {
  browser: Object.assign(browser, { description: "Playwright browser" })
}

// Or define the value with description upfront
const myTool = Object.assign(
  () => {
    /* ... */
  },
  { description: "Does something useful" },
)
context: {
  tool: myTool
}
```

Each hook returns a partial object that gets shallow-merged into state. Return nothing or empty object to skip.

### Hook Flow

```
plugins.map(p => p())  →  hooks[]
         ↓
    hooks.setup (each once, acquire/release pattern)
         ↓
──────────────────────────────────────────
│  state = { source, context: {} }        │
│         ↓                               │
│  hooks.beforeRun (each, merge return)  │
│    state = { ...state, ...returned }    │
│         ↓                               │
│      execute (core)                     │
│         ↓                               │
│  output = { result, error }            │
│         ↓                               │
│  hooks.afterRun (each, merge return)   │
│    output = { ...output, ...returned } │
──────────────────────────────────────────
         ↓ (if beforeRun throws, skip to teardown)
    hooks.teardown (each once, guaranteed by acquire/release)
```

**Rules:**

- Hooks run in plugin array order
- `beforeRun` returns partial → shallow merged into `state`
- `afterRun` returns partial → shallow merged into `output`
- `beforeRun` throws → skip execute → go directly to teardown
- Return nothing/empty object to skip transformation
- Plugins manage their own state
- Teardown is guaranteed via Effect's acquire/release pattern

### Plugin Examples

**Console capture**

```ts
const consolePlugin = async () => {
  let logs: string[]

  return {
    setup() {
      // Initialize if needed
    },
    teardown() {
      // Cleanup if needed
    },
    beforeRun() {
      logs = [] // Reset each run
      return {
        context: {
          console: Object.assign(
            {
              log: (...args) => logs.push(args.join(" ")),
              error: (...args) => logs.push("[ERROR] " + args.join(" ")),
              warn: (...args) => logs.push("[WARN] " + args.join(" ")),
            },
            { description: "Captured console for logging" },
          ),
        },
      }
    },
    afterRun({ result, error }) {
      return {
        result: { result, logs, error },
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
        context: {
          browser: Object.assign(browser, {
            description: "Playwright browser instance for web automation",
          }),
          page: Object.assign(page, {
            description: "Active browser page, use for navigation/clicks",
          }),
          playwright: Object.assign(require("playwright"), {
            description: "Playwright module with browser launchers",
          }),
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
    setup() {},
    teardown() {},
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
    afterRun() {},
  }
}
```

**Tools helper**

```ts
const githubPlugin = async () => {
  return {
    setup() {},
    teardown() {},
    beforeRun() {
      return {
        context: {
          github: Object.assign(
            {
              issues: {
                list: async (opts: { owner: string; repo: string }) => {
                  const res = await fetch(
                    `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues`,
                  )
                  return res.json()
                },
              },
            },
            { description: "GitHub API client for issues, repos, PRs" },
          ),
        },
      }
    },
    afterRun() {},
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
      return {
        context: {
          db: Object.assign(db, {
            description: "SQLite database connection (better-sqlite3)",
          }),
        },
      }
    },
    teardown() {
      db?.close()
    },
  }
}
```

## Context Discovery (Built-in Plugin)

Discovery is provided by a built-in plugin. Plugins register context as bare values - if a value has a `.description` property, it's indexed for search.

### How It Works

```ts
// Built-in discovery plugin
const discoveryPlugin = () => {
  let contextRegistry: Record<string, unknown>

  return {
    setup() {},
    teardown() {},
    beforeRun(input) {
      contextRegistry = input.context

      return {
        context: {
          list: Object.assign(
            () =>
              Object.entries(contextRegistry).map(([name, value]) => ({
                name,
                description: (value as any)?.description ?? null,
              })),
            { description: "List all available context items" },
          ),
          search: Object.assign(
            (query: string) => {
              const q = query.toLowerCase()
              return Object.entries(contextRegistry)
                .filter(([name, value]) => {
                  const nameMatch = name.toLowerCase().includes(q)
                  const descMatch = (value as any)?.description?.toLowerCase().includes(q)
                  return nameMatch || descMatch
                })
                .map(([name, value]) => ({
                  name,
                  description: (value as any)?.description ?? null,
                }))
            },
            { description: "Search context by name or description" },
          ),
        },
      }
    },
    afterRun() {},
  }
}
```

### Agent Usage

```ts
// List all available context
const available = list()
// => [{ name: "browser", description: "Playwright browser instance" }, ...]

// Search context by name or description
const webTools = search("web")
// => [{ name: "browser", description: "Playwright browser for web automation" }]

// Use context directly
await browser.newPage()
await page.click("button")
```

### Why This Matters

1. **Self-documenting**: Values carry their own description
2. **Discoverable**: Agent doesn't need all context in system prompt
3. **Searchable**: Agent can find tools without knowing exact names
4. **Extensible**: Third-party plugins can replace with semantic search
5. **Optional**: Can be removed if discovery isn't needed

## Core Implementation

### types.ts

```ts
export interface RunInput {
  source: string
  context: Record<string, unknown>
}

export interface RunOutput {
  result: unknown
  error: Error | null
}

export interface Hooks {
  setup: () => Promise<void>
  teardown: () => Promise<void>
  beforeRun: (input: RunInput) => Promise<Partial<RunInput> | void>
  afterRun: (input: RunOutput) => Promise<Partial<RunOutput> | void>
}

export type Plugin = () => Promise<Hooks>
```

### runner.ts

```ts
import { Effect, Schema } from "effect"
import type { Plugin, RunInput, RunOutput } from "./types.js"

export class HookError extends Schema.TaggedErrorClass<HookError>()("HookError", {
  hook: Schema.String,
  cause: Schema.Defect,
}) {}

export const run = Effect.fn("run")((source: string, plugins: Plugin[]) =>
  Effect.gen(function* () {
    // Acquire all hooks with guaranteed teardown via acquireRelease
    const hooks = yield* Effect.forEach(plugins, (plugin) =>
      Effect.acquireRelease(Effect.promise(plugin), (hook) =>
        Effect.promise(() => hook.teardown()),
      ),
    )

    // Setup phase
    yield* Effect.forEach(
      hooks,
      (hook) =>
        Effect.tryPromise({
          try: () => hook.setup(),
          catch: (cause) => new HookError({ hook: "setup", cause }),
        }),
      { discard: true },
    )

    // beforeRun phase - functional transform
    const currentState: RunInput = { source, context: {} }
    for (const hook of hooks) {
      const result = yield* Effect.tryPromise({
        try: () => hook.beforeRun(currentState),
        catch: (cause) => new HookError({ hook: "beforeRun", cause }),
      })
      if (result) {
        Object.assign(currentState, result)
      }
    }

    // Execute
    const currentOutput: RunOutput = yield* Effect.try({
      try: () => {
        const params = Object.keys(currentState.context)
        const fn = new Function(
          ...params,
          `"use strict"; return (async () => {\n${currentState.source}\n})();`,
        )
        return fn(...Object.values(currentState.context))
      },
      catch: (error: unknown): unknown => error,
    }).pipe(
      Effect.match({
        onFailure: (error) => ({
          result: undefined,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
        onSuccess: (result) => ({ result, error: null }),
      }),
    )

    // afterRun phase - functional transform
    for (const hook of hooks) {
      const result = yield* Effect.tryPromise({
        try: () => hook.afterRun(currentOutput),
        catch: (cause) => new HookError({ hook: "afterRun", cause }),
      })
      if (result) {
        Object.assign(currentOutput, result)
      }
    }

    return { result: currentOutput.result, error: currentOutput.error }
  }),
)
```

### config.ts

```ts
import { defu } from "defu"
import { Effect, FileSystem, Layer, Path, Schema, ServiceMap } from "effect"
import envPaths from "env-paths"
import { createJiti } from "jiti"

const paths = envPaths("runner")

export class JitiError extends Schema.TaggedErrorClass<JitiError>()("JitiError", {
  cause: Schema.Defect,
}) {}

export class ConfigSchema extends Schema.Class<ConfigSchema>("ConfigSchema")({
  plugins: Schema.optional(Schema.Array(Schema.Any)),
}) {
  static readonly empty: ConfigSchema = { plugins: [] }
}

export function defineConfig(config: ConfigSchema): ConfigSchema {
  return config
}

export class Config extends ServiceMap.Service<Config>()("@ericc-ch/runner/Config", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const jiti = createJiti(import.meta.url)

    yield* fs.makeDirectory(paths.config, { recursive: true })

    const loadFile = Effect.fn(function* (filePath: string) {
      return yield* Effect.tryPromise({
        try: () => jiti.import(filePath) as Promise<ConfigSchema>,
        catch: (cause) => new JitiError({ cause }),
      })
    })

    const load = Effect.fn(function* () {
      const cwd = yield* Effect.sync(() => process.cwd())

      const globalPath = path.join(paths.config, "config.ts")
      const localPath = path.join(cwd, ".runner/config.ts")

      const global = yield* loadFile(globalPath).pipe(
        Effect.catchTag("JitiError", () => Effect.succeed(ConfigSchema.empty)),
      )
      const local = yield* loadFile(localPath).pipe(
        Effect.catchTag("JitiError", () => Effect.succeed(ConfigSchema.empty)),
      )

      return defu(local, global)
    })

    return { load }
  }),
}) {
  static readonly layer = Layer.effect(Config, Config.make)
}
```

### builtins/discovery.ts

```ts
// Built-in discovery plugin - provides list() and search()
import type { Plugin, RunInput, RunOutput } from "../types.js"

export const discoveryPlugin = (): Plugin => async () => {
  let contextRegistry: Record<string, unknown>

  return {
    setup: async () => {},
    teardown: async () => {},
    beforeRun: async (input: RunInput) => {
      contextRegistry = input.context

      return {
        context: {
          list: Object.assign(
            () =>
              Object.entries(contextRegistry).map(([name, value]) => ({
                name,
                description: (value as any)?.description ?? null,
              })),
            { description: "List all available context items" },
          ),
          search: Object.assign(
            (query: string) => {
              const q = query.toLowerCase()
              return Object.entries(contextRegistry)
                .filter(([name, value]) => {
                  const nameMatch = name.toLowerCase().includes(q)
                  const descMatch = (value as any)?.description?.toLowerCase().includes(q)
                  return nameMatch || descMatch
                })
                .map(([name, value]) => ({
                  name,
                  description: (value as any)?.description ?? null,
                }))
            },
            { description: "Search context by name or description" },
          ),
        },
      }
    },
    afterRun: async (_output: RunOutput) => {},
  }
}
```

### builtins/console.ts

```ts
// Built-in console capture plugin
import type { Plugin, RunInput, RunOutput } from "../types.js"

export const consolePlugin = (): Plugin => async () => {
  let logs: string[]

  return {
    setup: async () => {},
    teardown: async () => {},
    beforeRun: async () => {
      logs = []
      return {
        context: {
          console: Object.assign(
            {
              log: (...args: any[]) => logs.push(args.join(" ")),
              error: (...args: any[]) => logs.push("[ERROR] " + args.join(" ")),
              warn: (...args: any[]) => logs.push("[WARN] " + args.join(" ")),
            },
            { description: "Captured console for logging" },
          ),
        },
      }
    },
    afterRun: async ({ result, error }: RunOutput) => {
      return {
        result: { result, logs, error },
      }
    },
  }
}
```

## Project Structure

```
runner/
├── package.json           # Dependencies
├── src/
│   ├── main.ts            # Main exports (defineConfig, builtins, run, types)
│   ├── runner.ts          # Execution engine + hooks orchestration (Effect)
│   ├── types.ts           # Plugin, Hooks, Config types
│   ├── config.ts          # Config loading (Effect service, jiti, defu)
│   ├── cli.ts             # CLI entry (Effect CLI)
│   ├── mcp.ts             # MCP server (TODO)
│   └── builtins/          # Built-in plugins
│       ├── index.ts       # Exports all builtins
│       ├── discovery.ts   # list() and search()
│       └── console.ts     # Console capture
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
    "@effect/platform-node": "^4.0.0-beta.43",
    "defu": "^6.1.6",
    "effect": "^4.0.0-beta.43",
    "env-paths": "^4.0.0",
    "jiti": "^2.5.0"
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
import type { Plugin } from '@ericc-ch/runner'

export default function examplePlugin(): Plugin {
  return async () => ({
    setup: async () => {},
    teardown: async () => {},
    beforeRun: async () => {
      return {
        context: {
          // Simple - no description
          db: someDatabase,
          // With description
          api: Object.assign(apiClient, {
            description: "API client for external service"
          }),
        },
      }
    },
    afterRun: async () => {},
  })
}

// runner-plugin-example/package.json
{
  "name": "runner-plugin-example",
  "main": "index.ts",
  "peerDependencies": {
    "@ericc-ch/runner": "^0.1.0"
  }
}
```

## MCP Server (TODO)

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
  "Execute TypeScript with full Node.js access. Plugins provide context (browser, db) via hooks. Use list() to see available context, search(query) to find specific tools.",
  { code: z.string() },
  async ({ code }) => {
    const result = await run(code, plugins)
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: result && typeof result === "object" && "error" in result && result.error != null,
    }
  },
)

await server.connect(new StdioServerTransport())
```

## CLI (TODO)

Current CLI is a placeholder. Needs implementation:

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

**Future:** Use Deno child process with permission flags for actual security boundaries. Would require IPC proxy layer for live objects (browser, db).

## Implementation Status

### Done

- [x] Core types (`types.ts`)
- [x] Runner engine with Effect v4 (`runner.ts`)
- [x] Config loader with jiti + defu (`config.ts`)
- [x] Hook lifecycle with acquire/release pattern

### TODO

- [ ] `src/main.ts` - Main exports
- [ ] `src/mcp.ts` - MCP server implementation
- [ ] CLI implementation (currently placeholder)
- [ ] `src/builtins/` - Built-in plugins (discovery, console)
- [ ] Update package name from `pkg-placeholder`
- [ ] Tests
