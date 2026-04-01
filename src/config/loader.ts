import { Effect, FileSystem, Path, Schema, ServiceMap } from "effect"
import { createJiti } from "jiti"

export const ConfigSchema = Schema.Struct({
  plugins: Schema.optional(Schema.Array(Schema.Any)),
})

export type Config = Schema.Schema.Type<typeof ConfigSchema>

export function defineConfig(config: Config): Config {
  return config
}

export class Tono extends ServiceMap.Service<Tono>()(
  "pkg-placeholder/config/loader/Tono",
  {
    make: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const jiti = createJiti(import.meta.url)

      const loadFile = (filePath: string) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(filePath))) return null
          return yield* Effect.promise(() =>
            jiti.import(filePath, { cache: false, interopDefault: true }),
          )
        })

      const merge = (global: Config | null, local: Config | null): Config => {
        if (!global) return local ?? { plugins: [] }
        if (!local) return global
        return {
          plugins: [...(global.plugins ?? []), ...(local.plugins ?? [])],
        }
      }

      const load = () =>
        Effect.gen(function* () {
          const homedir = yield* Effect.sync(() => path.homedir())
          const cwd = yield* Effect.sync(() => process.cwd())

          const globalPath = path.join(homedir, ".config/runner/config.ts")
          const localPath = path.join(cwd, ".runner/config.ts")

          const global = yield* loadFile(globalPath)
          const local = yield* loadFile(localPath)

          return merge(global, local)
        })
    }),
  },
) {}
