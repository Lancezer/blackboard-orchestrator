import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
async function runtime(root) {
  try { const value = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')); return value.ready && alive(value.pid) ? value : null; }
  catch { return null; }
}

let starting;
export async function ensureService(root) {
  if (await runtime(root)) return;
  if (starting) return await starting;
  starting = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    let running = false, exitCode = null, launchError = null;
    try { const lock = JSON.parse(await readFile(join(root, 'controller.lock'), 'utf8')); running = alive(lock.pid); } catch {}
    if (!running) {
      const log = await open(join(root, 'controller.log'), 'a', 0o600);
      const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
      const child = spawn(process.execPath, [cli, 'serve'], { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, BLACKBOARD_DATA: root } });
      child.once('error', error => { launchError = error; });
      child.once('exit', code => { exitCode = code ?? 1; });
      child.unref(); await log.close();
    }
    for (let end = Date.now() + 60000; Date.now() < end; ) {
      if (await runtime(root)) return;
      if (launchError) throw launchError;
      if (exitCode !== null) {
        let message = '';
        try { message = (await readFile(join(root, 'controller.log'), 'utf8')).trim().split('\n').at(-1) ?? ''; } catch {}
        throw new Error(message || `控制器退出（${exitCode}）；请查看 ${join(root, 'controller.log')}`);
      }
      await delay(250);
    }
    throw new Error(`控制器启动失败或未就绪，请查看 ${join(root, 'controller.log')}`);
  })();
  try { await starting; } finally { starting = null; }
}
