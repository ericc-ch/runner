import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Layer, Option, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Config } from "./config.ts"
import { startMcpServer } from "./mcp.ts"
import { Runner } from "./runner.ts"

const file = Argument.file("file").pipe(Argument.optional)

const evalFlag = Flag.string("eval").pipe(
  Flag.withAlias("e"),
  Flag.withDescription("Evaluate the given string as TypeScript code"),
  Flag.optional,
)

const runCommand = Command.make(
  "run",
  { file, evalFlag },
  Effect.fn(function* ({ file, evalFlag }) {
    const config = yield* Config
    const runner = yield* Runner
    const stdio = yield* Stdio.Stdio
    const fs = yield* FileSystem.FileSystem
    const loaded = yield* config.load()

    const codeInput = yield* Option.match(evalFlag, {
      onNone: () =>
        Option.match(file, {
          onNone: () => Stream.mkString(stdio.stdin.pipe(Stream.decodeText())),
          onSome: (filePath) => fs.readFileString(filePath),
        }),
      onSome: (code) => Effect.succeed(code),
    })

    yield* runner.init(loaded.plugins)
    const result = yield* runner.execute(codeInput)
    yield* runner.teardown
    yield* Console.log(result)
  }),
).pipe(
  Command.withDescription("Execute TypeScript code with plugin context"),
  Command.withExamples([
    {
      command: "runner run script.ts",
      description: "Execute a TypeScript file",
    },
    {
      command: "runner run -e 'console.log(\"Hello\")'",
      description: "Evaluate TypeScript code from string",
    },
    {
      command: "cat script.ts | runner run",
      description: "Execute TypeScript code from stdin",
    },
  ]),
)

const mcpCommand = Command.make(
  "mcp",
  {},
  Effect.fn("runner-mcp")(function* () {
    yield* Console.log("Starting MCP server...")
    yield* startMcpServer
  }),
).pipe(Command.withDescription("Start MCP server for AI agent integration"))

const command = Command.make("runner", {}).pipe(
  Command.withDescription("TypeScript execution engine for AI agents"),
  Command.withSubcommands([runCommand, mcpCommand]),
)

const MainLayer = Layer.mergeAll(Config.layer, Runner.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
)

command.pipe(Command.run({ version: "0.0.1" }), Effect.provide(MainLayer), NodeRuntime.runMain)
