# Contributing

Thank you for taking the time to contribute. Below is everything you need to open a valid
pull request without having to ask clarifying questions.

## Commit Message Convention

This project uses **Conventional Commits**. Each commit message must have the form:

```
<type>(<scope>): <short summary>
```

Allowed types:

| Type | When to use |
|---|---|
| `feat` | A new feature visible to consumers |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `test` | Adding or updating tests without changing production code |
| `refactor` | Code change that is neither a feature nor a bug fix |
| `chore` | Build scripts, dependency bumps, config updates |
| `perf` | A change that improves performance |

Examples:

```
feat(client): add exponential backoff for reconnection
fix(protocol): handle empty payload in SessionReady message
docs: document reconnection options in README
chore: bump vitest to 3.1.0
```

Keep the summary line ≤ 72 characters. Use the commit body for _why_, not _what_.

## Branch and PR Flow

1. **Fork** the repository and create a feature branch off `main`:
   ```
   git checkout -b feat/my-feature
   ```
2. Make your changes, keeping each commit focused and conventionally typed.
3. Open a **pull request against `main`**.
4. All CI checks must be **green** before a PR can be merged:
   - `pnpm run typecheck` — TypeScript must compile without errors
   - `pnpm test` — all tests must pass
   - `pnpm run lint:check` — Biome lint and format checks must pass (use `pnpm run lint` locally to auto-fix)
5. At least one maintainer review is required before merge.

Prefer small, focused PRs — they are easier to review and faster to land.

## Test Requirements

| Change type | Test requirement |
|---|---|
| New feature | Add at least one new test covering the happy path and one covering the main error/edge case |
| Bug fix | Add a **regression test** that fails on the unfixed code and passes after your fix |
| Refactor | All existing tests must continue to pass without modification |
| Docs / chore | No new tests required, but existing tests must still pass |

Run the full suite locally before pushing:

```
pnpm test
```

Coverage thresholds are enforced in CI (lines / functions / branches / statements ≥ 80 %).
If your change drops coverage below the threshold, add the missing tests.
