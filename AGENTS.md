# Agent Instructions

## Scope
- Root docs describe architecture and handoff; implementation lives in `frontend/`.
- Treat `HANDOFF.md` as the current-state ledger and `docs/development/` as the delivery history.

## Package Manager
- Use npm with `frontend/package-lock.json`.
- Install: `cd frontend && npm install`
- Run: `cd frontend && npm run dev`

## Acceptance Gate
- One GitHub Issue and one feature may be active at a time.
- Require testable acceptance criteria and `Execution Gate: allowed` before editing feature code.
- After verification, stop for explicit user acceptance; do not start the next feature.
- Update `HANDOFF.md` and add one Chinese record under `docs/development/` with every feature.

## File-Scoped Commands
| Task | Command |
|---|---|
| Lint file | `cd frontend && npx eslint <path>` |
| Test file | `cd frontend && npx vitest run <path>` |
| Typecheck | `cd frontend && npm run typecheck` |

## Full Verification
```powershell
cd frontend
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

## Key Conventions
- Save text as UTF-8 with LF; follow `.editorconfig` and `.gitattributes`.
- UI text is concise Chinese; no visible ellipsis, stale-thread flash, or invented state.
- API keys stay only in `config/*.local.json`; never expose them through client code or `NEXT_PUBLIC_`.
- Runtime payloads cross boundaries through typed AgentEvent and Zod validation.
- Keep live provider mode separate from deterministic Playwright mock mode on port `3110`.
- Preserve user changes; avoid destructive Git commands and force pushes.

## Critical Paths
- UI shell: `frontend/src/components/workbench/app-shell/WorkbenchShell.tsx`
- Runtime: `frontend/src/server/mock/engine.ts`
- Provider: `frontend/src/server/llm/deepseek-client.ts`
- Current store: `frontend/src/server/mock/store.ts`

## Commit Attribution
AI commits MUST include:
```text
Co-Authored-By: OpenAI Codex <noreply@openai.com>
```
