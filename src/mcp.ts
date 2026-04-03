import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server"
import { Effect, Layer, pipe, Schema, ServiceMap } from "effect"
import { Config } from "./lib/config.ts"
import { Runner } from "./runner.ts"

const ExecuteInput = Schema.Struct({
  code: Schema.String,
})

const SearchInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

type ExecuteInputType = Schema.Schema.Type<typeof ExecuteInput>
type SearchInputType = Schema.Schema.Type<typeof SearchInput>

export class Mcp extends ServiceMap.Service<Mcp>()("@ericc-ch/runner/Mcp", {
  make: Effect.gen(function* () {
    const config = yield* Config
    const runner = yield* Runner

    const start = Effect.fn(function* () {
      const loaded = yield* config.load()
      const services = yield* Effect.services<never>()

      yield* runner.init(loaded.plugins)

      const server = new McpServer({
        name: "@ericc-ch/runner",
        version: "0.0.1",
      })

      server.registerTool(
        "execute",
        {
          description:
            "Execute TypeScript with full Node.js access. Plugins provide context (browser, db, etc). Use search() to explore available context.",
          inputSchema: pipe(ExecuteInput, Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
        },
        async (args) => {
          const { code } = args as ExecuteInputType
          const result = await Effect.runPromiseWith(services)(runner.execute(code))
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            isError: result.error !== undefined,
          }
        },
      )

      server.registerTool(
        "search",
        {
          description:
            "Search available context from plugins. Returns context entries with descriptions and metadata.",
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
              content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
              isError: true,
            }
          }

          return {
            content: [
              {
                type: "text" as const,
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
