`claude-2.1.323-success.json` is a real result object from `claude -p --output-format json --json-schema ...`
(Claude Code 2.1.323, 2026-11-25), captured while repairing a planted column-swap bug in a disposable repo.
Kept fields: type, subtype, is_error, num_turns, duration_ms, total_cost_usd, permission_denials,
structured_output, modelUsage, stop_reason, terminal_reason. session_id is redacted; timing and request
diagnostics were dropped. Its structured_output predates the `fixed` field, which the parser treats as unknown.
