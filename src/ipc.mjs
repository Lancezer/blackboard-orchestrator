import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function fileCall(root, channel, op, params = {}, timeoutMs = 15000) {
  const id = randomUUID();
  const requestDir = join(root, channel, 'requests');
  const responseDir = join(root, channel, 'responses');
  await Promise.all([mkdir(requestDir, { recursive: true, mode: 0o700 }), mkdir(responseDir, { recursive: true, mode: 0o700 })]);
  const request = join(requestDir, `${id}.json`);
  const response = join(responseDir, `${id}.json`);
  const temporary = `${request}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...params, id, op }), { mode: 0o600 });
  await rename(temporary, request);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const result = JSON.parse(await readFile(response, 'utf8'));
      await rm(response, { force: true });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(150);
  }
  await rm(request, { force: true });
  throw new Error(`${channel} ${op} 超时；请求是否执行未知，请查看当前状态`);
}

export const bridgeCall = (root, op, params, timeoutMs) => fileCall(root, 'bridge', op, params, timeoutMs);
export const controlCall = (root, op, params, timeoutMs) => fileCall(root, 'control', op, params, timeoutMs);
