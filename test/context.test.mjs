import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectContext, buildPrompt } from '../lib/context.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'workers-context-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  return { root, put };
}

test('explicit sources preserve text and line numbers without printing contents', (t) => {
  const { root, put } = fixture(t);
  put('src/a.js', 'const amount = 10;\nexport { amount };\n');
  const context = collectContext({ repo: root, paths: ['src/a.js', './src/a.js'] });
  assert.equal(context.files.length, 1);
  const prompt = buildPrompt('explain', 'What is amount?', context);
  assert.match(prompt, /1: const amount = 10;/);
  assert.match(prompt, /2: export \{ amount \};/);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /do not have the main assistant/);
});

test('explicit file boundaries reject traversal, symlinks, secrets, binary and directories', (t) => {
  const { root, put } = fixture(t);
  put('.env', 'private=value');
  put('binary.dat', Buffer.from([0, 1, 2]));
  put('invalid.txt', Buffer.from([0xff, 0xfe]));
  put('src/ok.js', 'export const ok = true;');
  symlinkSync(path.join(root, 'src/ok.js'), path.join(root, 'link.js'));
  symlinkSync(path.join(root, 'src'), path.join(root, 'linked-directory'));
  for (const file of ['../outside.txt', '/absolute.txt', '.env', 'binary.dat', 'invalid.txt', 'src', 'link.js', 'linked-directory/ok.js']) {
    assert.throws(() => collectContext({ repo: root, paths: [file] }), /Cannot include/);
  }
});

test('explicit source budgets fail instead of silently truncating the requested files', (t) => {
  const { root, put } = fixture(t);
  put('a.js', '12345');
  put('b.js', '67890');
  assert.throws(() => collectContext({ repo: root, paths: ['a.js'], maxBytes: 4 }), /exceeds/);
  assert.throws(() => collectContext({ repo: root, paths: ['a.js', 'b.js'], maxBytes: 7 }), /combined input/);
  assert.throws(() => collectContext({ repo: root, paths: ['a.js', 'b.js'], maxFiles: 1 }), /file count/);
});

test('automatic selection is tracked-only, filters private paths and explains omissions', (t) => {
  const { root, put } = fixture(t);
  put('README.md', 'Overview');
  put('src/payments.js', 'export const retry = true;');
  put('src/other.js', 'unrelated');
  put('.env', 'secret');
  put('node_modules/a.js', 'dependency');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  put('untracked.js', 'must not be sent');
  const context = collectContext({ repo: root, question: 'Explain payments', maxFiles: 2 });
  assert.deepEqual(context.files.map((file) => file.path), ['src/payments.js', 'README.md']);
  assert.equal(context.skipped.length, 3);
  assert.ok(!JSON.stringify(context).includes('must not be sent'));
});

test('automatic selection works when --repo is a subdirectory of a Git repository', (t) => {
  const { root, put } = fixture(t);
  put('src/payments.js', 'payment');
  put('outside.js', 'outside selection');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  const context = collectContext({ repo: path.join(root, 'src') });
  assert.deepEqual(context.files.map((file) => file.path), ['payments.js']);
});

test('non-Git folders need explicit paths; an empty selection is an error', (t) => {
  const { root } = fixture(t);
  assert.throws(() => collectContext({ repo: root }), /requires Git/);
  execFileSync('git', ['init', '-q', root]);
  assert.throws(() => collectContext({ repo: root }), /No eligible files/);
});
