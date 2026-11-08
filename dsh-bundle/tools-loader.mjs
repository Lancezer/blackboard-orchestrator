import { randomUUID } from 'node:crypto';
export const name = 'blackboard-relay-tools';
export const inject = ['tools', 'workingDirectory'];
export async function apply(ctx) {
  const tools = await import(`../src/dsh-handoff-tool.mjs?instance=${randomUUID()}`);
  return tools.apply(ctx);
}
