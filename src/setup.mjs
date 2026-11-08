import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { atomicWrite } from './blackboard.mjs';

const exec = promisify(execFile);
const bundleName = 'blackboard-relay';

async function installSkill(project, name, root) {
  const source = join(project, 'skills', name, 'SKILL.md'), target = join(root, name, 'SKILL.md');
  const wanted = await readFile(source, 'utf8');
  try {
    const old = await readFile(target, 'utf8');
    if (old === wanted) return;
    if (!old.includes(name === 'to-dsh' ? '# 交给 DSH' : '# 交给 Codex')) throw new Error(`已有同名技能 ${target}，未覆盖`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await atomicWrite(target, wanted);
}

async function ignoreTaskDirectory() {
  let configured;
  try { configured = (await exec('git', ['config', '--global', '--get', 'core.excludesfile'])).stdout.trim(); }
  catch (error) { if (error.code !== 1) throw error; }
  const file = configured ? resolve(configured.replace(/^~(?=\/|$)/, homedir())) : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'git', 'ignore');
  let text = ''; try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!text.split(/\r?\n/).includes('.codex-dsh/')) {
    let mode; try { mode = (await stat(file)).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(file), { recursive: true });
    await atomicWrite(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.codex-dsh/\n`);
    if (mode !== undefined) await chmod(file, mode);
  }
  return file;
}

export async function setup(project, root) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const profileDir = join(dshHome, 'profiles', 'web');
  const backup = join(root, 'backups'); await mkdir(backup, { recursive: true, mode: 0o700 });
  const config = join(codexHome, 'config.toml');
  let current;
  try { current = JSON.parse((await exec('codex', ['mcp', 'get', 'blackboard_local', '--json'])).stdout); }
  catch (error) { if (!/not found|no .*server/i.test(error.stderr ?? error.message)) throw error; }
  const mcpPath = resolve(project, 'src', 'mcp.mjs');
  if (current && (current.transport?.command !== 'node' || current.transport?.args?.[0] !== mcpPath)) throw new Error('Codex 已有名为 blackboard_local 的其他 MCP，未覆盖');
  if (!current) {
    try { await copyFile(config, join(backup, `codex-config-${Date.now()}.toml`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await exec('codex', ['mcp', 'add', 'blackboard_local', '--', 'node', mcpPath]);
  }
  await installSkill(project, 'to-dsh', join(codexHome, 'skills'));
  await installSkill(project, 'to-codex', join(dshHome, 'skills'));
  const ignore = await ignoreTaskDirectory();
  let manifest = {};
  try { manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const installed = manifest.dependencies?.[bundleName];
  if (installed) {
    const link = await realpath(join(profileDir, 'node_modules', bundleName)).catch(() => '');
    if (link !== await realpath(join(project, 'dsh-bundle'))) throw new Error('DSH 已安装其他同名 bundle，未覆盖');
  } else {
    await exec('dsh', ['plugin', '--profile', 'web', 'add', `link:${join(project, 'dsh-bundle')}`, '--offline'], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  }
  return { backup, ignore, message: '已安装 Codex MCP、双端技能和 DSH 本地 bundle。已有会话未显示新工具时，请重新打开相应会话或重启 DSH Web Host。' };
}
