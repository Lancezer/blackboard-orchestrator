import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTask, relocateTask, setTaskDir, taskDir, writeTask } from '../src/blackboard.mjs';

test('任务黑板搬迁后可通过新旧位置读取，索引不允许目录穿越', async t => {
  const base = await mkdtemp(join(tmpdir(), 'blackboard-storage-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'runtime'), old = join(base, 'project', '.codex-dsh', 'tasks', 'task-1');
  await setTaskDir(root, 'task-1', old);
  await writeTask(root, { id: 'task-1', kind: 'relay', phase: 'WAITING', owner: 'codex', revision: 1, participants: [], documents: {} });
  const destination = join(root, 'tasks', 'task-1');
  await relocateTask(root, 'task-1', destination);
  assert.equal(taskDir(root, 'task-1'), destination);
  assert.equal((await readTask(root, 'task-1')).phase, 'WAITING');
  assert.equal((await lstat(old)).isSymbolicLink(), true);
  assert.match(await readFile(join(old, 'HANDOFF.md'), 'utf8'), /参与会话/);
  assert.throws(() => taskDir(root, '../task-1'), /无效的任务 ID/);
});
