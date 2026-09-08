#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { accessSync, constants, lstatSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROLES, resolveWorker, positiveInteger } from '../lib/config.mjs';
import { collectContext, buildPrompt } from '../lib/context.mjs';
import { runWorker } from '../lib/providers.mjs';

const HELP = `model-workers — delegate selected source files to a chosen model

Usage:
  model-workers <explain|review|draft> --question TEXT [options]

Options:
  --repo DIR          Repository directory (default: current directory)
  --path FILE         File relative to --repo; repeat to select multiple files
                      Otherwise uses Git-tracked files, ranked by filename
  --config FILE       Explicit routing JSON (see workers.example.json)
  --provider NAME     codex, claude, or demo; overrides role configuration
  --model ID          Your model ID; overrides role configuration
  --dry-run           Show route and selected file metadata; no model call
  --json              Print one JSON result instead of just the answer
  --output FILE       Save the answer as a new file; never overwrite
  --max-bytes N       Total source byte limit (default: 120000; max: 1000000)
  --max-files N       File count limit (default: 40; max: 200)
  --timeout SECONDS   Worker deadline (default: 120; max: 900)
  --help              Show this help

Try without credentials:
  model-workers explain --repo examples/payment-app --path payments.js \\
    --question "What happens when a payment fails?" --provider demo

Real workers use your installed, authenticated provider CLI. They do not
inherit the main assistant's conversation. Source is sent to that provider.
`;

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' }, repo: { type: 'string', default: '.' },
      question: { type: 'string' }, path: { type: 'string', multiple: true },
      config: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
      'dry-run': { type: 'boolean' }, json: { type: 'boolean' }, output: { type: 'string' },
      'max-bytes': { type: 'string' }, 'max-files': { type: 'string' }, timeout: { type: 'string' }
    },
    allowPositionals: true, strict: true
  });
  if (values.help || !process.argv.slice(2).length) { process.stdout.write(HELP); return; }
  const role = positionals[0];
  if (positionals.length !== 1 || !ROLES.includes(role)) throw new Error('Choose exactly one role: explain, review, or draft. See --help.');
  if (!values.question?.trim()) throw new Error('--question is required.');
  if (Buffer.byteLength(values.question) > 32000) throw new Error('Question is too long (maximum 32000 bytes).');
  if (process.env.MODEL_WORKERS_ACTIVE) throw new Error('Nested worker calls are disabled. Return findings to the main assistant.');
  const worker = resolveWorker({ role, configPath: values.config, provider: values.provider, model: values.model });
  const context = collectContext({
    repo: values.repo, paths: values.path, question: values.question,
    maxBytes: positiveInteger(values['max-bytes'], '--max-bytes', 120000, 1000000),
    maxFiles: positiveInteger(values['max-files'], '--max-files', 40, 200)
  });
  const timeoutMs = positiveInteger(values.timeout, '--timeout', 120, 900) * 1000;
  const metadata = {
    role, ...worker,
    files: context.files.map(({ path, bytes, lines }) => ({ path, bytes, lines })),
    skipped: context.skipped,
    source_bytes: context.bytes,
    estimated_source_tokens: Math.ceil(context.bytes / 4)
  };
  if (values['dry-run']) {
    process.stdout.write(`${JSON.stringify({ dry_run: true, ...metadata }, null, 2)}\n`);
    return;
  }
  // Check a destination before paying for inference; open it exclusively only
  // after success. A failed model request does not leave an empty output file.
  if (values.output) {
    const destination = path.resolve(values.output);
    try {
      lstatSync(destination);
      throw new Error(`Output already exists: ${destination}. Choose a new filename.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    accessSync(path.dirname(destination), constants.W_OK);
  }
  process.stderr.write(`[model-workers] ${role} → ${worker.provider}/${worker.model}; ${context.files.length} files, ${context.bytes} source bytes\n`);
  if (context.skipped.length) process.stderr.write(`[model-workers] ${context.skipped.length} files omitted; use --dry-run to inspect selection.\n`);
  const started = performance.now();
  let response;
  if (worker.provider === 'demo') {
    response = { text: [
      'DEMO ONLY — no AI model was called.',
      `The ${role} worker would receive ${context.files.length} file(s):`,
      ...context.files.map((file) => `- ${file.path} (${file.bytes} bytes)`),
      '',
      'This canned response demonstrates the handoff. A real worker would answer your question with findings from these files.',
      'Only this answer returns to the main assistant; the source bundle stays inside the worker invocation.'
    ].join('\n') };
  } else {
    response = await runWorker({ ...worker, prompt: buildPrompt(role, values.question, context), timeoutMs });
  }
  const text = response.text.trim();
  if (!text) throw new Error('Worker returned an empty answer.');
  if (values.output) writeFileSync(path.resolve(values.output), `${text}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const result = {
    ...metadata, demo: worker.provider === 'demo',
    elapsed_ms: Math.round(performance.now() - started),
    estimated_answer_tokens: Math.ceil(Buffer.byteLength(text) / 4),
    ...(response.usage ? { provider_usage: response.usage } : {}),
    ...(values.output ? { output: path.resolve(values.output) } : { answer: text })
  };
  if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (values.output) process.stdout.write(`Saved worker answer to ${path.resolve(values.output)}\n`);
  else process.stdout.write(`${text}\n`);
  process.stderr.write(`[model-workers] Answer: ~${result.estimated_answer_tokens} tokens (bytes/4 estimate, not measured billing).\n`);
}

main().catch((error) => {
  process.stderr.write(`model-workers: ${error.message}\n`);
  process.exitCode = 1;
});
