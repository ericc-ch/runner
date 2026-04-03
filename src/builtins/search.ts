import type { Plugin, RunInput } from "../types.ts"

interface SearchQuery {
  query?: string
  limit?: number
}

export const searchPlugin = (): Plugin => async () => {
  let contextRegistry: Record<string, unknown>

  return {
    beforeRun: async (input: RunInput) => {
      contextRegistry = input.context

      return {
        context: {
          search: Object.assign(
            (query?: SearchQuery) => {
              const q = query?.query?.toLowerCase() ?? ""
              const limit = query?.limit ?? 10

              const results = Object.entries(contextRegistry)
                .filter(([name, value]) => {
                  if (!q) return true

                  const meta = value as { description?: string }
                  const nameMatch = name.toLowerCase().includes(q)
                  const descMatch = meta.description?.toLowerCase().includes(q)
                  return nameMatch || descMatch
                })
                .slice(0, limit)
                .map(([name, value]) =>
                  Object.assign({ name }, value as object, {
                    description: (value as { description?: string }).description ?? "",
                  }),
                )

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
