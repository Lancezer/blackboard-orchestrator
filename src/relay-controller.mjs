import { mkdir, readFile, rm } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite, listTasks, readTask, relocateTask, setTaskDir, taskDir, writeTask } from './blackboard.mjs';
import { git } from './git.mjs';

async function project(cwd, requireGit = false) {
  const path = await realpath(resolve(cwd));
  try {
    const top = await git(path, ['rev-parse', '--show-toplevel']);
    const common = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return { path: top, identity: await realpath(common), git: true };
  } catch (error) {
    if (requireGit) throw new Error(`代码任务需要 Git 工作区：${path}`);
    return { path, identity: path, git: false };
  }
}

async function clean(cwd) {
  await project(cwd, true);
  const status = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) throw new Error(`工作区有未提交或未跟踪的内容：${cwd}\n${status}`);
}

function participant(role, id, cwd, transport = undefined) {
  return { role, id, cwd: resolve(cwd), ...(transport ? { transport } : {}) };
}

export class RelayController {
  constructor(root, config, getDaemon, dsh, gates = null) {
    this.root = root; this.config = config; this.getDaemon = getDaemon; this.dsh = dsh; this.gates = gates;
    this.loops = new Map(); this.active = new Map(); this.paused = new Set();
  }

  async findTask(id, role, sessionId) {
    if (id) {
      const task = await readTask(this.root, id);
      if (task.kind !== 'relay') throw new Error('此任务不属于会话交接流程');
      if (!task.participants.some(p => p.role === role && p.id === sessionId)) throw new Error('当前会话不属于该任务');
      return task;
    }
    const matches = (await listTasks(this.root)).filter(t => t.kind === 'relay' && ['RUNNING', 'WAITING'].includes(t.phase) && t.participants?.some(p => p.role === role && p.id === sessionId));
    if (matches.length > 1) throw new Error('当前会话有多个任务，请指定任务 ID');
    return matches[0] ?? null;
  }

  async delegate(input) {
    const { sourceRole, sourceId, pendingId } = input;
    if (!['codex', 'dsh'].includes(sourceRole) || !sourceId) throw new Error('缺少发起会话身份');
    if (!/^[a-f0-9-]{20,}$/i.test(pendingId ?? '')) throw new Error('交接请求 ID 无效');
    const sourceCwd = resolve(input.sourceCwd), targetCwd = resolve(input.targetCwd ?? input.sourceCwd);
    const targetRole = input.targetRole ?? (sourceRole === 'codex' ? 'dsh' : 'codex');
    if (!['codex', 'dsh'].includes(targetRole)) throw new Error('目标端无效');
    const content = await readFile(join(this.root, 'pending', `${pendingId}.md`), 'utf8');
    if (!content.trim()) throw new Error('交接要求不能为空');
    let task = input.newTask ? null : await this.findTask(input.taskId, sourceRole, sourceId);
    if (task?.pending) throw new Error('本任务已有待处理的交接');
    if (task && ['PAUSED', 'BLOCKED'].includes(task.phase)) throw new Error('任务已暂停或阻断，请先处理');
    if (task && task.phase === 'RUNNING' && (task.owner !== sourceRole || task.ownerId !== sourceId)) throw new Error('当前不是本任务的活跃会话');
    const codeTask = !!(input.codeTask || input.changesCode || task?.changesCode);
    if (input.changesCode && !(input.planApproved || task?.planApproved)) throw new Error('修改代码前请先取得用户对计划的明确批准');
    if (input.targetPermission && !input.permissionConfirmed) throw new Error('调整目标会话权限前需要用户明确同意');
    if (codeTask && !input.continuation) { await clean(sourceCwd); if (sourceCwd !== targetCwd) await clean(targetCwd); }
    if (codeTask && !input.continuation) {
      const sourceRoot = (await project(sourceCwd, true)).path, targetRoot = (await project(targetCwd, true)).path;
      for (const other of await listTasks(this.root)) {
        if (other.kind !== 'relay' || other.id === task?.id || !other.changesCode || !['RUNNING', 'WAITING'].includes(other.phase)) continue;
        const used = other.worktree ?? other.pending?.targetCwd;
        if (used && [sourceRoot, targetRoot].includes((await project(used, true)).path)) throw new Error(`该工作区正被任务 ${other.id} 使用，请为并发任务使用独立 worktree`);
      }
    }
    const projects = [];
    for (const path of input.projects?.length ? input.projects : task ? (input.changesCode ? [targetCwd] : []) : [targetCwd]) {
      const item = await project(path, codeTask);
      if (!projects.some(p => p.identity === item.identity)) projects.push(item);
    }
    if (!task) {
      const id = `task-${randomUUID().slice(0, 12)}`;
      const location = projects.length === 1 ? join(projects[0].path, '.codex-dsh', 'tasks', id) : join(this.root, 'tasks', id);
      // Do not create an unignored task directory inside a Git worktree.
      if (projects.length === 1 && projects[0].git) {
        try { await git(projects[0].path, ['check-ignore', '-q', '.codex-dsh/']); }
        catch { throw new Error('交接目录尚未加入用户级 Git 忽略规则，请运行 setup'); }
      }
      await mkdir(location, { recursive: true, mode: 0o700 });
      await setTaskDir(this.root, id, location);
      task = { id, kind: 'relay', phase: 'WAITING', owner: sourceRole, ownerId: sourceId, revision: 0,
        participants: [participant(sourceRole, sourceId, sourceCwd, sourceRole === 'codex' ? 'daemon' : undefined)],
        projects, changesCode: codeTask, planApproved: !!input.planApproved, documents: {}, permissionChanges: [],
        createdAt: new Date().toISOString() };
    } else {
      const newProjects = projects.filter(p => !task.projects.some(old => old.identity === p.identity));
      if (newProjects.length && task.projects.length && !input.scopeApproved) throw new Error('任务涉及新项目，请先取得用户对范围变更的批准');
      if (newProjects.length) {
        task.projects.push(...newProjects);
      }
      task.changesCode ||= codeTask;
      task.planApproved ||= !!input.planApproved;
    }
    const revision = ++task.revision;
    const doc = `instruction-${String(revision).padStart(3, '0')}.md`;
    await atomicWrite(join(taskDir(this.root, task.id), doc), `# 第 ${revision} 次交接\n\n${content.trim()}\n`);
    task.documents.instruction = doc;
    task.pending = { revision, fromRole: sourceRole, fromId: sourceId, fromCwd: sourceCwd, targetRole,
      targetId: input.newSession ? null : input.targetId ?? null, newSession: !!input.newSession, targetCwd,
      overrides: input.overrides ?? {}, projects: task.projects.map(p => p.path), continuation: !!input.continuation,
      targetPermission: input.targetPermission ?? null, permissionPersistent: !!input.permissionPersistent };
    task.phase = 'WAITING'; task.message = '交接已登记，等待发起会话结束当前回合。';
    await writeTask(this.root, task); await rm(join(this.root, 'pending', `${pendingId}.md`), { force: true });
    if (!input.deferStart) this.run(task.id);
    return { id: task.id, handoff: join(taskDir(this.root, task.id), 'HANDOFF.md'), message: '已登记交接，请结束当前回合；后续路径由任务要求决定。' };
  }

  run(id) {
    if (this.loops.has(id)) return;
    const loop = this.runLoop(id).catch(async error => {
      const task = await readTask(this.root, id).catch(() => null);
      if (task) { task.phase = this.paused.has(id) ? 'PAUSED' : 'BLOCKED'; task.message = error.message; await writeTask(this.root, task); }
      console.error(`[${id}] ${error.message}`);
    }).finally(() => { this.loops.delete(id); this.active.delete(id); });
    this.loops.set(id, loop);
  }

  async quiet(role, id) {
    if (role === 'dsh') {
      let state = await this.dsh.state(id);
      if (state.queue === null) { await this.dsh.resume(id); state = await this.dsh.state(id); }
      if (state.running || state.queue === null || state.queue.length || state.pendingInput.length || state.jobs.some(j => ['running', 'stopping'].includes(j.status))) throw new Error('DSH 会话仍在工作或等待输入');
    } else {
      const client = await this.getDaemon();
      let state = await client.state(id);
      if (state.type === 'notLoaded') { await client.resume(id); state = await client.state(id); }
      if (state.type !== 'idle' || (await client.queue(id)).length || (await client.terminals(id)).length) throw new Error('Codex 会话仍在工作、排队或有后台终端');
    }
  }
  async waitQuiet(role, id, deadline, taskId) {
    let error;
    while (Date.now() < deadline) {
      if (this.paused.has(taskId)) throw new Error('任务已暂停');
      try { await this.quiet(role, id); await delay(400); await this.quiet(role, id); return; }
      catch (e) { error = e; await delay(400); }
    }
    throw new Error(`等待 ${role} 停稳超时：${error?.message ?? '未知状态'}`);
  }

  async target(task, hop) {
    let chosen = hop.targetId && task.participants.find(p => p.role === hop.targetRole && p.id === hop.targetId);
    if (!chosen && hop.targetId) chosen = participant(hop.targetRole, hop.targetId, hop.targetCwd, hop.targetRole === 'codex' ? 'daemon' : undefined);
    if (!chosen && !hop.newSession) chosen = [...task.participants].reverse().find(p => p.role === hop.targetRole && p.cwd === hop.targetCwd);
    if (chosen) {
      if (chosen.role === 'dsh') {
        const info = await this.dsh.inspect(chosen.id);
        const sandbox = resolve(info.sandboxCwd ?? info.cwd);
        if (sandbox !== hop.targetCwd && !hop.targetCwd.startsWith(sandbox + '/')) throw new Error('指定 DSH 会话的原生工作区不匹配，请新建会话或调整原生权限');
      } else {
        const client = await this.getDaemon();
        await client.resume(chosen.id);
      }
      chosen.cwd = hop.targetCwd;
      if (!task.participants.some(p => p.role === chosen.role && p.id === chosen.id)) task.participants.push(chosen);
      return chosen;
    }
    if (hop.targetRole === 'dsh') {
      const created = await this.dsh.call('create', { taskId: task.id, cwd: hop.targetCwd }, 30000);
      chosen = participant('dsh', created.sessionId, hop.targetCwd);
    } else {
      const client = await this.getDaemon();
      const settings = { ...this.config.codex, ...hop.overrides.codex };
      const created = await client.createRelay(hop.targetCwd, settings);
      chosen = participant('codex', created.thread.id, hop.targetCwd, 'daemon');
      this.openTerminal(chosen, task.id);
    }
    task.participants.push(chosen);
    return chosen;
  }

  openTerminal(target, taskId) {
    const terminal = this.config.terminal ?? 'konsole';
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log(`[${taskId}] 手动打开：codex resume ${target.id}`); return; }
    const started = Date.now();
    const child = spawn(terminal, ['-e', 'codex', 'resume', target.id], { cwd: target.cwd, detached: true, stdio: 'ignore' });
    child.once('error', () => console.error(`[${taskId}] 无法打开终端，请运行 codex resume ${target.id}`));
    child.once('exit', code => { if (code && Date.now() - started < 3000) console.error(`[${taskId}] 终端启动失败，请运行 codex resume ${target.id}`); });
    child.unref();
  }

  async runLoop(id) {
    while (true) {
      let task = await readTask(this.root, id);
      const hop = task.pending;
      if (!hop || this.paused.has(id)) return;
      const deadline = Date.now() + (this.config.phase_timeout_minutes ?? 45) * 60000;
      await this.waitQuiet(hop.fromRole, hop.fromId, deadline, id);
      task = await readTask(this.root, id);
      if (!task.pending || task.pending.revision !== hop.revision) throw new Error('交接状态已改变，请检查任务后恢复');
      if (task.changesCode && !hop.continuation) { await clean(hop.fromCwd); if (hop.targetCwd !== hop.fromCwd) await clean(hop.targetCwd); }
      if (task.projects.length > 1 && taskDir(this.root, id) !== join(this.root, 'tasks', id)) await relocateTask(this.root, id, join(this.root, 'tasks', id));
      const target = await this.target(task, hop);
      await this.waitQuiet(target.role, target.id, deadline, id);
      if (hop.targetPermission) {
        await writeTask(this.root, task);
        await this.setPermission({ sourceRole: hop.fromRole, sourceId: hop.fromId, sourceCwd: hop.fromCwd, taskId: id,
          role: target.role, sessionId: target.id, profile: hop.targetPermission, persistent: hop.permissionPersistent });
        task = await readTask(this.root, id);
      }
      task.pending = null; task.owner = target.role; task.ownerId = target.id; task.phase = 'RUNNING';
      task.activeHop = { ...hop, targetId: target.id, newSession: false };
      task.worktree = target.cwd; task.message = `${target.role} 正在处理本次交接。`;
      if (target.role === 'codex') { task.codexThreadId = target.id; task.codexTransport = target.transport; }
      else task.dshSessionId = target.id;
      await writeTask(this.root, task);
      this.active.set(id, target);
      let final, finalDocument;
      const release = this.gates?.[target.role] ? await this.gates[target.role].acquire(() => this.paused.has(id)) : () => {};
      try {
        if (target.role === 'codex') {
          const client = await this.getDaemon();
          const turn = await client.startRelay(task, target, { ...this.config.codex, ...hop.overrides.codex });
          this.active.set(id, { ...target, turnId: turn.id });
          const done = await client.wait(turn.id, deadline, () => this.paused.has(id));
          if (done.status !== 'completed') throw new Error(`Codex 回合结束：${done.status}`);
          final = client.takeFinal(turn.id);
        } else {
          const requested = { ...this.config.dsh, ...hop.overrides.dsh };
          if (Object.values(requested).some(Boolean)) {
            const before = (await this.dsh.inspect(target.id)).model;
            const after = (await this.dsh.call('model', { sessionId: target.id, model: requested })).model;
            task.modelChanges ??= [];
            const change = task.modelChanges.find(item => item.id === target.id);
            if (change) change.selected = after; else task.modelChanges.push({ id: target.id, previous: before, selected: after });
            await writeTask(this.root, task);
          }
          await this.dsh.call('prompt', { taskId: id, sessionId: target.id });
          const result = await this.dsh.wait({ id, dshSessionId: target.id }, deadline, () => this.paused.has(id));
          finalDocument = result?.observed?.finalDocument;
        }
        await this.waitQuiet(target.role, target.id, deadline, id);
      } finally { release(); }
      task = await readTask(this.root, id);
      if (final) {
        const name = `result-${String(hop.revision).padStart(3, '0')}.md`;
        await atomicWrite(join(taskDir(this.root, id), name), final.trim() + '\n');
        task.documents.result = name;
      }
      if (finalDocument) task.documents.result = finalDocument;
      task.activeHop = null;
      if (task.pending) { await writeTask(this.root, task); continue; }
      if (!final && finalDocument) final = await readFile(join(taskDir(this.root, id), finalDocument), 'utf8');
      if (final && /EADDRINUSE|address already in use|database is locked|deadlock detected|CUDA out of memory/i.test(final) && /error|failed|failure|冲突|失败|无法|占用|不足/i.test(final)) {
        task.phase = 'BLOCKED'; task.message = '结果提示可能存在共享资源争用，请查看原会话并人工处理。'; await writeTask(this.root, task); return;
      }
      task.phase = 'DONE'; task.owner = target.role; task.ownerId = target.id; task.message = '本次工作已结束；没有自动唤醒其他会话。';
      await this.restorePermissions(task);
      await this.restoreModels(task);
      await writeTask(this.root, task); return;
    }
  }

  async sessions(taskId, role, sessionId) {
    const task = await this.findTask(taskId, role, sessionId);
    if (!task) return { task: null, participants: [] };
    return { task: task.id, phase: task.phase, handoff: join(taskDir(this.root, task.id), 'HANDOFF.md'), participants: task.participants };
  }

  async options({ sourceRole, sourceId, sourceCwd, taskId, role, sessionId }) {
    if (role !== sourceRole && sessionId === sourceId) throw new Error('查看另一端权限时请指定其会话 ID');
    const task = await this.findTask(taskId, sourceRole, sourceId);
    if (role !== sourceRole || sessionId !== sourceId) {
      if (!task?.participants.some(p => p.role === role && p.id === sessionId)) throw new Error('指定会话不属于当前任务');
    }
    const client = await this.getDaemon();
    const models = []; let cursor = null;
    do {
      const page = await client.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      models.push(...page.data.map(m => ({ id: m.model, default: m.isDefault, efforts: m.supportedReasoningEfforts.map(e => e.reasoningEffort) })));
      cursor = page.nextCursor;
    } while (cursor);
    const dshModels = await this.dsh.call('catalog', {}, 30000);
    let permission;
    if (role === 'dsh') permission = await this.dsh.call('permissions-current', { sessionId });
    else {
      const current = await client.resume(sessionId), profiles = []; cursor = null;
      do {
        const page = await client.request('permissionProfile/list', { cwd: current.cwd ?? sourceCwd, limit: 100, ...(cursor ? { cursor } : {}) });
        profiles.push(...page.data); cursor = page.nextCursor;
      } while (cursor);
      permission = { current: current.activePermissionProfile, approvalPolicy: current.approvalPolicy, profiles };
    }
    return { codexModels: models, dshModels, permission };
  }

  async setPermission(input) {
    const { sourceRole, sourceId, sourceCwd, role, sessionId, profile, persistent, continuationId } = input;
    if (typeof profile !== 'string' || !profile.trim()) throw new Error('需要指定原生权限预设');
    if (role !== sourceRole && sessionId === sourceId) throw new Error('修改另一端权限时请指定其会话 ID');
    let task = await this.findTask(input.taskId, sourceRole, sourceId);
    if ((role !== sourceRole || sessionId !== sourceId) && !task?.participants.some(p => p.role === role && p.id === sessionId)) throw new Error('指定会话不属于当前任务');
    if (!task && !persistent && !continuationId) throw new Error('临时权限需要关联任务；单独修改时请明确要求持续生效');
    if (continuationId && (role !== 'codex' || sourceRole !== 'codex' || sessionId !== sourceId)) throw new Error('自动接续仅适用于当前 Codex 会话');
    let change;
    if (role === 'dsh') {
      const current = await this.dsh.call('permissions-current', { sessionId });
      await this.dsh.call('permissions-set', { sessionId, preset: profile });
      change = { role, id: sessionId, previous: current.current, selected: profile, persistent };
    } else {
      const client = await this.getDaemon(), current = await client.resume(sessionId);
      const profiles = []; let cursor = null;
      do { const page = await client.request('permissionProfile/list', { cwd: current.cwd ?? sourceCwd, limit: 100, ...(cursor ? { cursor } : {}) }); profiles.push(...page.data); cursor = page.nextCursor; } while (cursor);
      if (!profiles.some(p => p.id === profile && p.allowed)) throw new Error(`当前 Codex 会话不能选择权限预设 ${profile}`);
      await client.request('thread/settings/update', { threadId: sessionId, permissions: profile });
      change = { role, id: sessionId, previous: current.activePermissionProfile?.id ?? null, sandbox: current.sandbox, approvalPolicy: current.approvalPolicy, selected: profile, persistent };
    }
    try {
      if (continuationId) {
        const result = await this.delegate({ ...input, pendingId: continuationId, targetRole: 'codex', targetId: sessionId,
          targetCwd: sourceCwd, continuation: true, deferStart: true, changesCode: false, codeTask: !!task?.changesCode, planApproved: !!task?.planApproved });
        task = await readTask(this.root, result.id);
      }
      if (task) { task.permissionChanges ??= []; task.permissionChanges.push(change); await writeTask(this.root, task); }
      if (continuationId) this.run(task.id);
    } catch (error) {
      if (!persistent) await this.restorePermissions({ permissionChanges: [change], message: '' });
      throw error;
    }
    const message = continuationId ? '权限已调整，结束当前回合后将在同一 Codex 会话继续。' : role === 'codex' ? '权限已调整，将从该 Codex 会话下一回合生效。' : 'DSH 权限已调整，对后续受限工具调用生效。';
    return { message: task ? `${message} 任务 ID：${task.id}` : message };
  }

  async pause(id) {
    const task = await readTask(this.root, id); this.paused.add(id);
    const active = this.active.get(id);
    if (active?.role === 'dsh') await this.dsh.cancel(active.id).catch(() => {});
    if (active?.role === 'codex' && active.turnId) await (await this.getDaemon()).interrupt(active.id, active.turnId).catch(() => {});
    if (!this.loops.has(id)) { task.phase = 'PAUSED'; task.message = '任务已暂停。'; await writeTask(this.root, task); }
    return { message: '已请求暂停，确认会话和后台任务停稳后再接手。' };
  }
  async resume(id, retry = false) {
    const task = await readTask(this.root, id);
    if (!['PAUSED', 'BLOCKED'].includes(task.phase)) throw new Error('任务没有暂停或阻断');
    if (!task.pending && !task.activeHop) throw new Error('没有可恢复的交接请求；请在参与会话中重新发起');
    if (!retry) throw new Error('请检查原会话和工作区；确认后使用 resume --retry');
    task.pending ??= task.activeHop; task.activeHop = null;
    this.paused.delete(id); task.phase = 'WAITING'; task.message = '用户确认后重新检查待交接请求。'; await writeTask(this.root, task); this.run(id);
    return { message: '已恢复；正在检查会话是否停稳。' };
  }
  async recoverOnStartup() {
    for (const task of await listTasks(this.root)) if (task.kind === 'relay' && ['RUNNING', 'WAITING'].includes(task.phase)) {
      task.phase = 'BLOCKED'; task.message = '控制器曾中断，请检查原会话和工作区后手动恢复。'; await writeTask(this.root, task);
    }
  }
  async restorePermissions(task) {
    for (const item of [...(task.permissionChanges ?? [])].reverse()) {
      if (item.persistent || item.previous === item.selected) continue;
      try {
        if (item.role === 'dsh') {
          const now = await this.dsh.call('permissions-current', { sessionId: item.id });
          if (now.current === item.selected && item.previous !== 'custom') await this.dsh.call('permissions-set', { sessionId: item.id, preset: item.previous });
          else if (now.current === item.selected) throw new Error('原权限为 custom，不能通过预设恢复');
        } else {
          const client = await this.getDaemon(), now = await client.resume(item.id);
          if (now.activePermissionProfile?.id === item.selected) {
            const params = { threadId: item.id, ...(item.previous ? { permissions: item.previous } : { sandboxPolicy: item.sandbox }), ...(item.approvalPolicy ? { approvalPolicy: item.approvalPolicy } : {}) };
            await client.request('thread/settings/update', params);
          }
        }
      } catch (error) { task.message += ` 权限未能自动恢复：${error.message}`; }
    }
  }
  async restoreModels(task) {
    for (const item of task.modelChanges ?? []) {
      try {
        const current = (await this.dsh.inspect(item.id)).model;
        if (current?.provider === item.selected?.provider && current?.model === item.selected?.model && current?.reasoningEffort === item.selected?.reasoningEffort && item.previous?.provider && item.previous?.model) {
          await this.dsh.call('model', { sessionId: item.id, model: { provider: item.previous.provider, model: item.previous.model, reasoning_effort: item.previous.reasoningEffort, reset_reasoning: !item.previous.reasoningEffort } });
        }
      } catch (error) { task.message += ` 模型未能自动恢复：${error.message}`; }
    }
  }
}
