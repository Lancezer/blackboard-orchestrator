import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, listTasks, readTask, taskDir } from './blackboard.mjs';
import { runtimeRoot } from './paths.mjs';

export const name = 'blackboard-bridge';
export const inject = ['sessionController', 'jobs', 'llm'];

export function apply(ctx) {
  const root = runtimeRoot();
  const requests = join(root, 'bridge', 'requests');
  const responses = join(root, 'bridge', 'responses');
  const lockPath = join(root, 'bridge', 'host.lock');
  const token = randomUUID();
  const slot = Symbol.for(`blackboard-orchestrator.bridge:${root}`);
  // HMR can mount a replacement before disposing the old instance.
  if (typeof globalThis[slot] === 'function') globalThis[slot]();
  mkdirSync(join(root, 'bridge'), { recursive: true, mode: 0o700 });
  try {
    const previous = JSON.parse(readFileSync(lockPath, 'utf8'));
    let alive = false;
    try { process.kill(previous.pid, 0); alive = true; } catch (error) { if (error.code === 'EPERM') alive = true; }
    if (alive) throw new Error(`另一个 DSH Host 已连接黑板（PID ${previous.pid}）`);
    unlinkSync(lockPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = openSync(lockPath, 'wx', 0o600);
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, token })); fsyncSync(lock); } finally { closeSync(lock); }
  let stopped = false;
  let scanning = false;
  const signal = new AbortController();
  const watches = new Map();
  const writeResponse = async (id, value) => {
    const temp = join(responses, `${id}.tmp`);
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, join(responses, `${id}.json`));
  };
  const selectModel = async (sessionId, requested) => {
    const api = ctx.sessionController;
    const resolved = await api.resolveAgent(sessionId);
    if (resolved.error) throw resolved.error;
    const current = resolved.agent.model.current() ?? {};
    if (!requested || !Object.values(requested).some(Boolean)) return current;
    const provider = requested.provider ?? current.provider;
    const model = requested.model ?? current.model;
    const effort = requested.reset_reasoning ? undefined : requested.reasoning_effort ?? (provider === current.provider && model === current.model ? current.reasoningEffort : undefined);
    const selected = { provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
    if (!provider || !model) throw new Error('请同时提供 DSH provider 和 model，或使用会话默认值');
    const catalog = await api.modelCatalog();
    const entry = catalog.groups.find(group => group.id === provider)?.models.find(item => item.id === model);
    if (!entry) throw new Error(`DSH 模型不可用：${provider}/${model}`);
    if (effort && !entry.reasoning?.efforts.some(item => item.id === effort)) throw new Error(`DSH 模型不支持推理强度 ${effort}`);
    await ctx.llm.resolveCallConfig(selected);
    resolved.agent.model.select(selected);
    return resolved.agent.model.current();
  };
  const run = async (request) => {
    const api = ctx.sessionController;
    switch (request.op) {
      case 'ping': return { ready: true, pid: process.pid };
      case 'web-url': {
        const web = ctx.get('webApp'), connection = ctx.get('connection');
        if (!web || !connection) throw new Error('当前 DSH Host 没有 Web 页面');
        return { url: connection.authenticatedUrl(web.getAdvertisedUrl()) };
      }
      case 'catalog': return await api.modelCatalog();
      case 'permissions-catalog': {
        const service = ctx.get('permissionPresets');
        if (!service) throw new Error('DSH 当前未提供权限预设服务');
        return service.catalog();
      }
      case 'permissions-current': {
        const service = ctx.get('permissionPresets'), resolved = await api.resolveAgent(request.sessionId);
        if (!service) throw new Error('DSH 当前未提供权限预设服务');
        if (resolved.error) throw resolved.error;
        return { current: service.current(resolved.agent.session), catalog: service.catalog() };
      }
      case 'permissions-set': {
        const service = ctx.get('permissionPresets'), resolved = await api.resolveAgent(request.sessionId);
        if (!service) throw new Error('DSH 当前未提供权限预设服务');
        if (resolved.error) throw resolved.error;
        const previous = service.current(resolved.agent.session);
        service.set(resolved.agent.session, request.preset);
        return { previous, current: service.current(resolved.agent.session) };
      }
      case 'create': {
        const selectedPreset = request.preset;
        // The WebUI groups sessions by Workspace. Creating with only cwd
        // leaves the session ungrouped and invisible in the normal sidebar.
        const registry = ctx.get('workspaceRegistry');
        const workspace = registry ? await registry.create(request.cwd) : null;
        const result = await api.create({ ...(workspace ? { workspaceId: workspace.id } : { cwd: request.cwd }), ...(selectedPreset ? { agentPreset: selectedPreset } : {}) });
        if (request.taskId) await api.rename({ sessionId: result.sessionId, title: `blackboard: ${request.taskId}` });
        return { ...result, model: await selectModel(result.sessionId, request.model) };
      }
      case 'model': return { model: await selectModel(request.sessionId, request.model) };
      case 'resume': {
        const resolved = await api.resolveAgent(request.sessionId);
        if (resolved.error) throw resolved.error;
        return { sessionId: request.sessionId, model: resolved.agent.model.current() };
      }
      case 'inspect': {
        const resolved = await api.resolveAgent(request.sessionId);
        if (resolved.error) throw resolved.error;
        return { sessionId: request.sessionId, cwd: ctx.get('workingDirectory')?.get(resolved.agent.session) ?? resolved.agent.session.header.cwd, sandboxCwd: resolved.agent.session.header.cwd, model: resolved.agent.model.current(), tools: resolved.agent.ctx.tools.schemas().map(item => item.name) };
      }
      case 'state': {
        const state = await api.state({ sessionId: request.sessionId }, signal.signal);
        const jobs = ctx.jobs.list(request.sessionId).map(({ id, status }) => ({ id, status }));
        const watch = watches.get(request.sessionId);
        if (state.queue?.length) {
          const taskId = watch?.taskId ?? (await listTasks(root)).find(task => task.kind === 'relay' && task.owner === 'dsh' && task.ownerId === request.sessionId && ['WAITING', 'RUNNING'].includes(task.phase))?.id;
          if (taskId) for (const item of state.queue) {
            if (item.placement === 'context' || (watch && item.rpcId && item.rpcId === watch.requestId)) continue;
            const safeId = String(item.id).replace(/[^a-zA-Z0-9-]/g, '');
            const path = join(taskDir(root, taskId), `input-dsh-queue-${safeId}.md`);
            const content = (item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
            const attachments = (item.content ?? []).some(part => part.type !== 'text');
            const document = `# DSH 待处理输入\n\n${content}${attachments ? '\n\n含非文本附件，请查看 DSH 会话。' : ''}\n\n此输入可能仍在原生会话队列中，请勿重复执行。\n`;
            let previous = ''; try { previous = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (previous !== document) await atomicWrite(path, document);
          }
        }
        const queue = state.queue?.map(({ id, placement, rpcId }) => ({ id, placement, ...(rpcId ? { rpcId } : {}) })) ?? null;
        return { ...state, queue, jobs, observed: watch ? { matchedTurn: watch.matchedTurn, ends: watch.ends, error: watch.error, finalDocument: watch.finalDocument } : null };
      }
      case 'prompt': {
        const before = await api.state({ sessionId: request.sessionId }, signal.signal);
        if (before.running || before.queue === null || before.queue.length || before.pendingInput.length || ctx.jobs.list(request.sessionId).some(job => ['running', 'stopping'].includes(job.status))) throw new Error('DSH 会话尚未停稳');
        watches.get(request.sessionId)?.abort.abort();
        const abort = new AbortController();
        const task = await readTask(root, request.taskId);
        const resultName = `result-${String(task.revision).padStart(3, '0')}-dsh.md`;
        const watch = { abort, taskId: request.taskId, requestId: request.id, matchedTurn: null, ends: [], error: null, finalDocument: null };
        const iterator = api.observeEvent({ address: { kind: 'session', sessionId: request.sessionId } }, abort.signal)[Symbol.asyncIterator]();
        const ready = await iterator.next();
        if (ready.done || ready.value.type !== 'ready') throw new Error('DSH 事件订阅未就绪');
        watches.set(request.sessionId, watch);
        void (async () => {
          let currentTurn = null;
          try {
            while (!abort.signal.aborted) {
              const next = await iterator.next();
              if (next.done) break;
              const event = next.value.event;
              if (!event) continue;
              if (event.type === 'turn/start') currentTurn = event.data.turn;
              if (event.type === 'user/message' && event.data.source?.kind === 'user') {
                if (event.data.source.rpcId === request.id) watch.matchedTurn = currentTurn;
                else {
                  const name = `input-dsh-${event.seq}.md`;
                  const content = (event.data.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
                  const attachments = (event.data.content ?? []).some(part => part.type !== 'text');
                  await atomicWrite(join(taskDir(root, request.taskId), name), `# DSH 人工输入\n\n${content}${attachments ? '\n\n含非文本附件，请查看 DSH 会话。' : ''}\n`);
                }
              }
              if (event.type === 'turn/end') watch.ends.push({ turn: event.data.turn, reason: event.data.reason, seq: event.seq });
              if (event.type === 'assistant/message') {
                const content = event.data.message?.content ?? event.data.content;
                const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
                if (text) {
                  await atomicWrite(join(taskDir(root, request.taskId), resultName), text.trim() + '\n');
                  watch.finalDocument = resultName;
                }
              }
            }
          } catch (error) { if (!abort.signal.aborted) watch.error = error.message; }
        })();
        const handoff = join(taskDir(root, request.taskId), 'HANDOFF.md');
        return await api.prompt({ sessionId: request.sessionId, requestId: request.id, mode: 'queue', content: [{ type: 'text', text: `交接任务 ID：${request.taskId}。请读取 ${handoff} 及其中的 instruction，根据用户要求完成工作，自行决定是否继续交接。可使用 blackboard_sessions 查看参与会话。` }] }, signal.signal);
      }
      case 'cancel': return api.cancel({ sessionId: request.sessionId });
      default: throw new Error(`Unknown operation: ${request.op}`);
    }
  };
  const scan = async () => {
    if (scanning || stopped) return;
    scanning = true;
    try {
      await Promise.all([mkdir(requests, { recursive: true, mode: 0o700 }), mkdir(responses, { recursive: true, mode: 0o700 })]);
      for (const filename of await readdir(requests)) {
        if (!/^[a-f0-9-]+\.json$/.test(filename)) continue;
        const path = join(requests, filename);
        let req;
        try {
          req = JSON.parse(await readFile(path, 'utf8'));
          await rm(path);
          if (req.id !== filename.slice(0, -5)) throw new Error('IPC ID mismatch');
          const value = await run(req);
          await writeResponse(req.id, { ok: true, value });
        } catch (error) {
          const id = filename.slice(0, -5);
          await rm(path, { force: true }).catch(() => {});
          await writeResponse(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally { scanning = false; }
  };
  const timer = setInterval(() => void scan().catch(error => console.error('blackboard bridge:', error)), 200);
  void scan();
  const dispose = () => {
    if (stopped) return;
    stopped = true; clearInterval(timer); signal.abort(); for (const watch of watches.values()) watch.abort.abort();
    try { if (existsSync(lockPath) && JSON.parse(readFileSync(lockPath, 'utf8')).token === token) unlinkSync(lockPath); } catch {}
    if (globalThis[slot] === dispose) delete globalThis[slot];
  };
  globalThis[slot] = dispose;
  ctx.effect(() => dispose);
}
