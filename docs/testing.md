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