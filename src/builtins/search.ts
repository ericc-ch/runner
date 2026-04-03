import type { Plugin, RunInput } from "../lib/types.ts"

interface SearchOptions {
  query?: string
  limit?: number
}

interface Indexable {
  description?: string
  meta?: unknown
}

const isIndexable = (value: unknown): value is Indexable => {
  return typeof value === "object" && value !== null && ("description" in value || "meta" in value)
}

export const searchPlugin = (): Plugin => async () => {
  let contextRegistry: Record<string, unknown>

  return {
    beforeRun: async (input: RunInput) => {
      contextRegistry = input.context

      return {
        context: {
          search: Object.assign(
            (options?: SearchOptions) => {
              const query = options?.query?.toLowerCase() ?? ""
              const limit = options?.limit ?? 10

              const results = Object.entries(contextRegistry)
                .filter(([name, value]) => {
                  if (!query) return true
                  if (!isIndexable(value)) return false

                  const nameMatch = name.toLowerCase().includes(query)
                  const descMatch = value.description?.toLowerCase().includes(query)
                  return nameMatch || descMatch
                })
                .slice(0, limit)
                .map(([name, value]) => {
                  const item = isIndexable(value) ? value : {}
                  const result: {
                    name: string
                    description: string
                    meta?: unknown
                  } = {
                    name,
                    description: item.description ?? "",
                  }

                  if (item.meta !== undefined) {
                    result.meta = item.meta
                  }

                  return result
                })

              return { results }
            },
            {
              description: "Search available context (returns all if no query)",
              input: {
                query: "search query (optional)",
                limit: "max results (default 10)",
              },
            },
          ),
        },
      }
    },
  }
}
