import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export async function atomicWrite(path, data) {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmp, 'wx', 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  try {
    await rename(tmp, path);
    const dir = await open(join(path, '..'), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (error) { await rm(tmp, { force: true }); throw error; }
}

export function taskDir(root, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('无效的任务 ID');
  try { return resolve(readFileSync(join(root, 'task-paths', id), 'utf8').trim()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return join(root, 'tasks', id);
}

export async function setTaskDir(root, id, path) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('无效的任务 ID');
  await atomicWrite(join(root, 'task-paths', id), resolve(path) + '\n');
}

// Keep historical references usable when an approved task becomes multi-project.
export async function relocateTask(root, id, destination) {
  const old = taskDir(root, id), target = resolve(destination);
  if (old === target) return target;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await rename(old, target); // Cross-device moves stop rather than leave two writable copies.
  try {
    await symlink(target, old, 'dir');
    await setTaskDir(root, id, target);
  } catch (error) {
    await rm(old, { force: true }).catch(() => {});
    await rename(target, old).catch(() => {});
    throw error;
  }
  return target;
}

export async function readTask(root, id) {
  const source = await readFile(join(taskDir(root, id), 'HANDOFF.md'), 'utf8');
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('HANDOFF.md 格式无效');
  const task = JSON.parse(match[1]);
  if (task.id !== id) throw new Error('HANDOFF.md 任务 ID 不一致');
  return task;
}

export async function writeTask(root, task) {
  task.updatedAt = new Date().toISOString();
  const links = Object.entries(task.documents ?? {}).filter(([, value]) => value).map(([key, value]) => `- ${key}: [${value}](./${value})`).join('\n');
  const participants = (task.participants ?? []).map(p => `- ${p.role}: \`${p.id}\`；工作区：\`${p.cwd}\``).join('\n');
  const info = `# 任务 ${task.id}\n\n状态：**${task.phase}**；当前端：**${task.owner ?? '无'}**；版本：${task.revision}。\n\n${task.message ?? ''}\n\n## 参与会话\n\n${participants || '- 暂无'}\n\n## 当前文件\n\n${links || '- 暂无'}\n\n请根据任务要求自行决定是否交接；交接前调用对应工具。不要编辑本文件。\n`;
  await atomicWrite(join(taskDir(root, task.id), 'HANDOFF.md'), `---\n${JSON.stringify(task, null, 2)}\n---\n\n${info}`);
}

export async function listTasks(root) {
  const dir = join(root, 'tasks');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tasks = [];
  const ids = new Set(await readdir(dir));
  try { for (const id of await readdir(join(root, 'task-paths'))) ids.add(id); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const id of ids) {
    try { tasks.push(await readTask(root, id)); } catch (error) { tasks.push({ id, phase: 'INVALID', message: error.message }); }
  }
  return tasks;
}
