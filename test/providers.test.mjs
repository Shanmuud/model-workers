import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { test } from 'node:test';
import { buildCommand, parseClaudeOutput, parseCodexOutput, runWorker } from '../lib/providers.mjs';

test('provider commands keep models in separate arguments and disable customizations', () => {
  const codex = buildCommand({ provider: 'codex', model: 'test-model' });
  assert.equal(codex.command, 'codex');
  assert.ok(codex.args.includes('--ignore-user-config'));
  assert.ok(codex.args.includes('agents.enabled=false'));
  assert.deepEqual(codex.args.slice(codex.args.indexOf('--sandbox'), codex.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.equal(codex.args.at(-1), '-');
  const claude = buildCommand({ provider: 'claude', model: 'test-model' });
  assert.ok(claude.args.includes('--safe-mode'));
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
  assert.ok(claude.args.includes('--no-session-persistence'));
  const extendedContext = buildCommand({ provider: 'claude', model: 'sonnet[1m]' });
  assert.equal(extendedContext.args[extendedContext.args.indexOf('--model') + 1], 'sonnet[1m]');
  assert.throws(() => buildCommand({ provider: 'other', model: 'test' }), /Unsupported provider/);
  assert.throws(() => buildCommand({ provider: 'codex', model: '--other-flag' }), /model name/);
  assert.throws(() => buildCommand({ provider: 'claude', model: '--dangerously-skip-permissions' }), /model name/);
});

test('worker rejects invalid timeouts and missing prompts before invoking a provider', async () => {
  const options = { provider: 'claude', model: 'test-model', prompt: 'Explain' };
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, 2_147_483_648, '100']) {
    await assert.rejects(runWorker({ ...options, timeoutMs }), /timeout must be/);
  }
  await assert.rejects(runWorker({ ...options, prompt: '   ' }), /nonempty worker prompt/);
});

test('Codex parser returns only the final answer and approved usage numbers', () => {
  const output = [
    { type: 'thread.started', thread_id: 'private-session-id' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Progress message' } },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'PRIVATE SOURCE' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Final findings\n' } },
    { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 20, other: 'private' } },
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(parseCodexOutput(output), {
    text: 'Final findings', usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 20 },
  });
});

test('parsers reject errors, empty answers, malformed and incomplete output without leaking logs', () => {
  for (const output of [
    'PRIVATE SOURCE', 'null', '{}',
    JSON.stringify({ type: 'turn.failed', error: { message: 'PRIVATE SOURCE' } }),
    JSON.stringify({ type: 'error', message: 'PRIVATE SOURCE' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Incomplete' } }),
  ]) {
    assert.throws(() => parseCodexOutput(output), (error) => !error.message.includes('PRIVATE SOURCE'));
  }
  for (const output of [
    'PRIVATE SOURCE', 'null', '[]', '{}',
    JSON.stringify({ is_error: true, result: 'PRIVATE SOURCE' }),
    JSON.stringify({ subtype: 'error_max_turns', result: 'PRIVATE SOURCE' }),
  ]) {
    assert.throws(() => parseClaudeOutput(output), (error) => !error.message.includes('PRIVATE SOURCE'));
  }
});

test('Claude parser extracts result and excludes unrelated metadata', () => {
  assert.deepEqual(parseClaudeOutput(JSON.stringify({
    type: 'result', subtype: 'success', result: ' Findings ', is_error: false,
    session_id: 'private-session-id', usage: { input_tokens: 50, output_tokens: 8, cache_read_input_tokens: 10, private: 'data' },
  })), { text: 'Findings', usage: { input_tokens: 50, output_tokens: 8, cache_read_input_tokens: 10 } });
});

// Fake executables exercise subprocess handling without making any model calls.
// These tests are sequential because their PATH override is process-wide.
test('worker subprocess lifecycle', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'model-workers-test-'));
  const previousPath = process.env.PATH;
  const capture = join(fixture, 'capture.json');
  const executable = join(fixture, 'claude');
  const installFake = async (body) => {
    await writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  };
  process.env.PATH = `${fixture}${delimiter}${previousPath ?? ''}`;
  const options = { provider: 'claude', model: 'test-model', prompt: 'Explain $(touch SHOULD_NOT_EXIST) and `literal backticks`' };
  try {
    await t.test('passes prompt through stdin, isolates cwd, and removes temporary workspace', async () => {
      await installFake(`
        let prompt = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => prompt += chunk);
        process.stdin.on('end', () => {
          require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), prompt, active: process.env.MODEL_WORKERS_ACTIVE }));
          process.stderr.write('PRIVATE DEBUG OUTPUT');
          process.stdout.write(JSON.stringify({ result: 'Only the answer', is_error: false }));
        });
      `);
      assert.deepEqual(await runWorker(options), { text: 'Only the answer' });
      const captured = JSON.parse(await readFile(capture, 'utf8'));
      assert.equal(captured.prompt, options.prompt);
      assert.equal(captured.active, '1');
      assert.notEqual(captured.cwd, process.cwd());
      assert.deepEqual(captured.args, buildCommand(options).args);
      await assert.rejects(access(captured.cwd), { code: 'ENOENT' });
    });

    await t.test('nonzero exits hide provider stderr and handle an early closed stdin', async () => {
      await installFake("process.stderr.write('PRIVATE SOURCE'); process.exit(7);");
      await assert.rejects(runWorker({ ...options, prompt: 'x'.repeat(1024 * 1024) }), (error) => {
        assert.match(error.message, /exited with code 7/);
        assert.doesNotMatch(error.message, /PRIVATE SOURCE/);
        return true;
      });
    });

    await t.test('known Claude credit failure produces a fixed message without exposing provider output', async () => {
      await installFake(`
        process.stdout.write(JSON.stringify({
          is_error: true, terminal_reason: 'api_error', api_error_status: 400,
          result: 'Credit balance is too low', subtype: 'success',
          private_metadata: 'PRIVATE SOURCE',
        }));
        process.stderr.write('PRIVATE LOG OUTPUT');
        process.exitCode = 1;
      `);
      await assert.rejects(runWorker(options), (error) => {
        assert.equal(error.message, 'Claude reports insufficient credit. Check billing for the account used by the Claude CLI.');
        return true;
      });
    });

    await t.test('unknown structured Claude failures do not forward arbitrary result text', async () => {
      await installFake(`
        process.stdout.write(JSON.stringify({
          is_error: true, terminal_reason: 'api_error', api_error_status: 400,
          result: 'Credit balance is too low: PRIVATE SOURCE', subtype: 'success',
        }));
        process.exitCode = 1;
      `);
      await assert.rejects(runWorker(options), (error) => {
        assert.match(error.message, /exited with code 1/);
        assert.doesNotMatch(error.message, /PRIVATE SOURCE/);
        return true;
      });
    });

    await t.test('combined stdout and stderr are bounded', async () => {
      await installFake("process.stdout.write('x'.repeat(1024 * 1024)); process.stderr.write('x'.repeat(1024 * 1024 + 1)); setInterval(() => {}, 1000);");
      await assert.rejects(runWorker(options), /2 MiB output limit/);
    });

    await t.test('timeout stops worker and cleans its temporary workspace', async () => {
      await installFake(`
        require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ cwd: process.cwd() }));
        setInterval(() => {}, 1000);
      `);
      await assert.rejects(runWorker({ ...options, timeoutMs: 300 }), /timed out/);
      const captured = JSON.parse(await readFile(capture, 'utf8'));
      await assert.rejects(access(captured.cwd), { code: 'ENOENT' });
    });

    for (const signal of ['SIGINT', 'SIGTERM']) {
      await t.test(`${signal} kills the worker group and removes listeners and workspace`, async () => {
        await rm(capture, { force: true });
        await installFake(`
          require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
          require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ cwd: process.cwd() }));
          setInterval(() => {}, 1000);
        `);
        const before = process.listenerCount(signal);
        const worker = runWorker({ ...options, timeoutMs: 5000 });
        // Attach the rejection assertion before delivering cancellation.
        const checked = assert.rejects(worker, new RegExp(`interrupted by ${signal}`));
        let captured;
        for (let attempts = 0; attempts < 200; attempts += 1) {
          try {
            captured = JSON.parse(await readFile(capture, 'utf8'));
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        assert.ok(captured, 'fake worker started');
        assert.equal(process.listenerCount(signal), before + 1);
        process.emit(signal);
        await checked;
        assert.equal(process.listenerCount(signal), before);
        // The grandchild inherits stdout, so successful closure also verifies
        // that cancellation stopped descendants holding the output pipe open.
        await assert.rejects(access(captured.cwd), { code: 'ENOENT' });
      });
    }

    await t.test('missing executable yields installation guidance', async () => {
      await rm(executable);
      process.env.PATH = fixture;
      await assert.rejects(runWorker(options), /claude was not found on PATH/);
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(fixture, { recursive: true, force: true });
  }
});
