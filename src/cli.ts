import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Layer, Option, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Config } from "./config"
import { Runner } from "./runner"

const file = Argument.file("file").pipe(Argument.optional)

const evalFlag = Flag.string("eval").pipe(
  Flag.withAlias("e"),
  Flag.withDescription("Evaluate the given string as TypeScript code"),
  Flag.optional,
)

const command = Command.make(
  "runner",
  { file, evalFlag },
  Effect.fn("runner-cli")(function* ({ file, evalFlag }) {
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
)

const MainLayer = Layer.mergeAll(Config.layer, Runner.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
)

command.pipe(Command.run({ version: "0.0.1" }), Effect.provide(MainLayer), NodeRuntime.runMain)
