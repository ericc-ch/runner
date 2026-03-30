# Runner - TypeScript Execution Engine

Simple TypeScript execution for AI agents. No sandbox, no permissions. Let the agent run wild.

## Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────┐     ┌─────────────┐
│  Agent/AI   │────▶│  Runner (Node.js)                        │────▶│  External   │
│  (MCP client)│     │                                          │     │  APIs       │
└─────────────┘     │                                          │     └─────────────┘
                    │  Code runs directly in main process      │           ▲
  ┌─────────────┐   │  - Full access to fetch, fs, child_process│           │
  │  CLI        │──▶│  - Can import any npm package            │───────────┘
  │  user       │   │  - Plugins inject context + tools        │
  └─────────────┘   │                                          │
                    └──────────────────────────────────────────┘
```

No sandbox, no worker, no IPC. Code executes in the same Node.js process.

## How It Works

```ts
// Agent code runs with full Node.js access
const issues = await fetch("https://api.github.com/repos/foo/bar/issues")

// Use npm packages directly
import { chromium } from "playwright"
const browser = await chromium.launch()
const page = await browser.newPage()

// Or use plugin-provided context (e.g., playwright plugin pre-launches browser)
await page.goto("https://example.com") // page is already in scope
await page.screenshot({ path: "screenshot.png" })

// Or use tools as convenience helpers
const issues = await tools.github.issues.list({ owner: "foo", repo: "bar" })
```

## Plugin System

Plugins can provide:

1. **Context** - objects injected into execution scope (browser, database, etc.)
2. **Tools** - convenience helper functions
3. **Lifecycle** - setup before execution, teardown after

```ts
// types.ts
interface Plugin {
  name: string

  // Tools: convenience helper functions
  tools?: Record<string, Tool>

  // Context: objects injected into execution scope as globals
  context?: () => Promise<Record<string, unknown>>

  // Teardown: called after execution to cleanup
  teardown?: (ctx: Record<string, unknown>) => Promise<void>
}

interface Tool {
  description: string
  inputSchema?: JSONSchema
  execute: (args: unknown, ctx: Record<string, unknown>) => Promise<unknown>
}
```

### Plugin Examples

**Playwright - Context only, no tools**

```ts
// plugins/playwright.ts
import { chromium, firefox, webkit } from "playwright"
import * as playwright from "playwright"

export default {
  name: "playwright",

  context: async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()

    return {
      // Pre-created instances (convenience)
      browser,
      page,

      // Full namespace (agent can launch more browsers, access all APIs)
      playwright,
      chromium,
      firefox,
      webkit,
    }
  },

  teardown: async ({ browser }) => {
    await browser?.close()
  },
}

// Agent code:
// await page.goto('https://example.com');       // use pre-created page
// await page.screenshot({ path: 'screenshot.png' });
// const ff = await firefox.launch();            // launch different browser
// const newPage = await browser.newPage();      // another tab
// await playwright.chromium.launch();           // via namespace
```

**GitHub - Tools only, no context**

```ts
// plugins/github.ts
export default {
  name: "github",

  tools: {
    "issues.list": {
      description: "List repository issues",
      inputSchema: {
        type: "object",
        properties: { owner: { type: "string" }, repo: { type: "string" } },
        required: ["owner", "repo"],
      },
      execute: async (args) => {
        const res = await fetch(
          `https://api.github.com/repos/${args.owner}/${args.repo}/issues`,
          { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } },
        )
        if (!res.ok) throw new Error(`GitHub API error: ${res.status}`)
        return res.json()
      },
    },
  },
}

// Agent code:
// const issues = await tools.github.issues.list({ owner: 'foo', repo: 'bar' });
```

**Database - Both context and tools**

```ts
// plugins/database.ts
export default {
  name: "database",

  context: async () => {
    const db = await openDatabase("./data.db")
    return { db }
  },

  tools: {
    query: {
      description: "Run SQL query",
      inputSchema: { type: "object", properties: { sql: { type: "string" } } },
      execute: async (args, ctx) => {
        return ctx.db.query(args.sql)
      },
    },
  },

  teardown: async ({ db }) => {
    db?.close()
  },
}

// Agent can use either:
// await db.query("SELECT * FROM users");     // direct context
// await tools.database.query({ sql: "..." }); // via tool
```

## Scope

| Component   | Description                       | Lines          |
| ----------- | --------------------------------- | -------------- |
| `index.ts`  | Entry point, exports              | ~30            |
| `runner.ts` | Code execution, plugin lifecycle  | ~100           |
| `tools.ts`  | Tool registry, build tools object | ~60            |
| `types.ts`  | TypeScript types                  | ~50            |
| `cli.ts`    | CLI entry point                   | ~50            |
| `mcp.ts`    | MCP server with `execute` tool    | ~70            |
| `plugins/`  | Example plugins                   | ~50 each       |
| **Total**   |                                   | **~400 lines** |

## Code Execution

```ts
// runner.ts
export async function run(code: string, plugins: Plugin[]): Promise<RunResult> {
  const logs: string[] = []
  const originalConsole = { ...console }

  console.log = (...args) => logs.push(`[log] ${args.join(" ")}`)
  console.error = (...args) => logs.push(`[error] ${args.join(" ")}`)
  console.warn = (...args) => logs.push(`[warn] ${args.join(" ")}`)

  // Setup plugin contexts
  const contexts: Record<string, unknown> = {}
  const globals: Record<string, unknown> = {}

  for (const plugin of plugins) {
    if (plugin.context) {
      const ctx = await plugin.context()
      contexts[plugin.name] = ctx
      // Flatten context into globals
      if (ctx && typeof ctx === "object") {
        Object.assign(globals, ctx)
      }
    }
  }

  // Build tools object (tools can access contexts)
  globals.tools = buildTools(plugins, contexts)

  try {
    // Build async function with globals as parameters
    const params = Object.keys(globals)
    const fn = new Function(
      ...params,
      `"use strict"; return (async () => {\n${code}\n})();`,
    )

    const result = await fn(...Object.values(globals))
    return { result, logs }
  } catch (err) {
    return {
      result: null,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      logs,
    }
  } finally {
    Object.assign(console, originalConsole)

    // Teardown all plugins
    for (const plugin of plugins) {
      if (plugin.teardown && contexts[plugin.name]) {
        await plugin.teardown(contexts[plugin.name] as Record<string, unknown>)
      }
    }
  }
}
```

## MCP Server

```ts
// mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const plugins = await loadPlugins("./plugins")

const server = new McpServer({ name: "runner", version: "0.1.0" })

server.tool(
  "execute",
  "Execute TypeScript with full Node.js access. Plugins provide context (e.g., browser, db) and tools helpers.",
  { code: z.string() },
  async ({ code }) => {
    const result = await run(code, plugins)
    return {
      content: [{ type: "text", text: formatResult(result) }],
      isError: result.error != null,
    }
  },
)

await server.connect(new StdioServerTransport())
```

## CLI

```ts
// cli.ts
// Usage: node cli.ts "await fetch('https://api.github.com').then(r => r.status)"

const plugins = await loadPlugins("./plugins")

const code = process.argv[2]
const result = await run(code ?? (await readStdin()), plugins)
console.log(JSON.stringify(result, null, 2))
```

## Project Structure

```
runner/
├── package.json      # Dependencies
├── index.ts          # Main exports
├── runner.ts         # Execution engine
├── tools.ts          # Tool registry
├── types.ts          # TypeScript types
├── cli.ts            # CLI entry
├── mcp.ts            # MCP server
├── plugins/
│   ├── playwright.ts # Browser context
│   ├── github.ts     # GitHub API tools
│   └── database.ts   # Database context + tools
└── REWRITE.md
```

## Dependencies

Runner's `package.json` lists all dependencies (including those needed by plugins):

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.0.0",
    "playwright": "^1.40.0", // for playwright plugin
    "better-sqlite3": "^9.0.0" // for database plugin
  }
}
```

Plugins import from these dependencies and expose them in context. Agent doesn't need to import - everything is already in scope via globals.

## Plugin Context Pattern

Plugins decide what to expose:

| What to expose        | Use case                                      |
| --------------------- | --------------------------------------------- |
| Pre-created instances | Convenience (e.g., `browser`, `page`)         |
| Full namespace        | Advanced use (e.g., `playwright`, `chromium`) |
| Factories             | Create multiple instances                     |
| Config                | Settings the agent can reference              |

```ts
// Example: expose everything the agent might need
context: async () => ({
  page, // ready to use
  browser, // parent instance
  playwright, // full namespace
  chromium, // specific browser
})
```

## Comparison with Original Executor

| Feature          | Original Executor | Runner                |
| ---------------- | ----------------- | --------------------- |
| Runtime          | Bun + Effect.ts   | Node.js (plain)       |
| Sandbox          | Yes (3 runtimes)  | No                    |
| IPC              | Yes               | No                    |
| Permissions      | Yes               | No                    |
| Policy engine    | Yes               | No                    |
| Plugin context   | No                | Yes (inject globals)  |
| Plugin lifecycle | Complex           | Simple setup/teardown |
| Lines of code    | ~50,000+          | ~400                  |
| Package count    | 50+               | 1                     |

## Development Milestones

### Milestone 1: Core (Day 1)

- [ ] `types.ts` - Plugin, Tool, RunResult
- [ ] `runner.ts` - Execution with context injection and teardown
- [ ] Test: Run code, capture console, handle errors

### Milestone 2: Tools (Day 1)

- [ ] `tools.ts` - Registry, buildTools function
- [ ] Tools can access plugin context
- [ ] Test: Register tool, call from code

### Milestone 3: CLI (Day 1)

- [ ] `cli.ts` - Accept code from args/stdin
- [ ] Load plugins from directory
- [ ] Test: CLI execution with plugins

### Milestone 4: MCP (Day 2)

- [ ] `mcp.ts` - MCP server with execute tool
- [ ] Plugin loading at startup
- [ ] Test: MCP client connection

### Milestone 5: Plugins (Day 2)

- [ ] `plugins/playwright.ts` - Browser context
- [ ] `plugins/github.ts` - API tools
- [ ] Test: Plugin setup/teardown lifecycle

## Security Note

**No security boundary.** Agent code has full Node.js access:

- Filesystem (fs module)
- Network (fetch, http)
- Child processes
- Environment variables
- Any npm imports

This is for trusted agents only (your own AI assistant). Not for running untrusted code.
