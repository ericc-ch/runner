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

1. Built-in plugins auto-loaded first
2. Load global config (`~/.config/runner/config.ts`) if exists
3. Load local config (`./.runner/config.ts`) if exists
4. Concatenate plugins: builtins → global → local
5. Plugins run in array order (first to last)

## Plugin System

Plugins extend Runner via hooks. Inspired by OpenCode's plugin architecture.

### Plugin API

```ts
// Plugin returns Hooks object
type Plugin = () => Promise<Hooks>

interface Hooks {
  // Global lifecycle (optional)
  setup?: () => Promise<void> // Plugin init (once)
  teardown?: () => Promise<void> // Plugin cleanup (once)

  // Per-run lifecycle - return partial to merge (optional)
  beforeRun?: (input: RunInput) => Promise<Partial<RunInput> | void>
  afterRun?: (input: RunOutput) => Promise<Partial<RunOutput> | void>
}

interface RunInput {
  source: string
  context: Record<string, unknown> // Just values, no wrapper
  [key: string]: unknown
}

interface RunOutput {
  result: unknown
  error: Error | null
  [key: string]: unknown
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
- All hooks are optional - missing hooks become empty implementations
- `beforeRun` returns partial → shallow merged into `state`
- `afterRun` returns partial → shallow merged into `output`
- `beforeRun` throws → skip execute → go directly to teardown
- Return nothing/empty object to skip transformation
- Plugins manage their own state
- Teardown is guaranteed via Effect's acquire/release pattern

### Plugin Examples

**Console capture**

```ts
const consolePlugin = () => async () => {
  let logs: string[]

  return {
    beforeRun() {
      logs = [] // Reset each run
      return {
        context: {
          console: Object.assign(
            {
              log: (...args: unknown[]) => logs.push(args.join(" ")),
              error: (...args: unknown[]) => logs.push("[ERROR] " + args.join(" ")),
              warn: (...args: unknown[]) => logs.push("[WARN] " + args.join(" ")),
            },
            { description: "Captured console for logging" },
          ),
        },
      }
    },
    afterRun() {
      return { logs }
    },
  }
}
```

};
};

````

**Playwright browser**

```ts
import { chromium } from "playwright";

const playwrightPlugin = async () => {
  let browser: Browser;

  return {
    async setup() {
      browser = await chromium.launch();
    },
    async beforeRun() {
      const page = await browser.newPage();
      return {
        context: {
          browser: Object.assign(browser, {
            description: "Playwright browser for automation",
            methods: { newPage: "create page", close: "close browser" }
          }),
          page: Object.assign(page, {
            description: "Active page for interactions",
            methods: { goto: "navigate", click: "click element", screenshot: "capture" }
          }),
        }
      };
    },
    async teardown() {
      await browser?.close();
    }
  };
};
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
        throw new Error("eval is not allowed");
      }
      if (input.source.includes("process.exit")) {
        throw new Error("process.exit is blocked");
      }

      // Transform source
      return {
        source: input.source.replace(/import.*fs/g, "// fs blocked"),
      };
    },
    afterRun() {},
  };
};
```

**GitHub API tool**

```ts
const githubPlugin = async () => {
  return {
    setup() {},
    teardown() {},
    beforeRun() {
      return {
        context: {
          listIssues: Object.assign(
            async (input: { owner: string; repo: string; state?: string }) => {
              const res = await fetch(
                `https://api.github.com/repos/${input.owner}/${input.repo}/issues?state=${input.state ?? "open"}`,
              );
              return res.json();
            },
            {
              description: "List repository issues",
              input: {
                owner: "repo owner",
                repo: "repo name",
                state: "open|closed|all (optional)",
              },
            },
          ),
        },
      };
    },
    afterRun() {},
  };
};
```

**Database**

```ts
import Database from "better-sqlite3";

const databasePlugin = async () => {
  let db: Database;

  return {
    async setup() {
      db = new Database("./data.db");
    },
    beforeRun() {
      return {
        context: {
          db: Object.assign(db, {
            description: "SQLite database",
            methods: {
              query: "execute SQL and return rows",
              exec: "execute SQL (no return)",
            },
          }),
        },
      };
    },
    teardown() {
      db?.close();
    },
  };
};
```

## Context Search (Built-in Plugin)

Search allows agents to explore available context at runtime. Plugins register values with optional metadata - shapeless, best effort.

### Metadata Design

**Shapeless. Only `description` is typed (for searchability). Everything else is freeform.**

```ts
// Metadata attaches to context values
contextValue.description = "string"  // searched
contextValue.input = ???             // freeform
contextValue.output = ???            // freeform
contextValue.methods = ???           // freeform
contextValue.examples = ???          // freeform
contextValue.anything = ???          // freeform
```

Search returns whatever was attached. AI agents interpret it. No validation, no structure enforcement.

### Metadata Examples

#### Minimal - Just Description

```ts
context: {
  db: Object.assign(database, {
    description: "SQLite database connection",
  });
}
```

#### Simple KV Docs

```ts
context: {
  query: Object.assign((sql: string) => db.prepare(sql).all(), {
    description: "Execute SQL query",
    input: { sql: "string - SQL query text" },
    output: "array of row objects",
  });
}
```

#### Methods as Strings

```ts
context: {
  browser: Object.assign(browser, {
    description: "Playwright browser for web automation",
    methods: {
      newPage: "Create new page",
      close: "Close browser",
      contexts: "List all contexts",
    },
  });
}
```

#### Full JSON Schema (OpenAPI)

```ts
// Auto-generated from OpenAPI spec
context: {
  listIssues: Object.assign(
    async (input: { owner: string; repo: string }) => {...},
    {
      description: "List repository issues",
      input: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" }
        },
        required: ["owner", "repo"]
      },
      output: {
        type: "array",
        items: { type: "object" }
      }
    }
  )
}
```

#### Freeform - Whatever Helps

```ts
context: {
  fetch: Object.assign(fetch, {
    description: "HTTP fetch with retries",
    examples: ["fetch('https://api.example.com')"],
    docs: "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
    notes: "Auto-retries on 5xx errors",
  });
}
```

### Search API

```ts
// Search all context
search();
// => { results: [{ name: "browser", description: "...", methods: {...}, ... }] }

// Search by name or description
search({ query: "database" });
// => { results: [{ name: "db", description: "SQLite database", ... }] }

// Limit results
search({ query: "api", limit: 5 });
```

Returns context entries with all attached metadata passed through unchanged.

### Implementation

```ts
// builtins/search.ts
import type { Plugin, RunInput } from "../types";

interface SearchQuery {
  query?: string;
  limit?: number;
}

export const searchPlugin = (): Plugin => async () => {
  let contextRegistry: Record<string, unknown>;

  return {
    beforeRun: async (input: RunInput) => {
      contextRegistry = input.context;

      return {
        context: {
          search: Object.assign(
            (query?: SearchQuery) => {
              const q = query?.query?.toLowerCase() ?? "";
              const limit = query?.limit ?? 10;

              const results = Object.entries(contextRegistry)
                .filter(([name, value]) => {
                  if (!q) return true;

                  const meta = value as { description?: string };
                  const nameMatch = name.toLowerCase().includes(q);
                  const descMatch = meta.description?.toLowerCase().includes(q);
                  return nameMatch || descMatch;
                })
                .slice(0, limit)
                .map(([name, value]) =>
                  Object.assign({ name }, value as object, {
                    description:
                      (value as { description?: string }).description ?? "",
                  }),
                );

              return { results };
            },
            {
              description: "Search available context (returns all if no query)",
              input: {
                query: "search query (optional)",
                limit: "max results (default 10)",
              },
            },
          ),
        },
      };
    },
  };
};
```

### Why Shapeless?

1. **No typing burden** - Plugin authors don't write verbose schemas
2. **OpenAPI works** - JSON Schema from specs passes through fine
3. **Simple docs** - `{ sql: "query text" }` is enough for agents
4. **Flexible** - Attach examples, links, notes - whatever helps
5. **Best effort** - Search works with just `description`, more is optional

## Core Implementation

### types.ts

```ts
export interface RunInput {
  source: string;
  context: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RunOutput {
  result: unknown;
  error: Error | null;
  [key: string]: unknown;
}

export interface Hooks {
  setup?: () => Promise<void>;
  teardown?: () => Promise<void>;
  beforeRun?: (input: RunInput) => Promise<Partial<RunInput> | void>;
  afterRun?: (input: RunOutput) => Promise<Partial<RunOutput> | void>;
}
export type Plugin = () => Promise<Hooks>;

export type RequiredHooks = Required<Hooks>;
export type RequiredPlugin = () => Promise<RequiredHooks>;
```

### runner.ts

```ts
import { Effect, Schema } from "effect";
import type { RequiredPlugin, RunInput, RunOutput } from "./types";

export class HookError extends Schema.TaggedErrorClass<HookError>()(
  "HookError",
  {
    hook: Schema.String,
    cause: Schema.Defect,
  },
) {}

export const run = Effect.fn((source: string, plugins: RequiredPlugin[]) =>
  Effect.gen(function* () {
    const hooks = yield* Effect.forEach(plugins, (plugin) =>
      Effect.acquireRelease(Effect.promise(plugin), (hook) =>
        Effect.promise(() => hook.teardown()),
      ),
    );

    yield* Effect.forEach(
      hooks,
      (hook) =>
        Effect.tryPromise({
          try: () => hook.setup(),
          catch: (cause) => new HookError({ hook: "setup", cause }),
        }),
      { discard: true },
    );

    const currentState: RunInput = { source, context: {} };
    for (const hook of hooks) {
      const result = yield* Effect.tryPromise({
        try: () => hook.beforeRun(currentState),
        catch: (cause) => new HookError({ hook: "beforeRun", cause }),
      });
      if (result) {
        Object.assign(currentState, result);
      }
    }

    const currentOutput: RunOutput = yield* Effect.try({
      try: () => {
        const params = Object.keys(currentState.context);
        const fn = new Function(
          ...params,
          `"use strict"; return (async () => {\n${currentState.source}\n})();`,
        );
        return fn(...Object.values(currentState.context));
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
    );

    for (const hook of hooks) {
      const result = yield* Effect.tryPromise({
        try: () => hook.afterRun(currentOutput),
        catch: (cause) => new HookError({ hook: "afterRun", cause }),
      });
      if (result) {
        Object.assign(currentOutput, result);
      }
    }

    return currentOutput;
  }),
);
```

### config.ts

```ts
import { Effect, FileSystem, Layer, Path, Schema, ServiceMap } from "effect";
import envPaths from "env-paths";
import { createJiti } from "jiti";
import { consolePlugin } from "./builtins/console";
import type { Plugin, RequiredPlugin } from "./types";

const paths = envPaths("runner");

const builtins = {
  plugins: [consolePlugin()],
};

export class JitiError extends Schema.TaggedErrorClass<JitiError>()(
  "JitiError",
  {
    cause: Schema.Defect,
  },
) {}

const isPlugin = (u: unknown): u is Plugin => typeof u === "function";

const makeRequiredPlugin =
  (plugin: Plugin): RequiredPlugin =>
  async () => {
    const hooks = await plugin();
    return {
      setup: hooks.setup ?? (async () => {}),
      teardown: hooks.teardown ?? (async () => {}),
      beforeRun: hooks.beforeRun ?? (async () => {}),
      afterRun: hooks.afterRun ?? (async () => {}),
    };
  };

const PluginSchema = Schema.declare<Plugin>(isPlugin, {
  title: "Plugin",
  description: "A plugin function that returns hooks",
});

export class ConfigSchema extends Schema.Class<ConfigSchema>("ConfigSchema")({
  plugins: Schema.optional(Schema.Array(PluginSchema)),
}) {
  static readonly empty: ConfigSchema = { plugins: [] };
}

export function defineConfig(config: ConfigSchema): ConfigSchema {
  return config;
}

export class Config extends ServiceMap.Service<Config>()(
  "@ericc-ch/runner/Config",
  {
    make: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const jiti = createJiti(import.meta.url);

      yield* fs.makeDirectory(paths.config, { recursive: true });

      const loadFile = Effect.fn(function* (filePath: string) {
        return yield* Effect.tryPromise({
          try: () => jiti.import(filePath) as Promise<ConfigSchema>,
          catch: (cause) => new JitiError({ cause }),
        });
      });

      const load = Effect.fn(function* () {
        const cwd = yield* Effect.sync(() => process.cwd());

        const globalPath = path.join(paths.config, "config.ts");
        const localPath = path.join(cwd, ".runner/config.ts");

        const global = yield* loadFile(globalPath).pipe(
          Effect.catchTag("JitiError", () =>
            Effect.succeed(ConfigSchema.empty),
          ),
        );
        const local = yield* loadFile(localPath).pipe(
          Effect.catchTag("JitiError", () =>
            Effect.succeed(ConfigSchema.empty),
          ),
        );

        const allPlugins = [
          ...builtins.plugins,
          ...(global.plugins ?? []),
          ...(local.plugins ?? []),
        ];
        return {
          plugins: allPlugins.map(makeRequiredPlugin),
        };
      });

      return { load };
    }),
  },
) {
  static readonly layer = Layer.effect(Config, Config.make);
}
```

### builtins/search.ts

See "Context Search" section above for full implementation.

Key features:

- `search()` - Explore available context
- Shapeless metadata - only `description` is typed, rest is freeform
- Best effort - works with minimal metadata, passes through everything

### builtins/console.ts

```ts
import type { Plugin } from "../types";

export const consolePlugin = (): Plugin => async () => {
  let logs: string[];

  return {
    setup: async () => {},
    teardown: async () => {},
    beforeRun: async () => {
      logs = [];
      return {
        context: {
          console: Object.assign(
            {
              log: (...args: unknown[]) => logs.push(args.join(" ")),
              error: (...args: unknown[]) =>
                logs.push("[ERROR] " + args.join(" ")),
              warn: (...args: unknown[]) =>
                logs.push("[WARN] " + args.join(" ")),
            },
            { description: "Captured console for logging" },
          ),
        },
      };
    },
    afterRun: async () => {
      return { logs };
    },
  };
};
```

## Project Structure

```
runner/
├── package.json           # Dependencies
├── src/
│   ├── main.ts            # Main exports (defineConfig, builtins, run, types)
│   ├── runner.ts          # Execution engine + hooks orchestration (Effect)
│   ├── types.ts           # Plugin, Hooks, Config types
│   ├── config.ts          # Config loading (Effect service, jiti)
│   ├── cli.ts             # CLI entry (Effect CLI)
│   ├── mcp.ts             # MCP server (TODO)
│   └── builtins/          # Built-in plugins
│       ├── search.ts      # Search context with shapeless metadata
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
    "effect": "^4.0.0-beta.43",
    "env-paths": "^4.0.0",
    "jiti": "^2.6.1"
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
import playwright from "runner-plugin-playwright";
import console from "runner-plugin-console";

export default defineConfig({
  plugins: [playwright(), console()],
});
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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";

const config = await loadConfig(); // loads global + local
const plugins = config.plugins;

const server = new McpServer({ name: "runner", version: "0.1.0" });

server.tool(
  "execute",
  "Execute TypeScript with full Node.js access. Plugins provide context (browser, db) via hooks. Use search() to explore available context.",
  { code: z.string() },
  async ({ code }) => {
    const result = await run(code, plugins);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError:
        result &&
        typeof result === "object" &&
        "error" in result &&
        result.error != null,
    };
  },
);

await server.connect(new StdioServerTransport());
```

## CLI

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Stdio,
  Stream,
} from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Config } from "./config";
import { run } from "./runner";

const file = Argument.file("file").pipe(Argument.optional);

const evalFlag = Flag.string("eval").pipe(
  Flag.withAlias("e"),
  Flag.withDescription("Evaluate the given string as TypeScript code"),
  Flag.optional,
);

const command = Command.make(
  "runner",
  { file, evalFlag },
  Effect.fn("runner-cli")(function* ({ file, evalFlag }) {
    const config = yield* Config;
    const stdio = yield* Stdio.Stdio;
    const fs = yield* FileSystem.FileSystem;
    const loaded = yield* config.load();

    const codeInput = yield* Option.match(evalFlag, {
      onNone: () =>
        Option.match(file, {
          onNone: () => Stream.mkString(stdio.stdin.pipe(Stream.decodeText())),
          onSome: (filePath) => fs.readFileString(filePath),
        }),
      onSome: (code) => Effect.succeed(code),
    });

    const result = yield* Effect.scoped(run(codeInput, loaded.plugins));
    yield* Console.log(result);
  }),
).pipe(
  Command.withDescription("Execute TypeScript code with plugin context"),
  Command.withExamples([
    {
      command: "runner script.ts",
      description: "Execute a TypeScript file",
    },
    {
      command: "runner -e 'console.log(\"Hello\")'",
      description: "Evaluate TypeScript code from string",
    },
    {
      command: "cat script.ts | runner",
      description: "Execute TypeScript code from stdin",
    },
  ]),
);

const MainLayer = Config.layer.pipe(Layer.provideMerge(NodeServices.layer));

command.pipe(
  Command.run({ version: "0.0.1" }),
  Effect.provide(MainLayer),
  NodeRuntime.runMain,
);
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

- [x] Core types (`types.ts`) - Optional hooks, RequiredPlugin helper
- [x] Runner engine with Effect v4 (`runner.ts`) - Uses RequiredPlugin
- [x] Config loader with jiti (`config.ts`) - Builtins auto-included, no defu merge
- [x] Hook lifecycle with acquire/release pattern
- [x] CLI implementation (`cli.ts`) - Full Effect CLI with file/eval/stdin
- [x] `src/main.ts` - Main exports
- [x] `src/builtins/console.ts` - Console capture plugin
- [x] `src/builtins/search.ts` - Search plugin with shapeless metadata
- [x] Package name updated to `@ericc-ch/runner`

### TODO

- [ ] `src/openapi.ts` - OpenAPI auto-import plugin (generate tools from spec)
- [ ] `src/mcp.ts` - MCP server implementation
- [ ] Tests
````
