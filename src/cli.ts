// Import necessary modules from the libraries
import { Args, Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect, pipe } from "effect"

const text = Args.text({ name: "text" })
const bold = Options.boolean("bold").pipe(Options.withAlias("b"))

const command = Command.make("hello-world", { text, bold }, (args) =>
  Console.log("Hello World", args.text, args.bold ? "bold" : "normal"),
)

// Set up the CLI application
const cli = Command.run(command, {
  name: "Hello World CLI",
  version: "v1.0.0",
})

pipe(cli(process.argv), Effect.provide(NodeContext.layer), NodeRuntime.runMain)
