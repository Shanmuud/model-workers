import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const USAGE_KEYS = [
  'input_tokens', 'output_tokens', 'cached_input_tokens',
  'cache_read_input_tokens', 'cache_creation_input_tokens',
];

function publicUsage(value) {
  if (!value || typeof value !== 'object') return undefined;
  const entries = USAGE_KEYS.flatMap((key) => (
    Number.isFinite(value[key]) && value[key] >= 0 ? [[key, value[key]]] : []
  ));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function result(text, usage) {
  return usage ? { text: text.trim(), usage } : { text: text.trim() };
}

function knownClaudeFailure(value) {
  // Recognize only this known structured error and emit our own fixed wording.
  // Never forward the provider's arbitrary result, error text, or other fields.
  if (value?.is_error === true && value.terminal_reason === 'api_error'
    && value.api_error_status === 400 && value.result === 'Credit balance is too low') {
    return 'Claude reports insufficient credit. Check billing for the account used by the Claude CLI.';
  }
  return undefined;
}

export function buildCommand({ provider, model }) {
  if (!['codex', 'claude'].includes(provider)) {
    throw new Error('Unsupported provider. Choose codex or claude.');
  }
  if (typeof model !== 'string' || !model || /\s|\0/.test(model) || model.startsWith('-')) {
    throw new Error('The worker model must be a nonempty model name without whitespace.');
  }
  if (provider === 'codex') {
    return {
      command: 'codex',
      args: [
        'exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only',
        '--skip-git-repo-check', '--color', 'never', '--json',
        '-c', 'agents.enabled=false', '--model', model, '-',
      ],
    };
  }
  return {
    command: 'claude',
    args: [
      '--safe-mode', '--print', '--model', model, '--tools', '',
      '--output-format', 'json', '--no-session-persistence', '--permission-mode', 'dontAsk',
    ],
  };
}

export function parseClaudeOutput(output) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('Claude returned invalid JSON. Update the Claude CLI and try again.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Claude returned an unexpected response.');
  }
  if (value.is_error || (value.subtype && value.subtype !== 'success')) {
    throw new Error(knownClaudeFailure(value)
      ?? 'Claude reported a failed request. Check your login, model access, and usage limits.');
  }
  if (typeof value.result !== 'string' || !value.result.trim()) {
    throw new Error('Claude returned no final answer.');
  }
  return result(value.result, publicUsage(value.usage));
}

export function parseCodexOutput(output) {
  let answer;
  let usage;
  let completed = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error('Codex returned invalid JSON events. Update the Codex CLI and try again.');
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error('Codex returned an unexpected event.');
    }
    if (event.type === 'error' || event.type === 'turn.failed') {
      throw new Error('Codex reported a failed request. Check your login, model access, and usage limits.');
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (typeof event.item.text === 'string') answer = event.item.text;
    }
    if (event.type === 'turn.completed') {
      completed = true;
      usage = publicUsage(event.usage);
    }
  }
  if (!completed || !answer?.trim()) {
    throw new Error('Codex returned no completed final answer.');
  }
  return result(answer, usage);
}

function collectOutput({ command, args, prompt, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // No shell: neither source text nor model names can become shell commands.
    // A separate process group lets timeouts also stop ordinary child processes.
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd, shell: false, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, env: { ...process.env, MODEL_WORKERS_ACTIVE: '1' },
    });
    let bytes = 0;
    let failure;
    const chunks = [];
    const stop = (message) => {
      failure ??= new Error(message);
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      stop(`${command} timed out after ${timeoutMs} ms. Try a smaller file selection or a longer timeout.`);
    }, timeoutMs);
    const interrupt = () => stop(`${command} was interrupted by SIGINT.`);
    const terminate = () => stop(`${command} was interrupted by SIGTERM.`);
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.on('error', (error) => {
      failure ??= new Error(error.code === 'ENOENT'
        ? `${command} was not found on PATH. Install its CLI and sign in before running this worker.`
        : `Could not start ${command}. Check that its CLI is installed and executable.`);
    });
    const receive = (chunk, keep) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        stop(`${command} exceeded the 2 MiB output limit. Try a smaller task.`);
      } else if (keep && !failure) {
        chunks.push(chunk);
      }
    };
    child.stdout.on('data', (chunk) => receive(chunk, true));
    // Stderr may include source or credentials. Count it, but never return it.
    child.stderr.on('data', (chunk) => receive(chunk, false));
    child.stdin.on('error', (error) => {
      // A CLI that exits early can close stdin while a large prompt is in flight.
      // Its exit status below supplies the actionable failure in that case.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        stop(`Could not send the task to ${command}.`);
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      if (failure) return reject(failure);
      const output = Buffer.concat(chunks).toString('utf8');
      if (code !== 0) {
        if (command === 'claude') {
          let message;
          try {
            message = knownClaudeFailure(JSON.parse(output));
          } catch {
            // Malformed output falls through to the fixed generic error below.
          }
          if (message) return reject(new Error(message));
        }
        return reject(new Error(
          `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}. `
          + 'Check your CLI version, login, model access, and usage limits. Provider logs are not forwarded.',
        ));
      }
      resolve(output);
    });
    child.stdin.end(prompt);
  });
}

export async function runWorker({ provider, model, prompt, timeoutMs = 120_000 }) {
  const { command, args } = buildCommand({ provider, model });
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('A nonempty worker prompt is required.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error('Worker timeout must be a positive integer in milliseconds, up to 2147483647.');
  }
  const cwd = await mkdtemp(join(tmpdir(), 'model-workers-'));
  try {
    // This avoids loading the target repository's agent configuration. Codex's
    // read-only sandbox is NOT filesystem isolation: it may still read host paths.
    // Claude safe mode disables customizations, and --tools '' disables its tools.
    const output = await collectOutput({ command, args, prompt, cwd, timeoutMs });
    return provider === 'codex' ? parseCodexOutput(output) : parseClaudeOutput(output);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
