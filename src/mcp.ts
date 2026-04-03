import {
  McpServer,
  StdioServerTransport,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { Config } from "./config.ts"
import { Runner } from "./runner.ts"

const toMcpSchema = <T>(schema: Schema.Schema<T>): StandardSchemaWithJSON => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const withValidate = Schema.toStandardSchemaV1(schema as any)
  const withJsonSchema = Schema.toStandardJSONSchemaV1(withValidate)
  return withJsonSchema as unknown as StandardSchemaWithJSON
}

const ExecuteInput = Schema.Struct({
  code: Schema.String,
})

const SearchInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

type ExecuteInputType = Schema.Schema.Type<typeof ExecuteInput>
type SearchInputType = Schema.Schema.Type<typeof SearchInput>

export const startMcpServer = Effect.gen(function* () {
  const config = yield* Config
  const runner = yield* Runner
  const loaded = yield* config.load()

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
      inputSchema: toMcpSchema(ExecuteInput),
    },
    async (args) => {
      const { code } = args as ExecuteInputType
      const result = await Effect.runPromise(runner.execute(code))
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
      inputSchema: toMcpSchema(SearchInput),
    },
    async (args) => {
      const { query, limit } = args as SearchInputType
      const result = await Effect.runPromise(
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

  server.registerResource(
    "context",
    "context://available",
    {
      description: "Available context from loaded plugins",
      mimeType: "application/json",
    },
    async (uri) => {
      const result = await Effect.runPromise(runner.execute("return search()"))

      if (result.error) {
        const errorMsg =
          result.error instanceof Error ? result.error.message : JSON.stringify(result.error)
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ error: errorMsg }),
            },
          ],
        }
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(result.result, null, 2),
          },
        ],
      }
    },
  )

  const transport = new StdioServerTransport()
  yield* Effect.promise(() => server.connect(transport))
})

const MainLayer = Layer.provideMerge(Layer.mergeAll(Config.layer, Runner.layer), NodeServices.layer)

NodeRuntime.runMain(Effect.provide(startMcpServer, MainLayer))
