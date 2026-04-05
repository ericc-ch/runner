import { Console, Effect, FileSystem, Option, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Config } from "./lib/config.ts"
import { runtime } from "./lib/runtime.ts"
import { Mcp } from "./mcp.ts"
import { Runner } from "./lib/runner.ts"

const file = Argument.file("file").pipe(Argument.optional)

const evalFlag = Flag.string("eval").pipe(
  Flag.withAlias("e"),
  Flag.withDescription("Evaluate the given string as TypeScript code"),
  Flag.optional,
)

const executeCommand = Command.make(
  "execute",
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
  Command.withDescription("Execute TypeScript with plugin-provided context"),
  Command.withExamples([
    {
      command: "runner execute script.ts",
      description: "Execute a TypeScript file",
    },
    {
      command: "runner execute -e 'console.log(\"Hello\")'",
      description: "Evaluate TypeScript code from string",
    },
    {
      command: "cat script.ts | runner execute",
      description: "Execute TypeScript code from stdin",
    },
  ]),
)

const mcpCommand = Command.make(
  "mcp",
  {},
  Effect.fn(function* () {
    const mcp = yield* Mcp
    yield* Console.log("Starting MCP server...")
    yield* mcp.start()
  }),
).pipe(Command.withDescription("Start MCP server for AI agent and IDE integration"))

const command = Command.make("runner", {}).pipe(
  Command.withDescription("TypeScript execution environment with plugin-based context injection"),
  Command.withSubcommands([executeCommand, mcpCommand]),
)

void runtime.runPromise(command.pipe(Command.run({ version: "0.0.1" })))
