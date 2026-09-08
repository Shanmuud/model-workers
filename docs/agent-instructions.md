# Let your main assistant call workers

Your assistant needs three things: the absolute path to the script, the absolute path to your routing config, and rules for when a worker would help.

Replace the paths below and put the instructions in the agent instructions file your main coding assistant uses, or paste them into a conversation. Creating these documents alone does not configure an assistant.

```text
Model Workers is available at:
  /absolute/path/to/model-workers/bin/model-workers.mjs

Use this routing config:
  /absolute/path/to/workers.local.json

For broad code-understanding questions, consider calling the explain worker
before reading large files into your own context. Include the user's question,
relevant constraints, and known file paths. Each worker call is independent
and does not inherit this conversation.

Use review to investigate a specific concern in selected source. It reviews
the supplied files; it does not automatically receive a Git diff.

Use draft for proposed code that follows a clear specification. Draft returns
text and does not edit the project. Inspect the result before applying it.
The worker does not automatically review or test its draft. If --output is
used, the answer is saved only after a successful response and existing
files are never overwritten.

Run a dry run when you need to check file selection. Prefer explicit --path
arguments when relevant files are known. The default selection is a limited
filename heuristic, not exhaustive repository understanding.

Read exact source sections when needed to verify findings, debug subtle
behavior, or make changes. Do not treat a worker summary as complete evidence.
Include important uncertainties in the explanation to the user.

Do not send sensitive files to a provider without authorization. The default
filters catch common secret filenames, not every secret embedded in source.
```

Example command for the assistant:

```bash
node /absolute/path/to/model-workers/bin/model-workers.mjs explain \
  --repo /absolute/path/to/my-app \
  --config /absolute/path/to/workers.local.json \
  --path src/payments.js \
  --question "Explain retry behavior. Cite functions and identify what these files cannot establish."
```

The role rules above guide the main assistant's choices. They are advisory: Model Workers does not intercept or block the assistant's other tools. Once called, the script uses the explicit configuration and flags to select a provider and model.

The final answer is printed to standard output by default. Use `--json` if a parent program needs a structured result. With `--output`, the answer is saved and the command returns the file path instead. Provider diagnostics are not forwarded as the worker's answer. Keep the parent's tool integration focused on the returned result so that source contents do not unnecessarily enter the main conversation.
