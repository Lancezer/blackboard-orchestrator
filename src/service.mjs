import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { chmod, open, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexClient } from './codex.mjs';
import { DshClient } from './dsh.mjs';
import { atomicWrite } from './blackboard.mjs';
import { RelayController } from './relay-controller.mjs';

const exec = promisify(execFile);
const bundle = 'blackboard-relay';
class Gate {
  constructor(limit) { this.limit = limit; this.used = 0; }
  async acquire(cancelled) {
    while (this.used >= this.limit) { if (cancelled()) throw new Error('任务已请求暂停'); await delay(250); }
    if (cancelled()) throw new Error('任务已请求暂停');
    this.used++;
    return () => { this.used--; };
  }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
async function acquireLock(root) {
  const path = join(root, 'controller.lock');
  try { const old = JSON.parse(await readFile(path, 'utf8')); if (alive(old.pid)) throw new Error(`控制器 PID ${old.pid} 仍在运行`); await rm(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() })); await file.sync(); }
  finally { await file.close(); }
  return path;
}
async function clearRequests(root, channel) {
  for (const side of ['requests', 'responses']) await mkdir(join(root, channel, side), { recursive: true, mode: 0o700 });
  for (const name of await readdir(join(root, channel, 'requests'))) if (/^[a-f0-9-]+\.json(?:\.tmp)?$/.test(name)) await rm(join(root, channel, 'requests', name), { force: true });
}
async function ping(dsh) { try { return (await dsh.call('ping', {}, 1000)).ready; } catch { return false; } }
async function waitBridge(dsh, ms = 30000) {
  for (let end = Date.now() + ms; Date.now() < end; ) { if (await ping(dsh)) return; await delay(300); }
  throw new Error('DSH 桥接未就绪，请在插件界面启用 blackboard-relay 后重试');
}

// Use the same authenticated native plugin-manager API as the DSH WebUI.
async function enableBundle(url) {
  if (!url) throw new Error('无法获取当前 DSH Host 的认证连接');
  const address = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) throw new Error('仅自动连接本机 DSH Host');
  const initial = await fetch(address, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const cookie = initial.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('DSH Host 认证已失效');
  const rpcId = randomUUID(), method = 'pluginManager/setBundleEnabled';
  const response = await fetch(new URL(`/api/${method}`, address), { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', cookie, origin: address.origin },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { name: bundle, enabled: true } } }) });
  if (!response.ok) throw new Error(`插件管理接口返回 HTTP ${response.status}`);
  const result = await response.json();
  if (result.rpcId !== rpcId || !result.result?.ok) throw new Error(result.result?.error?.message ?? 'DSH 插件启用失败');
  const value = result.result.value;
  if (value?.status === 'failed' || value?.status === 'refused' || value?.restartRequired) throw new Error('DSH 插件未能即时启用，可能需要重启 Web Host');
}

async function launchDsh(root, config) {
  const logPath = join(root, 'dsh-host.log');
  const file = await open(logPath, 'a+', 0o600), offset = (await file.stat()).size;
  const child = spawn('dsh', ['web', '--host', '127.0.0.1', '--port', String(config.dsh_port ?? 0), '--no-open'], {
    detached: true, stdio: ['ignore', file.fd, file.fd], env: { ...process.env, BLACKBOARD_DATA: root }
  });
  let failure;
  child.once('error', error => { failure = error; });
  child.unref(); await file.close();
  for (let end = Date.now() + 30000; Date.now() < end; ) {
    if (failure) throw failure;
    const data = (await readFile(logPath)).subarray(offset).toString('utf8');
    const match = data.match(/dsh web:\s*(https?:\/\/[^\s]+)/);
    if (match) {
      const webUrl = match[1];
      await atomicWrite(join(root, 'dsh-host.json'), JSON.stringify({ pid: child.pid, webUrl }, null, 2) + '\n');
      if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
        const browser = spawn('xdg-open', [webUrl], { detached: true, stdio: 'ignore' }); browser.once('error', () => {}); browser.unref();
      }
      return { pid: child.pid, webUrl };
    }
    if (child.exitCode !== null) throw new Error(`DSH Web Host 已退出，详见 ${logPath}`);
    await delay(250);
  }
  throw new Error(`DSH Web Host 启动超时，详见 ${logPath}`);
}

export async function serve(root, config) {
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const lockPath = await acquireLock(root);
  let daemon, relay, timer, stopped = false, host;
  const dsh = new DshClient(root);
  try {
    await clearRequests(root, 'control');
    try { host = JSON.parse(await readFile(join(root, 'dsh-host.json'), 'utf8')); } catch {}
    const ensureDsh = async () => {
      if (await ping(dsh)) {
        try { const info = await dsh.call('web-url', {}, 2000); const state = await dsh.call('ping', {}, 2000); host = { pid: state.pid, webUrl: info.url }; await atomicWrite(join(root, 'dsh-host.json'), JSON.stringify(host) + '\n'); } catch {}
        return;
      }
      if (host?.pid && alive(host.pid)) {
        try { await enableBundle(host.webUrl); await waitBridge(dsh, 10000); return; }
        catch (error) { throw new Error(`无法自动启用 DSH 插件：${error.message}；请在 DSH 插件界面启用后重试`); }
      }
      // Do not start a second Host if an existing, unconnected Web Host is visible.
      try {
        const processes = (await exec('ps', ['-eo', 'pid=,args='])).stdout.split('\n');
        const desiredHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
        for (const line of processes) {
          const match = line.match(/^\s*(\d+)\s+(.+)$/);
          if (!match || !/(?:\/dsh\/lib\/bin\.js|\bdsh)\s+web\b/.test(match[2])) continue;
          let otherHome = desiredHome;
          try {
            const env = (await readFile(`/proc/${match[1]}/environ`, 'utf8')).split('\0');
            otherHome = resolve(env.find(item => item.startsWith('DSH_HOME='))?.slice('DSH_HOME='.length) || join(homedir(), '.dsh'));
          } catch {}
          if (otherHome === desiredHome) throw new Error('检测到已有 DSH Web Host，但桥接不可用；请在插件界面启用 blackboard-relay');
        }
      } catch (error) { if (/检测到已有/.test(error.message)) throw error; }
      await clearRequests(root, 'bridge');
      host = await launchDsh(root, config);
      if (!(await ping(dsh))) {
        try { await enableBundle(host.webUrl); } catch (error) { console.error(`自动启用 DSH 插件失败：${error.message}`); }
      }
      await waitBridge(dsh);
    };
    await ensureDsh();
    const getDaemon = async () => {
      if (daemon?.socket?.readyState === WebSocket.OPEN) return daemon;
      const socket = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
      const connect = async () => {
        const client = new CodexClient(`ws+unix://${socket}:/`, root);
        client.on('error', error => console.error('Codex daemon：', error.message));
        client.on('input-required', input => console.error(`Codex 会话等待用户操作：${input.method}`));
        await client.connect(2500); return client;
      };
      try { daemon = await connect(); }
      catch { await exec('codex', ['app-server', 'daemon', 'start'], { timeout: 30000 }); daemon = await connect(); }
      return daemon;
    };
    const gates = { codex: new Gate(config.limits.codex_concurrency), dsh: new Gate(config.limits.dsh_concurrency) };
    relay = new RelayController(root, config, getDaemon, dsh, gates);
    await relay.recoverOnStartup();
    await atomicWrite(join(root, 'runtime.json'), JSON.stringify({ pid: process.pid, ready: true, dshPid: host?.pid ?? null, webUrl: host?.webUrl ?? null }, null, 2) + '\n');
    console.log('交接控制器已启动；空闲时常驻。');
    let scanning = false;
    const scan = async () => {
      if (scanning || stopped) return; scanning = true;
      try {
        const requests = join(root, 'control', 'requests'), responses = join(root, 'control', 'responses');
        for (const name of await readdir(requests)) {
          if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
          const file = join(requests, name), id = name.slice(0, -5); let response, stopAfterReply = false;
          try {
            const req = JSON.parse(await readFile(file, 'utf8')); await rm(file);
            if (req.id !== id) throw new Error('IPC 请求 ID 不匹配');
            let value;
            if (req.op === 'stop') { value = { message: '已请求停止控制器，DSH Web Host 保持运行。' }; stopAfterReply = true; }
            else if (req.op === 'relay-delegate') { await ensureDsh(); value = await relay.delegate(req.task); }
            else if (req.op === 'relay-sessions') value = await relay.sessions(req.taskId, req.sourceRole, req.sourceId);
            else if (req.op === 'relay-options') { await ensureDsh(); value = await relay.options(req); }
            else if (req.op === 'relay-permission') { await ensureDsh(); value = await relay.setPermission(req); }
            else if (req.op === 'pause') value = await relay.pause(req.taskId);
            else if (req.op === 'resume') value = await relay.resume(req.taskId, req.retry);
            else if (req.op === 'models') {
              await ensureDsh(); const client = await getDaemon(), models = []; let cursor = null;
              do { const page = await client.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }); models.push(...page.data); cursor = page.nextCursor; } while (cursor);
              value = { codex: models.map(m => ({ id: m.model, default: m.isDefault, efforts: m.supportedReasoningEfforts.map(e => e.reasoningEffort) })), dsh: await dsh.call('catalog', {}, 30000) };
            } else throw new Error(`未知命令 ${req.op}`);
            response = { ok: true, value };
          } catch (error) { await rm(file, { force: true }); response = { ok: false, error: error.message }; }
          const tmp = join(responses, `${id}.tmp`); await writeFile(tmp, JSON.stringify(response), { mode: 0o600 }); await rename(tmp, join(responses, `${id}.json`));
          if (stopAfterReply) { shutdown(); break; }
        }
      } finally { scanning = false; }
    };
    timer = setInterval(() => void scan().catch(error => console.error('控制请求：', error.message)), 200);
    let finish; const finished = new Promise(resolve => { finish = resolve; });
    const shutdown = () => { if (!stopped) { stopped = true; finish(); } };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    await finished;
    for (const id of relay.loops.keys()) await relay.pause(id).catch(() => {});
    await Promise.race([Promise.allSettled([...relay.loops.values()]), delay(5000)]);
  } finally {
    clearInterval(timer); daemon?.close();
    await atomicWrite(join(root, 'runtime.json'), JSON.stringify({ ready: false, dshPid: host?.pid ?? null, webUrl: host?.webUrl ?? null }) + '\n').catch(() => {});
    await rm(lockPath, { force: true });
  }
}
