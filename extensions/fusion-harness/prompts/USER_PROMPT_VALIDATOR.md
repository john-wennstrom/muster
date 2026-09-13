# REQUEST (the builder will be asked to do exactly this — your script defines when it is done)
{{PROMPT}}

Project root: {{CWD}}
Run artifacts dir: {{ARTIFACTS_DIR}} — your gate lives here, and the harness saves every builder report (builder-round-N.md) and gate run (gate-round-N.txt) here as the loop progresses.
NOTE: the build has NOT happened yet. Inspect the current state read-only, then SUBMIT the gate script for the requested end state with `muster_submit_gate`. The parent will persist it to:

    {{GATE_PATH}}

Do NOT write the project or paste the script into your reply. Reply with a short confirmation only after the structured submission succeeds.
