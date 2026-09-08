# How the script works

Suppose you ask: “What happens when a payment fails?”

You want one model to investigate the code and your main assistant to explain the result. You need a small program between them that selects source, chooses the worker, runs it, and returns its answer.

You can follow those four pieces in the actual implementation:

| Piece | Source file |
| --- | --- |
| Parse the command and return the answer | [`bin/model-workers.mjs`](../bin/model-workers.mjs) |
| Map a job to a provider and model | [`lib/config.mjs`](../lib/config.mjs) |
| Select files and build the worker prompt | [`lib/context.mjs`](../lib/context.mjs) |
| Run the provider and extract its answer | [`lib/providers.mjs`](../lib/providers.mjs) |

## Follow one command

```bash
model-workers explain \
  --repo ./examples/payment-app \
  --path payments.js \
  --config ./workers.local.json \
  --question "What happens when a payment fails?"
```

### 1. Read the request and configuration

`explain` is the job. The script looks up `workers.explain` in the explicitly supplied config. If that entry says `claude`, it uses the Claude adapter; if it says `codex`, it uses the Codex adapter. The model identifier comes from the configuration or an explicit model flag.

This routing is ordinary programming. The config maps a job to a provider and model. No extra model is needed to read that mapping.

If your main assistant calls the command, the assistant decides that explanation is the appropriate job. Instructions can guide that decision, but this CLI does not install hooks that automatically intercept the assistant's file reads.

### 2. Collect source within a budget

The script resolves the repository and selected paths, checks that the files are allowed, and reads their contents. For this example it reads the bundled `examples/payment-app/payments.js`.

With no explicit paths, it considers Git-tracked files. It filters common secrets, generated files, and dependency directories, then prioritizes README files and filenames that match words in the question. It stops at the configured source budget. This can miss relevant files: when you know where the behavior lives, supply the paths.

Reading a file in the script does **not** put the file into your main assistant's context. That only happens if the file's contents are returned to the main assistant.

### 3. Run the chosen provider

The script constructs a prompt containing the job instructions, your question, and the selected source labeled with file paths and line numbers. Conceptually:

```text
Job: Explain the supplied source. Identify supporting files and functions.

Question: What happens when a payment fails?

File: payments.js
[selected source code]
```

The provider adapter starts the installed CLI as a subprocess and supplies the prompt. It passes the requested model as an argument and uses restricted settings. The worker does not need to navigate the project: the script has already supplied the selected files.

The adapters are the replaceable part. Supporting another provider means implementing the same contract: accept the prompt and model, run the provider with a timeout, and return its final answer or a clear error.

### 4. Return the answer

The script captures the provider's output and returns the final answer. For the bundled example, the relevant behavior is:

> In `payments.js`, `pay()` makes up to three charge attempts: the initial attempt and two retries. It waits five seconds before retrying a `NETWORK_ERROR`. Other errors, or a failure on the third attempt, are thrown to the caller. This file does not establish whether retrying could duplicate a charge.

That explanation comes from reading the example code; the offline demo does not generate it. A useful model result should likewise include evidence and what the selected files cannot establish.

Your main assistant receives the answer and can explain it, ask a narrower follow-up, or read an exact source section when needed. A subsequent worker call must include its own question and relevant context; conversation memory is not shared automatically.

## Where the possible savings come from

Imagine the selected files contain 10,000 tokens and the worker returns 1,000 tokens. These are hypothetical numbers:

```text
Direct reading:
Files ──10,000 tokens──> Main model

Delegated reading:
Files ──10,000 tokens──> Worker ──1,000 tokens──> Main model
```

The main model receives less source-related input. The worker still reads the source and generates its answer. Across both models, total token usage can increase, while cost can decrease if the worker's work is inexpensive enough. Model prices, caching, retries, and verification all affect the result.

This script reports source and answer estimates using bytes divided by four, plus token usage reported by a real provider when available. The source estimate excludes prompt instructions and formatting. A comparison of source bytes and answer bytes does not establish billing savings or equivalent answer quality.

## Why there are three jobs

The same plumbing supports three different prompts and model choices:

| Job | Example request | Expected output |
| --- | --- | --- |
| `explain` | “How are failed payments retried?” | Behavior, source references, and gaps |
| `review` | “Could retrying create a duplicate charge?” | Potential issues with evidence |
| `draft` | “Draft tests for exhausted retries.” | Proposed text for you to inspect |

The worker never applies edits. A draft is returned as text; `--output` can save that answer to a new file. The script checks the destination before making the model call and creates the file only after receiving a successful answer. It refuses to overwrite an existing file. It does not automatically review drafts, run tests, or validate generated code.

## What still needs judgment

A short summary can omit the detail that explains a bug. File selection can miss an important module. Source comments can also contain instructions that the worker should treat as data, not directions. Restricted tools reduce what the worker can do, but do not prove that its answer is correct or provide complete host isolation.

For consequential changes, use the worker to locate evidence, inspect the relevant source, and verify the change with appropriate tests. If the main assistant already read all the files before delegation, the worker cannot undo that earlier input cost.

The [demo payment project](../examples/payment-app) lets you inspect the plumbing without a paid call. Its canned response is deliberately labeled; use a real provider to evaluate whether your chosen model produces useful results on your own code.
