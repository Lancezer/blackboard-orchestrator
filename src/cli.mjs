#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { listTasks, readTask, taskDir } from './blackboard.mjs';
import { ensureService } from './bootstrap.mjs';
import { controlCall } from './ipc.mjs';
import { runtimeRoot } from './paths.mjs';
import { serve } from './service.mjs';
import { setup } from './setup.mjs';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = runtimeRoot();
function parse(args) {
  const options = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) positional.push(args[i]);
    else if (args[i] === '--retry') options.retry = true;
    else { const key = args[i].slice(2); if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${args[i]} 需要一个值`); options[key] = args[++i]; }
  }
  return { options, positional };
}
async function readConfig(path) {
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; config = JSON.parse(await readFile(join(project, 'config.example.json'), 'utf8')); }
  config.codex ??= {}; config.dsh ??= {}; config.limits ??= {};
  for (const key of ['codex_concurrency', 'dsh_concurrency']) { config.limits[key] ??= 2; if (!Number.isInteger(config.limits[key]) || config.limits[key] < 1) throw new Error(`${key} 需要正整数`); }
  config.phase_timeout_minutes ??= 45;
  if (typeof config.phase_timeout_minutes !== 'number' || config.phase_timeout_minutes <= 0) throw new Error('phase_timeout_minutes 需要正数');
  config.dsh_port ??= 0;
  if (!Number.isInteger(config.dsh_port) || config.dsh_port < 0 || config.dsh_port > 65535) throw new Error('dsh_port 无效');
  return config;
}
function help() {
  console.log(`Codex × DSH 自由会话交接\n\n  node src/cli.mjs setup                     安装两端入口、DSH bundle 和 Git 忽略规则\n  node src/cli.mjs start                     按需启动常驻控制器\n  node src/cli.mjs serve [--config 路径]     在当前终端运行控制器\n  node src/cli.mjs stop                      停止控制器，保留 DSH Web Host\n  node src/cli.mjs status [任务ID]           查看任务和参与会话\n  node src/cli.mjs report 任务ID             查看最新结果\n  node src/cli.mjs models                    查询两端模型和推理强度\n  node src/cli.mjs tui 任务ID [--session ID] 打开原生 Codex 会话\n  node src/cli.mjs web                       显示 DSH WebUI 地址\n  node src/cli.mjs pause 任务ID              暂停任务\n  node src/cli.mjs resume 任务ID --retry     人工检查后恢复待交接请求\n\n控制信息：${root}`);
}
async function main() {
  const [command = 'help', ...args] = process.argv.slice(2), { options, positional } = parse(args);
  if (['help', '--help', '-h'].includes(command)) return help();
  if (command === 'setup') { console.log((await setup(project, root)).message); return; }
  if (command === 'serve') return await serve(root, await readConfig(resolve(options.config ?? join(project, 'config.json'))));
  if (command === 'start') { await ensureService(root); console.log('交接控制器已启动。'); return; }
  if (command === 'stop') {
    let state; try { state = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')); } catch {}
    if (!state?.ready) return console.log('控制器未运行。');
    const result = await controlCall(root, 'stop', {}, 10000);
    for (let end = Date.now() + 8000; Date.now() < end; ) {
      try { if (!JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')).ready) break; } catch { break; }
      await delay(150);
    }
    console.log(result.message); return;
  }
  if (command === 'status') {
    const tasks = positional[0] ? [await readTask(root, positional[0])] : await listTasks(root);
    if (!tasks.length) return console.log('暂无任务。');
    for (const task of tasks) {
      console.log(`${task.id}\t${task.phase}\t${task.owner ?? '-'}\t${task.message ?? ''}\n  黑板: ${join(taskDir(root, task.id), 'HANDOFF.md')}`);
      for (const p of task.participants ?? []) console.log(`  ${p.role}: ${p.id} (${p.cwd})`);
    }
    return;
  }
  if (command === 'web') {
    await ensureService(root);
    const host = JSON.parse(await readFile(join(root, 'dsh-host.json'), 'utf8'));
    if (!host.webUrl) throw new Error('DSH 页面地址不可用');
    console.log(host.webUrl); return;
  }
  if (command === 'models') {
    await ensureService(root); const catalog = await controlCall(root, 'models', {}, 45000);
    console.log('Codex：'); for (const model of catalog.codex) console.log(`  ${model.id}：${model.efforts.join(', ')}`);
    console.log('DSH：'); for (const provider of catalog.dsh.groups ?? []) for (const model of provider.models) console.log(`  ${provider.id}/${model.id}：${model.reasoning?.efforts?.map(item => item.id).join(', ') || '提供方默认'}`);
    for (const failure of catalog.dsh.failures ?? []) console.log(`  ${failure.id}：${failure.message}`);
    return;
  }
  if (!['pause', 'resume', 'report', 'tui'].includes(command)) throw new Error(`未知命令 ${command}`);
  const id = positional[0]; if (!id) throw new Error(`${command} 需要任务 ID`);
  if (command === 'pause' || command === 'resume') {
    await ensureService(root); console.log((await controlCall(root, command, { taskId: id, retry: !!options.retry }, 30000)).message); return;
  }
  const task = await readTask(root, id);
  if (command === 'report') {
    const doc = task.documents?.result ?? task.documents?.instruction;
    if (!doc) throw new Error('暂无结果');
    console.log(await readFile(join(taskDir(root, id), doc), 'utf8')); return;
  }
  if (command === 'tui') {
    const candidates = (task.participants ?? []).filter(p => p.role === 'codex');
    const target = options.session ? candidates.find(p => p.id === options.session) : candidates.at(-1);
    if (!target) throw new Error('任务中没有该 Codex 会话');
    const child = spawn('codex', ['resume', target.id], { cwd: target.cwd, stdio: 'inherit' });
    await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', code => code === 0 ? ok() : fail(new Error(`Codex TUI 退出：${code}`))); });
    return;
  }
  throw new Error(`未知命令 ${command}`);
}
main().catch(error => { console.error(`错误：${error.message}`); process.exitCode = 1; });
