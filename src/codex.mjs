import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { atomicWrite, listTasks, taskDir } from './blackboard.mjs';

export class CodexClient extends EventEmitter {
  constructor(url, root) { super(); this.url = url; this.root = root; this.nextId = 1; this.pending = new Map(); this.completed = new Map(); this.finalMessages = new Map(); }
  async connect(timeoutMs = 15000) {
    let last;
    for (const end = Date.now() + timeoutMs; Date.now() < end;) {
      try { await this.open(); return; } catch (error) { last = error; await delay(250); }
    }
    throw new Error(`连接 Codex app-server 失败：${last?.message}`);
  }
  async open() {
    let Socket = WebSocket;
    if (this.url.startsWith('ws+unix:')) {
      // DSH already ships ws. Resolve it from the installed dsh package rather
      // than requiring a second copy or changing the user's global packages.
      const dsh = realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim());
      Socket = createRequire(dsh)('ws');
    }
    const socket = new Socket(this.url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    this.socket = socket;
    this.receiving = Promise.resolve();
    socket.addEventListener('message', e => {
      this.receiving = this.receiving.then(() => this.receive(JSON.parse(e.data))).catch(error => this.emit('error', error));
    });
    socket.addEventListener('close', () => {
      for (const value of this.pending.values()) value.reject(new Error('Codex app-server 连接已断开'));
      this.pending.clear(); this.emit('disconnect');
    });
    await this.request('initialize', { clientInfo: { name: 'blackboard-orchestrator', version: '0.3.0' }, capabilities: { experimentalApi: true } });
    this.notify('initialized', {});
  }
  notify(method, params) { this.socket.send(JSON.stringify({ method, params })); }
  request(method, params, timeoutMs = 30000) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Codex 未连接');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 超时`)); }, timeoutMs);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async receive(message) {
    if (message.method && Object.hasOwn(message, 'id')) {
      if (message.method === 'item/tool/call') {
        // The native client owns the tools on its thread.
        this.emit('external-tool', { threadId: message.params?.threadId, tool: message.params?.tool });
      } else {
        // Approval and questions are surfaced by the native TUI. Leave them pending.
        this.emit('input-required', { method: message.method, threadId: message.params?.threadId });
      }
      return;
    }
    if (message.method) {
      if (message.method === 'turn/completed') this.completed.set(message.params.turn.id, message.params);
      if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') this.finalMessages.set(message.params.turnId, message.params.item.text);
      if (message.method === 'item/started' && message.params?.item?.type === 'userMessage') {
        const item = message.params.item;
        const content = (item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
        const attachments = (item.content ?? []).some(part => part.type !== 'text');
        if (content || attachments) {
          const matches = (await listTasks(this.root)).filter(task => task.kind === 'relay' && task.owner === 'codex' && task.ownerId === message.params.threadId && ['WAITING', 'RUNNING'].includes(task.phase));
          const generated = matches.length === 1 && content.startsWith(`交接任务 ID：${matches[0].id}。请读取 `);
          if (matches.length === 1 && (!generated || attachments)) {
            const safeId = String(item.id).replace(/[^a-zA-Z0-9-]/g, '');
            await atomicWrite(join(taskDir(this.root, matches[0].id), `input-codex-${safeId}.md`), `# Codex 人工输入\n\n${content}${attachments ? '\n\n含非文本附件，请查看原生 Codex 会话。' : ''}\n`);
          }
        }
      }
      this.emit('notification', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`Codex: ${message.error.message}`)); else pending.resolve(message.result);
  }
  async createRelay(cwd, settings = {}) {
    const params = { cwd, developerInstructions: '你参与本地跨会话协作。按用户的任务要求工作；是否继续交接由任务要求决定。' };
    if (settings.model) params.model = settings.model;
    const created = await this.request('thread/start', params);
    if (settings.model && settings.model !== created.model) throw new Error(`Codex 未使用指定模型：${settings.model}`);
    if (settings.model || settings.reasoning_effort) await this.validateModel(created.model, settings.reasoning_effort);
    await this.request('thread/inject_items', { threadId: created.thread.id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '本地协作会话已创建。' }] }] });
    return created;
  }
  async resume(id) { return await this.request('thread/resume', { threadId: id, excludeTurns: true }); }
  async state(id) { return (await this.request('thread/read', { threadId: id, includeTurns: false })).thread.status; }
  async terminals(id) { return (await this.request('thread/backgroundTerminals/list', { threadId: id })).data; }
  async queue(id) {
    const all = []; let cursor = null;
    do {
      const page = await this.request('thread/queue/list', { threadId: id, limit: 100, ...(cursor ? { cursor } : {}) });
      all.push(...page.data); cursor = page.nextCursor;
    } while (cursor);
    return all;
  }
  async validateModel(id, effort) {
    let cursor = null, model;
    do {
      const catalog = await this.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      model = catalog.data.find(item => item.id === id || item.model === id);
      cursor = catalog.nextCursor;
    } while (!model && cursor);
    if (!model) throw new Error(`Codex 模型不可用：${id}`);
    if (effort && !model.supportedReasoningEfforts.some(item => item.reasoningEffort === effort)) throw new Error(`Codex 模型不支持推理强度 ${effort}`);
  }
  async startRelay(task, target, overrides = {}) {
    const status = await this.state(target.id);
    if (status.type !== 'idle') throw new Error(`Codex 线程尚未空闲：${status.type}`);
    const handoff = join(taskDir(this.root, task.id), 'HANDOFF.md');
    const text = `交接任务 ID：${task.id}。请读取 ${handoff} 和其中的 instruction；根据用户的任务目标完成工作，并自行决定是否调用交接工具。需要查看参与会话时调用 blackboard_sessions。`;
    const params = { threadId: target.id, cwd: target.cwd, input: [{ type: 'text', text, text_elements: [] }] };
    if (overrides.model || overrides.reasoning_effort) {
      const current = overrides.model ?? (await this.resume(target.id)).model;
      await this.validateModel(current, overrides.reasoning_effort);
    }
    if (overrides.model) params.model = overrides.model;
    if (overrides.reasoning_effort) params.effort = overrides.reasoning_effort;
    return (await this.request('turn/start', params)).turn;
  }
  takeFinal(turnId) { const value = this.finalMessages.get(turnId); this.finalMessages.delete(turnId); return value; }
  async wait(turnId, deadline, isPaused = () => false) {
    while (Date.now() < deadline) {
      const value = this.completed.get(turnId);
      if (value) { this.completed.delete(turnId); return value.turn; }
      if (isPaused()) throw new Error('任务已请求暂停');
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Codex 连接中断');
      await delay(250);
    }
    throw new Error('Codex 阶段超时');
  }
  async interrupt(threadId, turnId) { if (turnId) await this.request('turn/interrupt', { threadId, turnId }); }
  close() { this.socket?.close(); }
}
