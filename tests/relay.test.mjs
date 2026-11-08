import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite, readTask, taskDir, writeTask } from '../src/blackboard.mjs';
import { git } from '../src/git.mjs';
import { RelayController } from '../src/relay-controller.mjs';

const config = { codex: {}, dsh: {}, limits: { codex_concurrency: 2, dsh_concurrency: 2 }, phase_timeout_minutes: 1 };
async function fixture(t, name = 'repo') {
  const base = await mkdtemp(join(tmpdir(), 'relay-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'runtime'), repo = join(base, name), ignore = join(base, 'ignore');
  await mkdir(root); await mkdir(repo); await writeFile(ignore, '.codex-dsh/\n');
  await git(repo, ['init', '-q']); await git(repo, ['config', 'user.name', 'Test']); await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await git(repo, ['config', 'core.excludesfile', ignore]);
  await writeFile(join(repo, 'base.txt'), 'base\n'); await git(repo, ['add', 'base.txt']); await git(repo, ['commit', '-qm', 'base']);
  return { base, root, repo, ignore };
}
async function request(root, controller, input, content = '执行本次任务') {
  const id = randomUUID(); await atomicWrite(join(root, 'pending', `${id}.md`), content);
  return await controller.delegate({ pendingId: id, changesCode: false, ...input });
}
async function done(controller, root, id) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const task = await readTask(root, id);
    if (['DONE', 'BLOCKED', 'PAUSED'].includes(task.phase) && !controller.loops.has(id)) return task;
    await delay(40);
  }
  throw new Error('交接超时');
}
function clients(root, repo) {
  const starts = [], codexSteps = [], dshSteps = [], dshCwds = new Map([['dsh-A', repo]]), updates = [];
  let profile = ':workspace', codexCount = 0, dshCount = 0;
  const codex = {
    async createRelay(cwd) { codexCount++; return { thread: { id: `codex-${String.fromCharCode(65 + codexCount)}` }, model: 'fake' }; },
    async resume(id) { return { cwd: repo, model: 'fake', sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request', activePermissionProfile: { id: profile } }; },
    async request(method, params) {
      if (method === 'permissionProfile/list') return { data: [{ id: ':workspace', allowed: true }, { id: ':full', allowed: true }], nextCursor: null };
      if (method === 'thread/settings/update') { updates.push(params); if (params.permissions) profile = params.permissions; return {}; }
      if (method === 'model/list') return { data: [{ id: 'fake', model: 'fake', isDefault: true, supportedReasoningEfforts: [] }], nextCursor: null };
      throw new Error(method);
    },
    async state() { return { type: 'idle' }; }, async queue() { return []; }, async terminals() { return []; },
    async startRelay(task, target) { starts.push(`codex:${target.id}`); return { id: `turn-${starts.length}`, taskId: task.id }; },
    async wait() { const step = codexSteps.shift(); if (step) await step(); return { status: 'completed' }; },
    takeFinal() { return 'Codex 已完成当前工作。'; }, async interrupt() {}
  };
  const dsh = {
    async call(op, args) {
      if (op === 'create') { const id = `dsh-${String.fromCharCode(67 + dshCount++)}`; dshCwds.set(id, args.cwd); return { sessionId: id, model: {} }; }
      if (op === 'prompt') { starts.push(`dsh:${args.sessionId}`); return {}; }
      if (op === 'catalog') return { groups: [], failures: [] };
      throw new Error(op);
    },
    async state() { return { running: false, queue: [], pendingInput: [], jobs: [] }; },
    async inspect(id) { return { cwd: dshCwds.get(id), sandboxCwd: dshCwds.get(id), model: {} }; },
    async resume() {}, async cancel() {},
    async wait(task) {
      const state = await readTask(root, task.id), doc = `result-${String(state.activeHop.revision).padStart(3, '0')}-dsh.md`;
      const step = dshSteps.shift(); if (step) await step();
      await atomicWrite(join(taskDir(root, task.id), doc), 'DSH 已完成当前工作。\n');
      return { observed: { finalDocument: doc } };
    }
  };
  return { codex, dsh, starts, codexSteps, dshSteps, updates, getProfile: () => profile };
}

test('按 Agent 请求完成四次交接，精确回到指定会话', async t => {
  const { root, repo } = await fixture(t), f = clients(root, repo);
  const controller = new RelayController(root, config, async () => f.codex, f.dsh);
  let taskId;
  f.codexSteps.push(async () => request(root, controller, { taskId, sourceRole: 'codex', sourceId: 'codex-B', sourceCwd: repo, targetCwd: repo, newSession: true }));
  f.dshSteps.push(async () => request(root, controller, { taskId, sourceRole: 'dsh', sourceId: 'dsh-C', sourceCwd: repo, targetCwd: repo, targetId: 'codex-B' }));
  f.codexSteps.push(async () => request(root, controller, { taskId, sourceRole: 'codex', sourceId: 'codex-B', sourceCwd: repo, targetCwd: repo, targetId: 'dsh-A' }));
  taskId = (await request(root, controller, { sourceRole: 'dsh', sourceId: 'dsh-A', sourceCwd: repo, targetCwd: repo, newSession: true })).id;
  const task = await done(controller, root, taskId);
  assert.equal(task.phase, 'DONE');
  assert.deepEqual(f.starts, ['codex:codex-B', 'dsh:dsh-C', 'codex:codex-B', 'dsh:dsh-A']);
  assert.equal(task.participants.length, 3);
  assert.match(await readFile(join(taskDir(root, taskId), task.documents.result), 'utf8'), /DSH 已完成/);
});

test('只请求一次交接时不自动唤醒源会话', async t => {
  const { root, repo } = await fixture(t), f = clients(root, repo);
  const controller = new RelayController(root, config, async () => f.codex, f.dsh);
  const { id } = await request(root, controller, { sourceRole: 'codex', sourceId: 'codex-source', sourceCwd: repo, targetCwd: repo });
  const task = await done(controller, root, id);
  assert.equal(task.phase, 'DONE'); assert.deepEqual(f.starts, ['dsh:dsh-C']);
  assert.match(taskDir(root, id), /\.codex-dsh\/tasks\//);
});

test('代码交接要求批准和干净工作区，不替用户提交', async t => {
  const { root, repo } = await fixture(t), f = clients(root, repo);
  const controller = new RelayController(root, config, async () => f.codex, f.dsh);
  const input = { sourceRole: 'codex', sourceId: 'codex-source', sourceCwd: repo, targetCwd: repo, changesCode: true };
  await assert.rejects(request(root, controller, input), /批准/);
  await writeFile(join(repo, 'personal.txt'), 'user\n');
  await assert.rejects(request(root, controller, { ...input, planApproved: true }), /未提交或未跟踪/);
  assert.equal(await readFile(join(repo, 'personal.txt'), 'utf8'), 'user\n');
  assert.match(await git(repo, ['status', '--porcelain']), /personal\.txt/);
});

test('源会话停稳后再次检查工作区，不启动目标会话', async t => {
  const { root, repo } = await fixture(t), f = clients(root, repo);
  const controller = new RelayController(root, config, async () => f.codex, f.dsh);
  const { id } = await request(root, controller, { sourceRole: 'codex', sourceId: 'codex-source', sourceCwd: repo, targetCwd: repo, changesCode: true, planApproved: true, deferStart: true });
  await writeFile(join(repo, 'late.txt'), 'late change\n');
  controller.run(id);
  const task = await done(controller, root, id);
  assert.equal(task.phase, 'BLOCKED');
  assert.match(task.message, /未提交或未跟踪/);
  assert.deepEqual(f.starts, []);
  assert.equal(await readFile(join(repo, 'late.txt'), 'utf8'), 'late change\n');
});

test('重启只阻断未完成的交接，明确重试后才重新调度', async t => {
  const { root } = await fixture(t);
  const hop = { revision: 1, fromRole: 'codex', fromId: 'source' };
  await writeTask(root, { id: 'interrupted', kind: 'relay', phase: 'RUNNING', owner: 'dsh', ownerId: 'target', revision: 1, participants: [], documents: {}, activeHop: hop });
  const controller = new RelayController(root, config, async () => ({}), {}), started = [];
  controller.run = id => started.push(id);
  await controller.recoverOnStartup();
  assert.equal((await readTask(root, 'interrupted')).phase, 'BLOCKED');
  assert.deepEqual(started, []);
  await assert.rejects(controller.resume('interrupted'), /--retry/);
  await controller.resume('interrupted', true);
  const task = await readTask(root, 'interrupted');
  assert.equal(task.phase, 'WAITING');
  assert.deepEqual(task.pending, hop);
  assert.equal(task.activeHop, null);
  assert.deepEqual(started, ['interrupted']);
});

test('获批扩展项目后迁移交接材料并保留旧路径', async t => {
  const { base, root, repo, ignore } = await fixture(t), f = clients(root, repo), other = join(base, 'other');
  await mkdir(other); await git(other, ['init', '-q']); await git(other, ['config', 'user.name', 'Test']); await git(other, ['config', 'user.email', 'test@example.invalid']);
  await git(other, ['config', 'core.excludesfile', ignore]); await writeFile(join(other, 'base.txt'), 'other\n'); await git(other, ['add', 'base.txt']); await git(other, ['commit', '-qm', 'base']);
  const controller = new RelayController(root, config, async () => f.codex, f.dsh); let taskId;
  f.codexSteps.push(async () => request(root, controller, { taskId, sourceRole: 'codex', sourceId: 'codex-B', sourceCwd: repo, targetCwd: other, projects: [other], scopeApproved: true, newSession: true }));
  taskId = (await request(root, controller, { sourceRole: 'dsh', sourceId: 'dsh-A', sourceCwd: repo, targetCwd: repo, newSession: true })).id;
  const old = join(repo, '.codex-dsh', 'tasks', taskId), task = await done(controller, root, taskId);
  assert.equal(task.phase, 'DONE'); assert.equal(taskDir(root, taskId), join(root, 'tasks', taskId));
  assert.equal((await lstat(old)).isSymbolicLink(), true); assert.match(await readFile(join(old, 'HANDOFF.md'), 'utf8'), /参与会话/);
});

test('Codex 临时权限在同一线程下一回合生效，结束后恢复', async t => {
  const { root, repo } = await fixture(t), f = clients(root, repo);
  const controller = new RelayController(root, config, async () => f.codex, f.dsh); let taskId;
  f.codexSteps.push(async () => {
    const continuationId = randomUUID(); await atomicWrite(join(root, 'pending', `${continuationId}.md`), '继续完成已批准的工作。');
    await controller.setPermission({ taskId, sourceRole: 'codex', sourceId: 'codex-B', sourceCwd: repo, role: 'codex', sessionId: 'codex-B', profile: ':full', persistent: false, continuationId });
    assert.equal(f.getProfile(), ':full');
  });
  taskId = (await request(root, controller, { sourceRole: 'dsh', sourceId: 'dsh-A', sourceCwd: repo, targetCwd: repo, newSession: true })).id;
  const task = await done(controller, root, taskId);
  assert.equal(task.phase, 'DONE'); assert.deepEqual(f.starts, ['codex:codex-B', 'codex:codex-B']);
  assert.deepEqual(f.updates.map(x => x.permissions), [':full', ':workspace']); assert.equal(f.getProfile(), ':workspace');
});

test('空闲会话调整临时权限后接续时，先保存原权限再启动回合', async t => {
  const { root, repo } = await fixture(t), f = clients(root, repo);
  const controller = new RelayController(root, config, async () => f.codex, f.dsh);
  const continuationId = randomUUID();
  await atomicWrite(join(root, 'pending', `${continuationId}.md`), '在当前会话继续工作。');
  const result = await controller.setPermission({ sourceRole: 'codex', sourceId: 'codex-existing', sourceCwd: repo,
    role: 'codex', sessionId: 'codex-existing', profile: ':full', persistent: false, continuationId });
  const id = result.message.match(/任务 ID：(task-[a-z0-9-]+)/)?.[1];
  assert.ok(id);
  const task = await done(controller, root, id);
  assert.equal(task.phase, 'DONE');
  assert.deepEqual(f.starts, ['codex:codex-existing']);
  assert.deepEqual(f.updates.map(x => x.permissions), [':full', ':workspace']);
  assert.equal(f.getProfile(), ':workspace');
});

test('恢复任务模型时保留用户中途切换，并能恢复原来的默认推理强度', async () => {
  const calls = [];
  const dsh = {
    async inspect(id) { return { model: id === 'changed' ? { provider: 'other', model: 'manual' } : { provider: 'p', model: 'm', reasoningEffort: 'high' } }; },
    async call(op, params) { calls.push({ op, ...params }); }
  };
  const controller = new RelayController('/unused', config, async () => ({}), dsh);
  await controller.restoreModels({ message: '', modelChanges: [
    { id: 'unchanged', previous: { provider: 'p', model: 'm' }, selected: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
    { id: 'changed', previous: { provider: 'p', model: 'm' }, selected: { provider: 'p', model: 'm', reasoningEffort: 'high' } }
  ] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'unchanged');
  assert.equal(calls[0].model.reset_reasoning, true);
});
