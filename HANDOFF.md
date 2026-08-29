# Handoff — runner / CursorClaw / browser runtime

**Status:** exploratory — **nothing below is final**  
**Date:** 2026-06-22  
**Repo:** `/home/erickc/projects/runner`  
**Branch:** `main` (1 commit ahead of `origin/main`; uncommitted work — see below)  
**Continuity:** user continuing on another machine with a fresh agent  
**Transcript:** `/home/erickc/.cursor/projects/home-erickc-projects-runner/agent-transcripts/9c32dca7-487f-44c6-9af2-8fadfef45011/9c32dca7-487f-44c6-9af2-8fadfef45011.jsonl`

---

## TL;DR for next agent

User is **not** building a generic plugin runner anymore. Direction (still draft):

1. **CursorClaw** (new project / separate repo TBD) — personal OpenClaw-like host on **Cursor Agent SDK**, with **RhysSullivan/executor** embedded as the API/tools code engine (QuickJS + `tools.*`).
2. **Runner** (this repo) pivots to **browser-only MCP runtime** — playwriter-style code (`page`, `context`, `state`), **agent-owned browser daemon** (agent-browser idea), MCP-first (not CLI sessions for models).
3. **Tool surface preference:** Cloudflare-style **one blocking `codemode({ code })` with timeout** — **not** model-visible `wait`. Host/UI handles approve/resume.
4. User ** hates current playwriter** (errors, CLI-first, abandoned MCP feel) but wants its **code REPL ergonomics**.
5. **Nothing is decided** — names, repos, v0 scope, replay vs snapshot, Effect vs plain Node, etc.

---

## Session timeline (what we explored)

### 1. Standardization (done, committed)

Aligned `runner` dev tooling with sibling project `../tx`: references dir, oxlint, CI, shortened AGENTS.md, etc. Commit: `a6d4a92 chore: align dev tooling with tx standards`.

### 2. Architecture review (“improve codebase”)

Identified runner as over-scoped generic plugin host. Key findings:

- Two executors existed (`node:vm` vs `new Function`) — **removed `new Function`** (uncommitted).
- Plugin API wider than usage (`Partial<RunInput>`, `search` via executing code string).
- Playwright plugin is a 47-line stub vs playwriter’s 1500-line executor.

### 3. Executor swappability debate

Original runner vision: swappable executors (Deno, Python, etc.). Conclusion:

- **Live objects** (Playwright `page`) cannot cross process boundaries without IPC/proxy/serialization.
- Swappable executors only made sense for **in-process JS tuning**; not different languages.
- **Serialization is for isolation**, not approval — approval can happen at host boundaries without pickle.

### 4. “Fork V8 / custom engine for debugger-like pause”

Explored; deprioritized for v0:

- QuickJS embed (rquickjs) feasible; fork V8 not.
- Executor already does pause via **async suspension at tool boundary**, not bytecode debugger.
- For **trusted browser + live Playwright**, Proxy/wrapper or separate node:vm path beats custom engine.

### 5. Reference projects added to `.references/`

Run `node scripts/references.ts` (also on `pnpm install` prepare):

| Dir | URL | Why |
|---|---|---|
| `effect-smol` | Effect-TS/effect-smol | Effect v4 patterns |
| `playwright` | microsoft/playwright | API reference |
| `executor` | RhysSullivan/executor | QuickJS engine, tools.*, pause/elicitation, MCP host |
| `playwriter` | remorses/playwriter | Code REPL + VM sandbox (reference, user unhappy with product) |
| `agent-browser` | vercel-labs/agent-browser | Agent-owned browser daemon, snapshot/ref CLI |

**Not cloned:** `openclaw/openclaw` (docs only — see links below).

### 6. Playwriter vs agent-browser vs runner

| | Playwriter | Agent-browser | Runner (today) |
|---|---|---|---|
| Agent interface | MCP `execute`+`reset` (docs push CLI) | Many typed MCP tools / CLI | `execute`+`search` |
| Code | Full Playwright in VM | `eval` secondary; refs primary | Generic plugins |
| Browser | User Chrome via extension+relay | Agent-launched daemon | Helium stub in plugin |
| User sentiment | **Used to be good, now sucks** | Inspiration for ownership | Pivot target |

### 7. CursorClaw + executor embed (draft architecture)

**CursorClaw** = Cursor SDK host + code-mode orchestration.  
**Executor** = npm packages, not fork (yet):

```typescript
import { createExecutor } from "@executor-js/sdk";
import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

const executor = await createExecutor({ plugins: [...], onElicitation: handler });
const engine = createExecutionEngine({ executor, codeExecutor: makeQuickJsExecutor({ timeoutMs }) });
```

- `@executor-js/host-mcp` is **private** in executor monorepo — shipped via `executor mcp` CLI; CursorClaw likely wraps `createExecutionEngine` itself.
- Executor maps closely to OpenClaw code mode guest (`tools.search/describe/call`).

**Runner** does **not** use QuickJS for browser — live `page` in `node:vm`.

### 8. Cloudflare Code Mode + Project Think (preferred tool-surface inspiration)

Docs:
- https://developers.cloudflare.com/agents/model-context-protocol/protocol/codemode/
- https://blog.cloudflare.com/project-think/

Key ideas (candidate for CursorClaw, not final):

- **One model tool:** `codemode({ code })` — not exec/wait pair.
- Guest: `codemode.search`, `codemode.describe`, connector globals (`github.list_pull_requests`).
- **Connectors** with per-method `requiresApproval`, optional `revert`.
- **Runtime** (durable log, pending, approve, snippets) vs **Executor** (stateless sandbox).
- Approval: run aborts → host `runtime.approve({ executionId })` → **replay** from log (not model `wait`).
- **Execution ladder:** workspace → sandbox JS → npm → browser → full OS sandbox.
- Project Think: fibers, sub-agents, Session API, `@cloudflare/think` base class — long-running agent infra (Cloudflare-specific; patterns may inspire, not copy).

### 9. No model-visible `wait` (user preference, draft)

User dislikes OpenClaw/executor exposing `wait` to the model. Prefers **blocking with timeout**.

Candidate patterns:

1. `engine.execute(code, { onElicitation })` — blocks until handler resolves; wall-clock timeout.
2. MCP handler `Promise.race(timeout, approvalDeferred)` — single model call.
3. Cloudflare replay — return `{ status: "paused", executionId }` if timeout exceeded; **host** approves and re-runs/replays.

If pause needed: **CursorClaw host / UI** calls approve/resume — never a second model tool.

---

## Draft system diagram (NOT FINAL)

```
┌─────────────────────────────────────────────────────────────────┐
│  CursorClaw (new — Cursor Agent SDK host)                       │
│  Model tools (draft): codemode({ code }) [+ browser_exec?]    │
│  Host-only: pending(), approve(), reject(), rollback()          │
├─────────────────────────────────────────────────────────────────┤
│  Code engine: @executor-js/execution + runtime-quickjs          │
│  Tool catalog: @executor-js/sdk + plugins (openapi, mcp, …)     │
├─────────────────────────────────────────────────────────────────┤
│  Browser connector → runner MCP (separate process or repo)      │
│  node:vm, live page/context/state, agent-owned CDP daemon       │
└─────────────────────────────────────────────────────────────────┘
```

**Open tension (unresolved):** QuickJS = JSON tool bridge; browser = live objects. Leading options:

1. **Two runtimes** — QuickJS for APIs; runner MCP for Playwright code (user leans here).
2. **Hybrid model tools** — `codemode` + `browser_exec` (~2–4 tools total).
3. Browser as MCP namespace inside QuickJS — loses full Playwright ergonomics.
4. Custom host bindings in embedded engine — large build.

---

## Runner pivot (this repo — draft)

**From:** generic TS execution engine + plugins + MCP execute/search.  
**Toward:** browser-only MCP server.

Draft v0:

```
Long-lived MCP process
  ├── agent-owned browser (CDP daemon — agent-browser pattern)
  ├── session state: page, context, state (playwriter pattern)
  └── MCP tools: execute(code), reset()
        node:vm sandbox, scoped require, console capture, timeout
```

**Strip (likely):** generic plugin hooks, `search` via code injection, executor on Hooks, OpenAPI roadmap in README.

**Keep/evolve:** `executor-node-vm.ts`, `mcp.ts`, compile-code (amaro strip).

**Reference impl:** `.references/playwriter/playwriter/src/executor.ts` (~1500 lines — copy patterns, don’t depend on package).

**User browser hint:** `.runner/plugins/playwright.ts` uses `command -v helium` — direct CDP, **no extension/relay for v0**.

---

## Playwriter — why user rejected it (context for next agent)

- User **has been using it**; **used to work**, now **errors constantly**.
- Docs say **CLI recommended**; skill pushes `playwriter session new` + `-s 1` — **bad for stateless models** (session ID burden on model).
- MCP still exists (`execute`, `reset`) but feels neglected vs CLI/relay/extension complexity.
- Architecture: Chrome extension + relay server + CDP + sessions + token auth — many failure modes (changelog 0.2–0.3 shows race fixes, extension versioning, etc.).
- **Steal:** VM sandbox scope, auto-return expressions, snapshot helpers, MCP tool shape.  
- **Avoid for v0:** extension, relay, CLI-as-agent-interface.

---

## Agent-browser — what to borrow (not become)

- **Agent-owned browser** — daemon persists across commands; model never manages browser lifecycle.
- Snapshot `@eN` ref loop — **different paradigm** (token-efficient commands); user wants **code** for browser, not ref-only.
- MCP: typed tools, profiles (`core` vs `all`), delegates to CLI `--json`.
- Skills bundled with CLI version (`agent-browser skills get`).

---

## Executor — embed guide (for CursorClaw)

**Published npm (pre-1.0):**

- `@executor-js/sdk` — `createExecutor`, plugins, secrets, tool invoke
- `@executor-js/execution` — `createExecutionEngine`, pause/resume, sandbox invoker
- `@executor-js/runtime-quickjs` — `makeQuickJsExecutor` (~13MB WASM, bring your own)
- `@executor-js/plugin-*` — openapi, mcp, graphql, etc.

**APIs:**

- `engine.execute(code, { onElicitation })` — inline blocking approval
- `engine.executeWithPause(code)` + `engine.resume(id, response)` — split (maps to MCP `execute`+`resume`; user may hide `resume` from model)
- Guest code: `tools.search`, `tools.describe`, lazy `tools.*` proxy — see `.references/executor/packages/kernel/runtime-quickjs/src/index.ts`

**Private:** `@executor-js/host-mcp` — reference at `.references/executor/packages/hosts/mcp/src/tool-server.ts`

**Effect:** used internally; Promise surface at `@executor-js/execution` root import.

---

## OpenClaw code mode (reference, partially superseded by Cloudflare preference)

https://docs.openclaw.ai/reference/code-mode

- Model tools: `exec` + `wait` (user **does not want** this shape for CursorClaw).
- QuickJS-WASI guest, hidden catalog, `MCP.*` namespace, virtual `API.read("mcp/*.d.ts")`.
- VM snapshot + `wait(runId)` for nested elicitation.
- **Not** Codex Code mode (shell `exec.command` — different thing).

Executor monorepo is already a practical OpenClaw-like engine for self-hosted Node.

---

## Code already in repo

### Committed

- `a6d4a92` — tx standardization (references, CI, AGENTS.md, deps, etc.)

### Uncommitted (preserve)

| Change | Notes |
|---|---|
| Deleted `src/builtins/executor-new-fn.ts` | single VM executor |
| Added `src/builtins/compile-code.ts` | shared amaro wrap/strip |
| `src/builtins/executor-node-vm.ts` | timer `finally`, pin `abortSignal`, URL explicit for VM |
| `src/builtins/executor-node-vm.test.ts` | abortSignal override test inverted |
| `src/main.ts` | removed new-fn exports |
| `.runner/config.ts` | dropped executorNewFnPlugin |
| `scripts/references.ts`, `AGENTS.md` | executor, playwriter, agent-browser |
| `README.md` | VM-only executor docs (may be stale vs pivot) |

Run `pnpm run check` before commit — was green after executor cleanup.

---

## Explicit non-goals / rejected (so far)

- Generic plugin host as product
- Hand-mapping full Playwright API
- Forking V8 / custom Rust JS engine for v0
- playwriter extension + relay for v0
- CLI session IDs for agents (`-s 1`)
- Model-visible `wait` tool (user preference — draft)
- Competing with executor on API tools inside runner

---

## Open questions (ALL UNRESOLVED)

**Product / repos**

- Rename `@ericc-ch/runner`? Separate `cursorclaw` repo?
- Monorepo vs two repos?

**CursorClaw**

- Cursor SDK: local agent + MCP subprocesses vs cloud?
- Single `codemode` tool vs also `browser_exec`?
- Replay log (Cloudflare) vs VM snapshot (OpenClaw/executor) for approvals?
- Durable runtime v0 or in-memory only?
- Fork executor vs npm depend?

**Runner / browser**

- Helium CDP only vs agent-browser-style `install` + Chromium?
- User’s logged-in Chrome / extension — v2?
- Keep Effect layers or plain Node for velocity?
- Snapshot/ref helpers from agent-browser in addition to code execute?

**Build order**

- Browser runtime v0 first vs CursorClaw shell first vs spike both?

**playwriter**

- Any salvage dependency or clean-room from reference only?

---

## Key file paths

| Path | Role |
|---|---|
| `HANDOFF.md` | This document |
| `src/mcp.ts` | Current MCP server |
| `src/builtins/executor-node-vm.ts` | VM executor (browser path candidate) |
| `src/builtins/compile-code.ts` | TS strip helper |
| `src/lib/runner.ts` | Plugin loop — likely remove/shrink |
| `src/lib/config.ts` | Plugin loading — likely remove/shrink |
| `.runner/plugins/playwright.ts` | User Helium CDP stub |
| `.references/playwriter/playwriter/src/executor.ts` | Sandbox bible |
| `.references/playwriter/playwriter/src/mcp.ts` | MCP execute/reset |
| `.references/agent-browser/cli/src/mcp.rs` | MCP + daemon pattern |
| `.references/executor/packages/core/execution/src/engine.ts` | Pause/resume engine |
| `.references/executor/packages/kernel/runtime-quickjs/src/index.ts` | QuickJS + tools proxy |
| `.references/executor/packages/hosts/mcp/src/tool-server.ts` | Executor MCP server ref |
| `scripts/references.ts` | Clone/update references |
| `AGENTS.md` | Agent instructions + references list |

---

## External links

| Resource | URL |
|---|---|
| OpenClaw code mode | https://docs.openclaw.ai/reference/code-mode |
| Cloudflare Code Mode | https://developers.cloudflare.com/agents/model-context-protocol/protocol/codemode/ |
| Project Think | https://blog.cloudflare.com/project-think/ |
| Cursor SDK TS | https://cursor.com/docs/sdk/typescript |
| Cursor SDK skill | `~/.cursor/skills-cursor/sdk/SKILL.md` |
| Executor repo | https://github.com/RhysSullivan/executor |
| Playwriter | https://github.com/remorses/playwriter |
| Agent-browser | https://github.com/vercel-labs/agent-browser |
| Cloudflare Code Mode blog (runner README credit) | https://blog.cloudflare.com/code-mode/ |

---

## Suggested first actions for next agent

1. Read this file + skim transcript for tone/constraints.
2. Ask user which **open question** to nail first (if not already specified).
3. Do **not** assume exec/wait or generic plugins — confirm tool surface.
4. If coding in **runner**: pivot toward browser MCP v0; don’t expand plugin system.
5. If coding **CursorClaw**: new dir/repo; spike `createExecutionEngine` + single blocking tool.
6. Commit or stash uncommitted executor cleanup before large pivot diffs.
7. Optional: add `openclaw` to `scripts/references.ts` for source comparison.

---

*Last updated: 2026-06-22 — exploratory handoff for cross-machine continuation.*
