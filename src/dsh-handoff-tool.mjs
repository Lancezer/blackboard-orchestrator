import { runtimeRoot } from './paths.mjs';
// DSH's package reloader evicts bundle modules, but not their project siblings.
const { descriptions, invoke, schemas } = await import(`./relay-interface.mjs?dsh=${Date.now()}`);

export const name = 'blackboard-relay-tools';
export const inject = ['tools', 'workingDirectory'];
export function apply(ctx) {
  for (const [name, action] of Object.entries({ delegate_to_codex: 'delegate', blackboard_sessions: 'sessions', blackboard_read: 'read', blackboard_options: 'options', blackboard_set_permission: 'permission' })) {
    ctx.tools.register({
      name, description: descriptions[action], parameters: schemas[action],
      output: { schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string' } }, required: ['message'] },
        render(_args, value) { return [{ type: 'text', text: value.message }]; } },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('缺少当前 DSH 会话');
        const cwd = ctx.workingDirectory.get(exec.agent.session) ?? exec.agent.session.header.cwd;
        const result = await invoke(runtimeRoot(), action, args, { role: 'dsh', id: exec.agent.id, cwd });
        if (action === 'delegate') exec.concludeTurn();
        return result;
      }
    });
  }
}
