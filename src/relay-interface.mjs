import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWrite, listTasks, readTask, taskDir } from './blackboard.mjs';
import { ensureService } from './bootstrap.mjs';
import { controlCall } from './ipc.mjs';

const text = (description) => ({ type: 'string', description });
const boolean = (description) => ({ type: 'boolean', description });
const common = {
  task_id: text('可选：当前交接任务 ID；继续已有任务时填写。'),
  source_workspace: text('当前会话工作区的绝对路径。'),
  thread_id: text('Codex 当前线程 ID；通过 printenv CODEX_THREAD_ID 获取，不要猜测。')
};
export const schemas = {
  delegate: { type: 'object', additionalProperties: false, properties: {
    ...common,
    request: text('交给目标会话的具体任务、用户要求、必要上下文和后续协作目标。'),
    target_workspace: text('目标会话工作区绝对路径；省略时使用当前工作区。'),
    target_session_id: text('需要精确复用的对方会话 ID；可通过 blackboard_sessions 查询。'),
    new_session: boolean('true 时创建新会话，不复用已有会话。'),
    new_task: boolean('true 时创建新任务，而不是继续当前任务。'),
    changes_code: boolean('本次目标会话是否将修改代码。'),
    code_task: boolean('整个任务是否涉及代码修改，即使本次只读规划。'),
    plan_approved: boolean('用户是否已在某个参与会话明确批准本任务实施计划。'),
    scope_approved: boolean('用户是否明确批准本次涉及的新项目。'),
    project_workspaces: { type: 'array', items: { type: 'string' }, description: '任务实际涉及的项目路径；仅查看或汇报的会话工作区不必列入。' },
    codex_model: text('本次 Codex 模型，省略继承默认。'), codex_effort: text('本次 Codex 推理强度。'),
    dsh_provider: text('本次 DSH 提供方。'), dsh_model: text('本次 DSH 模型。'), dsh_effort: text('本次 DSH 推理强度。'),
    target_permission: text('用户明确要求时，为目标会话选择的原生权限预设。'),
    permission_confirmed: boolean('用户明确要求或同意目标会话的权限调整。'),
    permission_persistent: boolean('用户明确要求权限持续生效，默认任务结束后尝试恢复。')
  }, required: ['request', 'changes_code'] },
  sessions: { type: 'object', additionalProperties: false, properties: common },
  read: { type: 'object', additionalProperties: false, properties: common },
  options: { type: 'object', additionalProperties: false, properties: { ...common, role: { type: 'string', enum: ['codex', 'dsh'] }, session_id: text('指定会话 ID；省略使用当前会话。') } },
  permission: { type: 'object', additionalProperties: false, properties: {
    ...common, role: { type: 'string', enum: ['codex', 'dsh'] }, session_id: text('目标会话 ID；省略使用当前会话。'),
    profile: text('通过 blackboard_options 获取的原生权限预设 ID。'),
    user_confirmed: boolean('用户已明确要求或同意本次权限调整。'),
    persistent: boolean('用户明确要求持续生效；默认任务结束后尝试恢复。'),
    continue_with: text('用户要求修改权限后继续时，描述需要在同一 Codex 会话继续的工作。')
  }, required: ['profile', 'user_confirmed'] }
};

export const descriptions = {
  delegate: '按用户要求唤起另一端会话处理任务；不自动返回。代码修改先取得用户批准。成功后结束本回合。',
  sessions: '查看当前交接任务与参与会话 ID，用于精确选择新建或复用会话。',
  read: '读取当前任务的黑板和最新交接要求。',
  options: '动态查询两端可用模型、推理强度及指定会话的原生权限选项。',
  permission: '按用户明确要求调整当前或任务参与会话的原生权限；默认任务结束后尝试恢复。'
};

async function pending(root, textValue) {
  const id = randomUUID();
  await mkdir(join(root, 'pending'), { recursive: true, mode: 0o700 });
  await atomicWrite(join(root, 'pending', `${id}.md`), textValue.trim() + '\n');
  return id;
}
function overrides(args) {
  const out = { codex: {}, dsh: {} };
  for (const [from, side, to] of [['codex_model', 'codex', 'model'], ['codex_effort', 'codex', 'reasoning_effort'], ['dsh_provider', 'dsh', 'provider'], ['dsh_model', 'dsh', 'model'], ['dsh_effort', 'dsh', 'reasoning_effort']]) if (args[from]) out[side][to] = args[from];
  return out;
}
async function currentTask(root, id, role, sessionId) {
  if (id) {
    const task = await readTask(root, id);
    if (task.kind !== 'relay' || !task.participants.some(p => p.role === role && p.id === sessionId)) throw new Error('当前会话不属于该任务');
    return task;
  }
  const matches = (await listTasks(root)).filter(t => t.kind === 'relay' && ['WAITING', 'RUNNING'].includes(t.phase) && t.participants?.some(p => p.role === role && p.id === sessionId));
  if (matches.length > 1) throw new Error('当前会话有多个任务，请指定 task_id');
  return matches[0] ?? null;
}

export async function invoke(root, action, args, source) {
  const sourceId = source.id, sourceRole = source.role;
  const sourceCwd = resolve(source.cwd ?? args.source_workspace ?? '.');
  if (!sourceId) throw new Error('缺少当前会话 ID');
  if (action === 'read') {
    const task = await currentTask(root, args.task_id, sourceRole, sourceId);
    if (!task) return { message: `当前会话尚无交接任务；首次交接请直接调用 ${sourceRole === 'dsh' ? 'delegate_to_codex' : 'delegate_to_dsh'}。` };
    const dir = taskDir(root, task.id);
    return { message: `${await readFile(join(dir, 'HANDOFF.md'), 'utf8')}\n\n${await readFile(join(dir, task.documents.instruction), 'utf8')}` };
  }
  await ensureService(root);
  const identity = { sourceRole, sourceId, sourceCwd, taskId: args.task_id ?? null };
  if (action === 'delegate') {
    if (typeof args.request !== 'string' || !args.request.trim()) throw new Error('交接要求不能为空');
    const pendingId = await pending(root, args.request);
    try {
      const value = await controlCall(root, 'relay-delegate', { task: { ...identity, pendingId,
        targetCwd: resolve(args.target_workspace ?? sourceCwd), targetId: args.target_session_id ?? null,
        newSession: !!args.new_session, newTask: !!args.new_task, changesCode: !!args.changes_code,
        codeTask: !!args.code_task, planApproved: !!args.plan_approved, scopeApproved: !!args.scope_approved,
        targetPermission: args.target_permission, permissionConfirmed: !!args.permission_confirmed, permissionPersistent: !!args.permission_persistent,
        projects: args.project_workspaces, overrides: overrides(args) } }, 45000);
      return { message: `${value.message}\n任务 ID：${value.id}\n黑板：${value.handoff}` };
    } finally { await rm(join(root, 'pending', `${pendingId}.md`), { force: true }); }
  }
  if (action === 'sessions') {
    const value = await controlCall(root, 'relay-sessions', identity);
    return { message: value.task ? JSON.stringify(value, null, 2) : `当前会话尚无交接任务；首次交接请直接调用 ${sourceRole === 'dsh' ? 'delegate_to_codex' : 'delegate_to_dsh'}。` };
  }
  if (action === 'options') return { message: JSON.stringify(await controlCall(root, 'relay-options', { ...identity, role: args.role ?? sourceRole, sessionId: args.session_id ?? sourceId }, 45000), null, 2) };
  if (action === 'permission') {
    if (!args.user_confirmed) throw new Error('需要用户明确要求或同意权限调整');
    const continuationId = args.continue_with?.trim() ? await pending(root, args.continue_with) : null;
    try {
      const value = await controlCall(root, 'relay-permission', { ...identity, role: args.role ?? sourceRole,
        sessionId: args.session_id ?? sourceId, profile: args.profile, persistent: !!args.persistent, continuationId }, 45000);
      return { message: value.message };
    } finally { if (continuationId) await rm(join(root, 'pending', `${continuationId}.md`), { force: true }); }
  }
  throw new Error(`未知操作：${action}`);
}
