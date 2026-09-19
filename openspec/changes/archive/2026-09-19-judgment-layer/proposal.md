## Why

Every judgment the harness makes today is one of two things: a hard-coded heuristic that costs nothing and is wrong in both directions (regexes over free-text prompts, an executable allowlist, first-fit context packing), or a full frontier-model child process that costs cents and minutes per stage. Nothing sits between them, so the harness cannot spend a fraction of a cent and a fraction of a second to answer a narrow question — before deciding whether to spawn an expensive agent, what to put in its context, or whether its output needs another agent to check it.

A typed, calibrated, sub-cent classifier fills exactly that gap. The ten integrations that follow in the rollout are all call sites of one shared layer. This change builds the layer alone and ships it with no call sites, so its safety properties — fallback, opt-in, egress control, audit — are reviewed and tested once, before any decision in the harness depends on them.

## What Changes

- Add a judgment layer that answers narrow typed questions about a state and returns typed answers with calibrated probabilities, or reports that it is unavailable. An operational failure never raises an error and never hangs the caller; the caller falls back to what it does today.
- Add two operating modes. Shadow, the default once judgment is enabled, evaluates and records a decision but hands the caller nothing to act on. Enforce hands an acting outcome to the caller. The difference is structural, so a call site cannot forget to check it.
- Add fail-safe decision gates: a decision either acts or abstains, and abstaining means the caller does what it does today.
- Pin the model version and record every decision — question identifiers, probabilities, confidences, the model reported, the gate outcome, whether the caller acted — in the change's run store. Records can be reconciled with what the expensive stage actually concluded and summarized per decision, which is how thresholds get set from data rather than from round numbers.
- Report judgment spend through the existing usage and budget accounting, as a distinct role and an optional budget activity.
- Add egress controls: explicit opt-in, redaction of every outgoing state, a denylist for credential-bearing content, and size limits. Document what leaves the machine in the security documentation.
- Add record and replay support so automated tests never reach the network.
- Add no call sites. With judgment disabled, or with no decision wired to it, no existing behavior changes.

## Capabilities

### New Capabilities

- `judgment-layer`: How the harness obtains typed, calibrated answers about a state — the guarantee that it degrades to existing behavior, how shadow and enforce modes differ, how uncertainty is handled, what is recorded about every decision, how spend is accounted, and how tests stay hermetic.
- `judgment-egress`: What may leave the machine when judgment is used — the explicit opt-in, redaction, the credential denylist, size limits, and the documentation obligation.

### Modified Capabilities

None.

## Impact

- **New library:** the judgment layer, a leaf library that phases and controllers call and that calls nothing back.
- **Telemetry:** a new usage role and a new optional budget activity for judgment spend; the telemetry report accepts both.
- **Errors:** one new error code for malformed question definitions, classified as an internal fault with no blocker.
- **Persistence:** a new per-change record kind in the run store; nothing else reads it.
- **Configuration:** `MUSTER_JEV`, `MUSTER_JEV_API_KEY`, and `MUSTER_JEV_MODE`. With any of the first two unset the harness behaves exactly as it does today.
- **Dependencies:** none added. Requests use the platform HTTP client.
- **Documentation:** the security documentation gains a section on judgment egress; the testing documentation gains a note on recorded fixtures.
- **Compatibility:** no observable change with judgment disabled, and no call sites exist until later changes add them.
- **Out of scope:** every call site; the calibration script that consumes recorded decisions; per-project threshold configuration.
- **Ordering:** every later judgment change depends on this one. It is independently revertable because nothing calls it yet.
