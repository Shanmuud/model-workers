# A diagram and post you can share

This is a draft for sharing the project. Adjust it to reflect your own experience before posting.

## Excalidraw layout

Use two columns under the title **“Give each AI job its own model.”**

Left column, labeled **Direct reading**:

```text
[Large code files]
       │
       │ Full source
       ▼
[Main assistant]
       │
       ▼
[Explanation for you]
```

Right column, labeled **With a worker**:

```text
[Your question + selected files]
       │
       ▼
[Model Workers script]
       │ Reads the role → model config
       ▼
[Your chosen reading model]
       │ Focused findings + source references
       ▼
[Main assistant]
       │
       ▼
[Explanation for you]
```

Use orange for the main assistant, blue for the worker, and gray for files. Draw the source arrow thick and the findings arrow thinner. Add a small config card beside the script:

```text
explain → reading model
review  → reviewing model
draft   → writing model
```

Footer: **“The worker still uses tokens. Verify important findings.”**

If you add numbers, label them **Illustrative**: 10,000 source tokens → 1,000 finding tokens. Caption this as “90% less source-related input reaching the main model in this example.” Do not present it as a measured result or a 90% bill reduction.

## Short post draft

> Built a small CLI to give different AI jobs different models.
>
> Pick a reader, reviewer, and writer in one config. Your main assistant can call them through a script and use the results.
>
> Node.js, no npm dependencies, Codex + Claude adapters, and a free canned demo.

Repository: <https://github.com/Shanmuud/model-workers>.

## Optional follow-up

> The key idea: send large files directly to the worker. Return focused findings to the main assistant.
>
> The worker still costs tokens, and summaries can miss bugs. This is a starting point for testing model routing on your own work, not a fixed savings promise.

Credit the inspiration: [Spotify's article](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90).
