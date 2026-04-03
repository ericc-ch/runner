# Runner

TypeScript execution engine for AI agents. No sandbox, no permissions. Code runs directly in Node.js with full access to filesystem, network, child processes, and npm packages.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/E1E519XS7W)

> **⚠️ WARNING: THIS IS NOT SECURE AT ALL**
>
> Code executed by Runner has **full, unrestricted access** to your system:
>
> - **Filesystem** - Read, write, delete any file
> - **Network** - Make any HTTP request to any server
> - **Child processes** - Spawn any process, execute any command
> - **Environment variables** - Read all secrets, tokens, passwords
> - **npm imports** - Load any package, run arbitrary code
>
> **Only use with trusted agents.** Never execute untrusted code. There is no sandbox, no isolation, no permission system.

## Installation

```bash
npm install @ericc-ch/runner
```

## CLI

```bash
# Execute a file
runner run script.ts

# Evaluate code from string
runner run -e 'console.log("Hello")'

# Execute from stdin
cat script.ts | runner run

# Start MCP server
runner mcp
```

## MCP Tools

Runner exposes two tools through the Model Context Protocol:

### execute

Execute TypeScript with full Node.js access. Context objects, variables, and functions are provided by user-configured plugins (browser automation, database connections, file system, APIs, or custom setups).

```typescript
// Input
{ code: string }

// Output
{
  result: unknown,      // Return value from executed code
  error: unknown,       // Error if execution failed
  logs: string[]        // Captured console output
}
```

Example usage:

```typescript
// Search for available context
await search({ query: "database" });

// Use the context
await execute({
  code: `
    const users = db.query("SELECT * FROM users")
    return users
  `,
});
```

### search

List all available context from loaded plugins (objects, functions, and variables you can access). Returns names, types, and descriptions.

```typescript
// Input
{
  query?: string,    // Search query (optional)
  limit?: number     // Max results (default: 10)
}

// Output
{
  results: [
    {
      name: string,
      description: string,
      // ... additional metadata from plugin
    }
  ]
}
```

Examples:

```typescript
// List all available context
search();

// Search for database-related context
search({ query: "database" });

// Limit results
search({ query: "api", limit: 5 });
```

## Plugins

Plugins extend Runner through hooks:

```typescript
import { defineConfig } from "@ericc-ch/runner";

export default defineConfig({
  plugins: [
    async () => ({
      beforeRun() {
        return {
          context: {
            // Simple value
            db: database,
            // With description for search
            api: Object.assign(apiClient, {
              description: "API client for external service",
            }),
          },
        };
      },
    }),
  ],
});
```

Plugin hooks:

- `setup` - Initialize plugin (runs once)
- `teardown` - Cleanup plugin (runs once)
- `beforeRun` - Inject context before each execution
- `afterRun` - Process output after each execution

Config files:

- Global: `~/.config/runner/config.ts`
- Local: `./.runner/config.ts`

Built-in plugins (auto-loaded):

- `console` - Captures console.log/error/warn output
- `search` - Provides context search functionality

## Security

**No security boundary.** Agent code has full Node.js access: filesystem, network, child processes, environment variables, and any npm imports. This is for trusted agents only.

Security plugins can block patterns via `beforeRun`, but this is advisory—an agent can bypass if clever.

## Roadmap

### OpenAPI Plugin

Auto-generate tools from OpenAPI specifications. The plugin will:

1. Parse OpenAPI spec (JSON/YAML)
2. Generate typed functions for each endpoint
3. Register functions as context with descriptions and input schemas
4. Support authentication (API keys, OAuth, etc.)

Example:

```typescript
import openapiPlugin from "runner-plugin-openapi";

export default defineConfig({
  plugins: [
    openapiPlugin({
      spec: "https://api.example.com/openapi.json",
      baseUrl: "https://api.example.com",
      auth: { apiKey: process.env.API_KEY },
    }),
  ],
});
```

### Security via Deno

Run untrusted code with actual security boundaries using Deno subprocess with permission flags. Requires IPC proxy layer for live objects (browser, database connections).

This will enable:

- Fine-grained permissions (network, filesystem, env vars)
- Timeout enforcement
- Resource limits (memory, CPU)
- Safe execution of untrusted agent code

## Credits

This project is basically my shitty attempt to make something similar to [executor](https://github.com/RhysSullivan/executor) but less awkward to use with [playwriter](https://github.com/remorses/playwriter).

Also inspired by [Cloudflare's Code Mode](https://blog.cloudflare.com/code-mode/).
