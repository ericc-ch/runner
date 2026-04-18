import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server"
import { Context, Effect, Layer, pipe, Schema } from "effect"
import { Config } from "./lib/config.ts"
import { Runner } from "./lib/runner.ts"


const ExecuteInput = Schema.Struct({
  code: Schema.String,
})

const SearchInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

type ExecuteInputType = typeof ExecuteInput.Type
type SearchInputType = typeof SearchInput.Type

export interface McpShape {
  readonly start: () => Effect.Effect<void, unknown, never>
}

export class Mcp extends Context.Service<Mcp, McpShape>()("@ericc-ch/runner/Mcp", {
  make: Effect.gen(function* () {
    const config = yield* Config
    const runner = yield* Runner

    const start = Effect.fn(function* () {
      const loaded = yield* config.load()
      const services = yield* Effect.context<never>()

      yield* runner.init(loaded.plugins)

      const server = new McpServer({
        name: "@ericc-ch/runner",
        version: "0.0.1",
      })

      server.registerTool(
        "execute",
        {
          description:
            "Execute TypeScript with full Node.js access. Context objects, variables, and functions are provided by user-configured plugins - browser automation, database connections, file system, APIs, or custom setups. Use this when you need to make multiple tool calls in sequence where each step depends on the previous result. Unlike parallel tool calls, this lets you run code, inspect the result, and continue execution in a single session without stopping to analyze intermediate output. Call search first to see what context is available.",
          inputSchema: pipe(ExecuteInput, Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
        },
        async (args) => {
          const { code } = args as ExecuteInputType
          const result = await Effect.runPromiseWith(services)(runner.execute(code))
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: result.error !== undefined,
          }
        },
      )

      server.registerTool(
        "search",
        {
          description:
            "List all available context from loaded plugins - objects, functions, and variables you can access. Returns names, types, and descriptions. Use this before execute to know what APIs you have available.",
          inputSchema: pipe(SearchInput, Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
        },
        async (args) => {
          const { query, limit } = args as SearchInputType
          const result = await Effect.runPromiseWith(services)(
            runner.execute(`return search(${JSON.stringify({ query, limit })})`),
          )

          if (result.error) {
            const errorMsg =
              result.error instanceof Error ? result.error.message : JSON.stringify(result.error)
            return {
              content: [{ type: "text", text: `Error: ${errorMsg}` }],
              isError: true,
            }
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result.result, null, 2),
              },
            ],
          }
        },
      )

      const transport = new StdioServerTransport()
      yield* Effect.promise(() => server.connect(transport))
    })

    return { start }
  }),
}) {
  static readonly layer = Layer.effect(Mcp, Mcp.make)
}
