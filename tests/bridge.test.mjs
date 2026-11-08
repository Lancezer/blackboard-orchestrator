import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTaskDir, writeTask } from '../src/blackboard.mjs';
import { CodexClient } from '../src/codex.mjs';
import { DshClient } from '../src/dsh.mjs';
import { apply as applyDshBridge } from '../src/dsh-plugin.mjs';
import { bridgeCall } from '../src/ipc.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'blackboard-bridge-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('DSH 待处理输入写入当前交接黑板，状态信号不携带正文', async t => {
  const root = await fixture(t);
  await writeTask(root, { id: 'queue-dsh', kind: 'relay', phase: 'WAITING', owner: 'dsh', ownerId: 'session-dsh', revision: 1, participants: [], documents: {} });
  const previousRoot = process.env.BLACKBOARD_DATA;
  process.env.BLACKBOARD_DATA = root;
  let dispose;
  const ctx = {
    sessionController: { async state() { return { cursor: 1, active: true, running: true, pendingInput: [], queue: [{ id: 'pending-123', placement: 'queued', content: [{ type: 'text', text: '保留 DSH 补充' }] }] }; } },
    jobs: { list() { return []; } }, effect(init) { dispose = init(); }
  };
  applyDshBridge(ctx);
  try {
    const state = await bridgeCall(root, 'state', { sessionId: 'session-dsh' }, 5000);
    assert.equal(state.queue.length, 1);
    assert.doesNotMatch(JSON.stringify(state), /保留 DSH 补充/);
    assert.match(await readFile(join(root, 'tasks', 'queue-dsh', 'input-dsh-queue-pending-123.md'), 'utf8'), /保留 DSH 补充/);
  } finally {
    dispose();
    if (previousRoot === undefined) delete process.env.BLACKBOARD_DATA; else process.env.BLACKBOARD_DATA = previousRoot;
  }
});

test('Codex 人工输入写入当前交接黑板，工具请求由原生客户端处理', async t => {
  const root = await fixture(t), taskDir = join(root, 'project', '.codex-dsh', 'tasks', 'task-codex');
  await setTaskDir(root, 'task-codex', taskDir);
  await writeTask(root, { id: 'task-codex', kind: 'relay', phase: 'RUNNING', owner: 'codex', ownerId: 'thread-c', revision: 1, participants: [], documents: {} });
  const client = new CodexClient('unused', root), external = [];
  client.on('external-tool', value => external.push(value));
  const input = (id, text) => ({ method: 'item/started', params: { threadId: 'thread-c', item: { id, type: 'userMessage', content: [{ type: 'text', text }] } } });
  await client.receive(input('auto', '交接任务 ID：task-codex。请读取 路径 和 instruction。'));
  await assert.rejects(readFile(join(taskDir, 'input-codex-auto.md')), { code: 'ENOENT' });
  await client.receive(input('user', '补充需求'));
  assert.match(await readFile(join(taskDir, 'input-codex-user.md'), 'utf8'), /补充需求/);
  await client.receive({ id: 1, method: 'item/tool/call', params: { threadId: 'thread-c', tool: 'external_tool' } });
  assert.deepEqual(external, [{ threadId: 'thread-c', tool: 'external_tool' }]);
});

test('DSH 启动后提前失败会立即报告原因', async () => {
  const client = new DshClient('/unused');
  client.state = async () => ({ running: false, queue: [], pendingInput: [], jobs: [], observed: { matchedTurn: null, ends: [{ reason: { kind: 'error', error: { message: 'test credential unavailable' } } }] } });
  await assert.rejects(client.wait({ id: 'broken', dshSessionId: 's' }, Date.now() + 30000), /test credential unavailable/);
});
