#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { runtimeRoot } from './paths.mjs';
import { descriptions, invoke, schemas } from './relay-interface.mjs';

const names = { delegate_to_dsh: 'delegate', blackboard_sessions: 'sessions', blackboard_read: 'read', blackboard_options: 'options', blackboard_set_permission: 'permission' };
const tools = Object.entries(names).map(([name, action]) => ({ name, description: descriptions[action] + ' Codex 调用前通过 printenv CODEX_THREAD_ID 获取当前线程 ID。',
  inputSchema: { ...schemas[action], required: [...new Set([...(schemas[action].required ?? []), 'thread_id', 'source_workspace'])] } }));

function reply(id, result, error) { process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) + '\n'); }
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  void (async () => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined) return;
    try {
      if (msg.method === 'initialize') reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'blackboard', version: '0.3.0' }, instructions: '按用户任务需要自主调用 delegate_to_dsh；成功交接后结束本回合。不要假定会自动返回。' });
      else if (msg.method === 'tools/list') reply(msg.id, { tools });
      else if (msg.method === 'tools/call' && names[msg.params?.name]) {
        const args = msg.params.arguments ?? {};
        if (!/^[0-9a-f-]{20,}$/i.test(args.thread_id ?? '')) throw new Error('请通过 printenv CODEX_THREAD_ID 获取当前 Codex 线程 ID');
        if (typeof args.source_workspace !== 'string' || !args.source_workspace.startsWith('/')) throw new Error('请提供当前会话工作区绝对路径');
        const value = await invoke(runtimeRoot(), names[msg.params.name], args, { role: 'codex', id: args.thread_id, cwd: args.source_workspace });
        reply(msg.id, { content: [{ type: 'text', text: value.message }] });
      } else reply(msg.id, null, { code: -32601, message: 'method not found' });
    } catch (error) { if (msg.method === 'tools/call') reply(msg.id, { isError: true, content: [{ type: 'text', text: error.message }] }); else reply(msg.id, null, { code: -32603, message: error.message }); }
  })();
});
