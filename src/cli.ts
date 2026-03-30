import { Argument, Command, Flag } from "effect/unstable/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"

const text = Argument.string("text")
const bold = Flag.boolean("bold").pipe(Flag.withAlias("b"))

const command = Command.make("hello-world", { text, bold }, (args) =>
  Console.log("Hello World", args.text, args.bold ? "bold" : "normal"),
)

const program = Command.run(command, { version: "v1.0.0" })

NodeRuntime.runMain(Effect.provide(program, NodeServices.layer))
