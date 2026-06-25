@AGENTS.md

Never use Fable for subagents, including in workflows. Use Sonnet for
subagents unless there is a good reason to use a different model, and always
explicitly pass the model when spawning a subagent.

Unless the user explicitly requests otherwise, only operate on the
`chatbot-pf/executor` repository. This is a fork of `RhysSullivan/executor`;
do not create issues/PRs, push, or otherwise act on the upstream
`RhysSullivan/executor` or any other repository without an explicit request.
When targeting GitHub, always pass `--repo chatbot-pf/executor` explicitly so
forked-repo defaults never route work upstream.
