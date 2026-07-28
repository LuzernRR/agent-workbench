# Agent Instructions

## Scope
- Root docs describe architecture and handoff; Web/BFF implementation lives in `apps/web/`, shared contracts in `packages/contracts/`, the Python Agent service in `services/search-agent/`, deployment assets in `deploy/`, and runtime configuration in `config/`.
- Treat `HANDOFF.md` as the current-state ledger and `docs/development/` as the delivery history.

## Package Manager
- Use npm with `apps/web/package-lock.json`.
- Install: `cd apps/web && npm install`
- Run: `cd apps/web && npm run dev`

## Acceptance Gate
- One GitHub Issue and one feature may be active at a time.
- Require testable acceptance criteria and `Execution Gate: allowed` before editing feature code.
- After verification, stop for explicit user acceptance; do not start the next feature.
- Update `HANDOFF.md` and add one Chinese record under `docs/development/` with every feature.

## File-Scoped Commands
| Task | Command |
|---|---|
| Lint file | `cd apps/web && npx eslint <path>` |
| Test file | `cd apps/web && npx vitest run <path>` |
| Typecheck | `cd apps/web && npm run typecheck` |

## Full Verification
```powershell
cd apps/web
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Search Agent verification:
```powershell
cd services/search-agent
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m compileall -q app
```

## Key Conventions
- Save text as UTF-8 with LF; follow `.editorconfig` and `.gitattributes`.
- UI text is concise Chinese; no visible ellipsis, stale-thread flash, or invented state.
- API keys stay only in `config/*.local.json`; never expose them through client code or `NEXT_PUBLIC_`.
- Runtime payloads cross boundaries through typed AgentEvent and Zod validation.
- Keep live provider mode separate from deterministic Playwright mock mode on port `3110`.
- Keep every real `toolCallId` in the event ledger. Search rows may aggregate only in the conversation view; their counts must increase from completed events and verified source URLs.
- Public process text comes from versioned LangGraph Agent outputs. Frontend code may label and group it but must not invent reasoning copy.
- Preserve user changes; avoid destructive Git commands and force pushes.

## Critical Paths
- UI shell: `apps/web/src/components/workbench/app-shell/WorkbenchShell.tsx`
- Runtime: `apps/web/src/server/mock/engine.ts`
- Provider: `apps/web/src/server/llm/deepseek-client.ts`
- Search BFF: `apps/web/src/server/search-agent/mapper.ts`
- Search graph: `services/search-agent/app/graph/build.py`
- Agent prompts: `services/search-agent/app/prompts/agents.py`
- Current store: `apps/web/src/server/live/store.ts`

## Commit Attribution
AI commits MUST include:
```text
Co-Authored-By: OpenAI Codex <noreply@openai.com>
```
