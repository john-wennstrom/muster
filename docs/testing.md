# Testing

## Local CI checks

The CI contract pins Bun 1.4.0 from `package.json` and runs against Node.js 22. Run the same checks locally from the repository root:

```text
bun install --frozen-lockfile
bun run ci:validate
bun run typecheck
bun run ci:test
bun run test:extension-smoke
bun run test:git-worktree
bun run test:host-runner
bun run acceptance:ci-status
```

`ci:validate` parses `.github/workflows/cross-platform.yml` as YAML and checks the operating-system matrix, runtime pins, frozen install, and required package-script commands. CI steps intentionally use Bun commands without shell-specific syntax so the native Windows runner uses the same contract as Linux and macOS.

## Expected matrix results

The `Cross-platform CI` workflow creates three independent jobs with `fail-fast` disabled:

| Runner | Expected result |
| --- | --- |
| `ubuntu-latest` | Frozen install, workflow validation, typecheck, full unit/integration suite, extension smoke, Git/worktree contracts, and host-runner contracts pass. |
| `macos-latest` | The same checks pass with native macOS path, process, symlink, cancellation, and Git behavior. |
| `windows-latest` | The same checks pass under native Windows path, process, cancellation, and Git/worktree behavior. |

A release matrix is successful only when all three jobs pass. Local validation proves workflow syntax and the current host's behavior; confirmation on all supported operating systems requires the hosted workflow or equivalent native runners and is handled by the conditional manual acceptance task 13.4.

After the workflow is triggered externally, `acceptance:ci-status` performs a read-only GitHub check for the current `HEAD`. It exits successfully only when the matching workflow and all three operating-system jobs completed successfully.

## Judgment in tests

Automated tests never reach the judgment service. They pass a scripted client to the judgment runtime (`createScriptedClient` in `tests/helpers/scripted-judgment.ts`): a script maps a decision id to fixed answers, or to a function of the request that returns answers keyed by question identifier. A request for a decision the script does not name throws an error that names it, and the test also fails when it ends, even if the caller swallowed the error as an unavailable service, so a test cannot pass while testing nothing. Fallback behavior is tested with `createDeadClient(reason)`, once per unavailable reason.

Nothing is recorded and nothing is keyed by a hash, so changing a question's wording does not invalidate any test. Two things guard against wording that the live service reads differently from what its author intended. `tests/judgment/client.test.ts` parses a canned response body in the service's documented shape, and `bun run judgment:probe [decision-id]` sends each decision's representative input to the live service and prints the answers and whether the gate would act. The probe needs `MUSTER_JEV=1` and `MUSTER_JEV_API_KEY`, is a tool for a person, and is never run by the suite.

## Guards and budgets

Some invariants of the pipeline are tests, not conventions:

- `tests/layering/source-hygiene.test.ts` fails on any source module that no chain of imports from an entry point reaches. There is no allowlist.
- `tests/layering/size-budget.test.ts` fails and names any `src/**/*.ts` file over 500 lines, and any `tests/**/*.ts` file over 600 lines whose first comment lacks a line starting `size-budget:` with a reason. Split a file along its responsibilities rather than deleting tests; a single long scenario may carry a `size-budget:` reason instead.
- `tests/e2e/session-budget.test.ts` replaces the agent child process with a counter (`tests/helpers/session-count.ts`) and drives propose, review, implement and verify. A small one-task change starts at most three sessions and no planning reviewer, a medium one at most four, and a large change starts opinions and a debate before its plan session. The figures are the simplification series' promise; change them only with a stated reason.
- `tests/prompts` renders every prompt template to a golden file and checks that every catalogued decision has a question file and that every question identifier a gate reads exists in it. Regenerate the goldens on purpose with `bun run tests/prompts/capture.ts`.
- `bun run docs:check` validates documentation links and command examples, that every catalogued decision has a row in the security model's call-site table, and that the command flow document names every action and every decision.

