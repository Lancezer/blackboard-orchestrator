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
