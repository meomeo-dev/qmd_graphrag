# Dev Agent B Baseline

1. The design must preserve the existing recovery unit:
   `book_id + processing_stage + command_check`.
2. The design must not introduce a second batch state source or bypass
   `BatchItemCheckpoint`.
3. Heartbeat ownership must remain accurate while the command is running.
4. Early stop must integrate with normal `command_failed`,
   `command_retry_scheduled`, and retry budget behavior.
5. Retry exhaustion must enter the existing provider recovery wait behavior,
   not `stop_until_fixed`.
6. The next same-`runId` run must resume from `BookResumePlan.nextStage`.
7. Incomplete partial-output artifacts must not be adopted as valid stage
   artifacts.
8. The implementation boundary must avoid modifying `vendor/graphrag` unless
   no adapter-level solution exists.
9. Configuration defaults must be safe and require no user action for batch
   processing.
10. Tests must prove that old completed-item recovery and local artifact gate
    repair behavior are unchanged.
