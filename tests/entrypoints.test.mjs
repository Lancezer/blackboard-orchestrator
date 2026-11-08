import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyDshTools } from '../src/dsh-handoff-tool.mjs';

test('DSH 插件注册同一组交接工具，并能读取当前会话状态', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blackboard-dsh-tools-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousRoot = process.env.BLACKBOARD_DATA;
  process.env.BLACKBOARD_DATA = root;
  try {
    const tools = new Map();
    applyDshTools({ tools: { register(tool) { tools.set(tool.name, tool); } }, workingDirectory: { get() { return root; } } });
    assert.ok(tools.has('delegate_to_codex'));
    assert.ok(tools.has('blackboard_set_permission'));
    const result = await tools.get('blackboard_read').execute({}, { agent: { id: 'dsh-session', session: { header: { cwd: root } } } });
    assert.match(result.message, /尚无交接任务/);
  } finally {
    if (previousRoot === undefined) delete process.env.BLACKBOARD_DATA; else process.env.BLACKBOARD_DATA = previousRoot;
  }
});
