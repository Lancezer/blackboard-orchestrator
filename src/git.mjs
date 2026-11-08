import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function git(cwd, args, options = {}) {
  const result = await exec('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024, ...options });
  return result.stdout.trim();
}
