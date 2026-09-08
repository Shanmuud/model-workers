import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CLI = fileURLToPath(new URL('../bin/model-workers.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'workers-cli-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'source.js'), 'const DO_NOT_PRINT_RAW_SOURCE = true;');
  const run = (args = [], env = {}) => spawnSync(process.execPath, [CLI, 'explain', '--repo', root, '--path', 'source.js', '--question', 'Explain this file', ...args], {
    encoding: 'utf8', env: { ...process.env, MODEL_WORKERS_ACTIVE: '', ...env }
  });
  return { root, run };
}

test('dry run is credential-free and prints metadata without source or output files', (t) => {
  const { root, run } = fixture(t);
  const output = path.join(root, 'answer.txt');
  const result = run(['--provider', 'codex', '--model', 'test-model', '--dry-run', '--output', output], { PATH: '' });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.dry_run, true);
  assert.deepEqual(data.files.map((file) => file.path), ['source.js']);
  assert.ok(!result.stdout.includes('DO_NOT_PRINT_RAW_SOURCE'));
  assert.equal(existsSync(output), false);
});

test('offline demo labels simulated output and separates answer from diagnostics', (t) => {
  const { run } = fixture(t);
  const result = run(['--provider', 'demo', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.demo, true);
  assert.match(data.answer, /DEMO ONLY/);
  assert.ok(!data.answer.includes('DO_NOT_PRINT_RAW_SOURCE'));
  assert.match(result.stderr, /source bytes/);
});

test('saving answers never echoes their content or overwrites existing files', (t) => {
  const { root, run } = fixture(t);
  const output = path.join(root, 'answer.txt');
  const result = run(['--provider', 'demo', '--output', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved worker answer/);
  assert.ok(!result.stdout.includes('DEMO ONLY'));
  const original = readFileSync(output, 'utf8');
  assert.match(original, /DEMO ONLY/);
  const again = run(['--provider', 'demo', '--output', output]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /Output already exists/);
  assert.equal(readFileSync(output, 'utf8'), original);
});

test('failed model execution produces no answer or reserved output file', (t) => {
  const { root, run } = fixture(t);
  const output = path.join(root, 'answer.txt');
  const result = run(['--provider', 'codex', '--model', 'test-model', '--output', output], { PATH: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not found on PATH/);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(output), false);
});

test('nested workers and incomplete requests fail before provider execution', (t) => {
  const { run } = fixture(t);
  assert.match(run(['--provider', 'demo'], { MODEL_WORKERS_ACTIVE: '1' }).stderr, /Nested worker/);
  assert.match(run([]).stderr, /Choose --provider/);
  assert.match(run(['--provider', 'demo', '--timeout', '0']).stderr, /--timeout must be/);
});
