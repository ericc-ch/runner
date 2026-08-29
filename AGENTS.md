TypeScript execution engine for AI agents. Plugins inject context (browser, DB, APIs) into an MCP `execute`/`search` surface.

Uses pnpm. Run `pnpm run check` after completing any work.

# References Directory

The `.references/` directory contains shallow clones of important external repositories.
Never make any changes in this directory; it is ignored by git and meant as reference only.

Prefer exploring and reading this directory over searching for documentation.

Available references:

- effect-smol — Effect v4
- playwright — Playwright
- executor — RhysSullivan/executor (pause/elicitation, tool sandbox)
- playwriter — remorses/playwriter
- agent-browser — vercel-labs/agent-browser

## Idiomatic Effect (v4)

Use `.references/effect-smol` as the source of truth (also `ai-docs/` inside it for patterns).
