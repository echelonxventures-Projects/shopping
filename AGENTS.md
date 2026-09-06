# AGENTS.md — Build Agent Guide

## Project
AetherCommerce — global multi-tenant, multi-vendor, zero-hardcode commerce platform.
**The one canonical plan document: `docs/PLATFORM-PLAN.md`** (Living-Document Protocol: single doc, upgrade-only, roadmap re-synced in every change, no final state).

## Laws (read before touching anything)
1. **Six Doctrines** (doc §0) govern every decision — especially ECR derivation (everything is config/data) and Total Agnosticism (no binding technology).
2. Never hardcode: markets, fees, taxes, rules, workflows, product types, ID schemes, crypto policies. All runtime data in `packs/` or the registry.
3. Kernel code (kernel/) holds only invariants; services/ holds kernel applications; packs/ holds config data.
4. Tech choices are swappable Reference Packs — refer to technologies as `-class` adapters in docs.

## Commands
- Build: `npm run build` (repo root, workspaces)
- Test: `npm test`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`

## Workflow rules
- Any requirement change → update `docs/PLATFORM-PLAN.md` (upgrade-only edit) in the same change, including §16 register status + §7 roadmap sync.
- Commit messages: `type(scope): summary` (feat/fix/docs/chore/refactor).
- Never commit secrets. CI runs secret scanning.
- Every trackable work item has a TID in §16 (e.g., `P0-KRN-001`). Reference TIDs in commits.
