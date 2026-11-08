import { randomUUID } from 'node:crypto';
export const name = 'blackboard-bridge';
export const inject = ['sessionController', 'jobs', 'llm'];
export async function apply(ctx) {
  const bridge = await import(`../src/dsh-plugin.mjs?instance=${randomUUID()}`);
  return bridge.apply(ctx);
}
