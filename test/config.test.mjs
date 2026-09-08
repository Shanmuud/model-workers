import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveWorker, positiveInteger } from '../lib/config.mjs';

test('role configuration selects the model and explicit flags override it', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'workers-config-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'workers.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, workers: { explain: { provider: 'claude', model: 'test-model' } } }));
  assert.deepEqual(resolveWorker({ role: 'explain', configPath }), { provider: 'claude', model: 'test-model' });
  assert.deepEqual(resolveWorker({ role: 'explain', configPath, provider: 'codex', model: 'another-model' }), { provider: 'codex', model: 'another-model' });
  assert.throws(() => resolveWorker({ role: 'review', configPath }), /no worker/);
  writeFileSync(configPath, 'not json');
  assert.throws(() => resolveWorker({ role: 'explain', configPath }), /Cannot read routing config/);
});

test('missing routes, placeholders, invalid model arguments and invalid limits fail clearly', () => {
  assert.throws(() => resolveWorker({ role: 'explain' }), /Choose --provider/);
  assert.throws(() => resolveWorker({ role: 'unknown' }), /Unknown role/);
  assert.throws(() => resolveWorker({ role: 'explain', provider: 'claude', model: 'YOUR_MODEL' }), /placeholder/);
  for (const model of ['--dangerous', 'model; echo oops', 'model\nnext', '']) {
    assert.throws(() => resolveWorker({ role: 'explain', provider: 'claude', model }), /valid --model/);
  }
  for (const value of ['0', '-1', '1.5', 'NaN', '1001']) {
    assert.throws(() => positiveInteger(value, '--limit', 10, 1000), /must be/);
  }
  assert.equal(positiveInteger(undefined, '--limit', 10, 1000), 10);
  assert.equal(resolveWorker({ role: 'draft', provider: 'demo' }).provider, 'demo');
  assert.equal(resolveWorker({ role: 'explain', provider: 'claude', model: 'sonnet[1m]' }).model, 'sonnet[1m]');
});
