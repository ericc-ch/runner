import { defu } from "defu"
import { Effect, FileSystem, Layer, Path, Schema, ServiceMap } from "effect"
import envPaths from "env-paths"
import { createJiti } from "jiti"

const paths = envPaths("runner")

export class JitiError extends Schema.TaggedErrorClass<JitiError>()(
  "JitiError",
  {
    cause: Schema.Defect,
  },
) {}

export class ConfigSchema extends Schema.Class<ConfigSchema>("ConfigSchema")({
  plugins: Schema.optional(Schema.Array(Schema.Any)),
}) {
  static readonly empty: ConfigSchema = { plugins: [] }
}

export function defineConfig(config: ConfigSchema): ConfigSchema {
  return config
}

export class Config extends ServiceMap.Service<Config>()(
  "@ericc-ch/runner/Config",
  {
    make: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const jiti = createJiti(import.meta.url)

      yield* fs.makeDirectory(paths.config, { recursive: true })

      const loadFile = Effect.fn(function* (filePath: string) {
        return yield* Effect.tryPromise({
          try: () => jiti.import(filePath) as Promise<ConfigSchema>,
          catch: (cause) => new JitiError({ cause }),
        })
      })

      const load = Effect.fn(function* () {
        const cwd = yield* Effect.sync(() => process.cwd())

        const globalPath = path.join(paths.config, "config.ts")
        const localPath = path.join(cwd, ".runner/config.ts")

        const global = yield* loadFile(globalPath).pipe(
          Effect.catchTag("JitiError", () =>
            Effect.succeed(ConfigSchema.empty),
          ),
        )
        const local = yield* loadFile(localPath).pipe(
          Effect.catchTag("JitiError", () =>
            Effect.succeed(ConfigSchema.empty),
          ),
        )

        return defu(local, global)
      })

      return { load }
    }),
  },
) {
  static readonly layer = Layer.effect(Config, Config.make)
}
