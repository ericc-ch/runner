#!/usr/bin/env bun

import { Command as CliCommand, Options } from "@effect/cli"
import { Command } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, pipe } from "effect"

const dryRun = pipe(
  Options.boolean("dry-run"),
  Options.withAlias("d"),
  Options.withDefault(false),
  Options.withDescription("Print release notes without creating release"),
)

const release = CliCommand.make(
  "release",
  { dryRun },
  Effect.fn(function* ({ dryRun }) {
    // 1. Get current tag
    const currentTag = yield* Command.make(
      "git",
      "describe",
      "--tags",
      "--exact-match",
      "HEAD",
    ).pipe(
      Command.string,
      Effect.map((output) => output.trim()),
    )

    // 2. Get previous tag
    const prevTag = yield* Command.make(
      "git",
      "describe",
      "--tags",
      "--abbrev=0",
      `${currentTag}^`,
    ).pipe(
      Command.string,
      Effect.map((output) => output.trim()),
    )

    // 3. Get commits
    const range = prevTag ? `${prevTag}..${currentTag}` : currentTag
    const notes = yield* Command.make(
      "git",
      "log",
      range,
      "--pretty=format:%s",
      "--no-merges",
    ).pipe(Command.string)

    yield* Effect.log(`Current tag: ${currentTag}`)
    yield* Effect.log(`Previous tag: ${prevTag}`)
    yield* Effect.log(`Range: ${range}`)
    yield* Effect.log(`Found ${notes.split("\n").length} commits`)

    // 4. Output or Release
    if (dryRun) {
      yield* Effect.log(`Release notes: ${notes}`)
    } else {
      yield* Command.make(
        "gh",
        "release",
        "create",
        currentTag,
        "--title",
        currentTag,
        "--notes",
        notes,
      ).pipe(Command.string)
      yield* Effect.log(`Release created: ${currentTag}`)
    }
  }),
)

const cli = CliCommand.run(release, {
  name: "Release Script",
  version: "0.0.0",
})

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
