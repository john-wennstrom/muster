## Why

When a task's verification keeps failing, the debugging policy counts the failures. At a configured threshold the task moves from ordinary repair to systematic debugging, and ordinary repair is disabled. The count is the only signal: three attempts that each make real progress toward passing look identical to three attempts that re-run the same broken fix. Each attempt is a builder session with an eight-hour ceiling, so counting is a very expensive way to notice that a task is stuck.

What distinguishes the two cases is visible in the failure history: whether the latest failure has the same root cause as the one before it, whether the attempted fix moved the task closer to passing, and whether resolving the failure needs something an automated agent cannot supply — a decision, a credential, or access. A cheap typed judgment over two consecutive failures can answer those, after each failure, for a fraction of a cent.

One fact bounds this change. The repair loop that records failures is not yet connected to task execution: the debugging policy has no production caller, and a task whose verification or review fails currently ends as blocked rather than being retried by a repair cycle. This change therefore provides the assessment and the state transitions that loop will call, and states plainly that its production effect begins when the loop exists.

## What Changes

- After a failure is recorded, assess the latest two failures and the fix attempted between them with one typed judgment: whether they share a root cause, whether the fix made progress, whether the failure changed, whether the defect has been located, how well the fix matched the evidence, and whether resolving it needs a human.
- Escalate to systematic debugging immediately when two consecutive assessments each judge that the failures share a root cause and that the fix made no progress, if the task has not already reached its threshold.
- Stop for a human, rather than spending another attempt, when the failure is judged to need a decision, a credential, or access that an automated agent cannot obtain.
- Only ever shorten a loop. Judgment never raises the threshold, never delays the move to systematic debugging, and never re-enables ordinary repair.
- Extend the persisted failure state with an optional record of the attempted fix, the assessments made, and any early escalation, keeping every existing state valid and keeping the mode derived from the failure count unless an early escalation is recorded.
- Redact and bound the failure text sent for judgment.
- Run first in shadow mode, recording what would have been decided while transitions follow the count exactly as today.
- Do not add a repair loop.

## Capabilities

### New Capabilities

- `judgment-thrash-detection`: How a repair loop's failure history is assessed for lack of progress so the loop can be cut short — escalating to systematic debugging early, or stopping for a human — without ever lengthening it.

### Modified Capabilities

None.

## Impact

- **Debugging policy:** the persisted state gains three optional fields and a relaxed mode derivation; new pure functions record assessments, decide the next path, and record an early escalation; a new assessment step calls judgment.
- **Cost:** about $0.0001 per recorded failure, against a builder attempt.
- **Egress:** failure evidence, which may include command output and therefore secrets, the reproduction, the attempted fix, and the task definition. Redaction and size bounds matter most here. Documented in the security documentation.
- **Rollout gate:** escalations land at or before the old threshold. Because judgment can only shorten a loop, this is asserted as a property of the transition logic and by a property test over all failure histories and answers.
- **Boundary:** the loop that records failures is a roadmap item. Until it is wired, shadow and enforce records come only from tests.
- **Ordering:** depends on `judgment-layer`. Independently revertable, and inert until the repair loop calls it.
