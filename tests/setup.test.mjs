import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from '../src/setup.mjs';

test('安装使用隔离的原生配置，可重复执行并拒绝覆盖同名 MCP', async t => {
  const base = await mkdtemp(join(tmpdir(), 'blackboard-setup-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const testHome = join(base, 'home'), codexHome = join(base, 'codex'), dshHome = join(base, 'dsh'), bin = join(base, 'bin'), runtime = join(base, 'runtime');
  await Promise.all([testHome, codexHome, dshHome, bin].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(codexHome, 'config.toml'), '# 用户原配置\n');
  const codex = `#!/bin/sh
if [ "$2" = get ]; then
  if [ -f "$CODEX_HOME/mock-mcp.json" ]; then cat "$CODEX_HOME/mock-mcp.json"; else printf 'not found\\n' >&2; exit 1; fi
elif [ "$2" = add ]; then
  node -e 'process.stdout.write(JSON.stringify({transport:{command:"node",args:[process.argv[1]]}}))' "$6" > "$CODEX_HOME/mock-mcp.json"
else exit 1; fi
`;
  const dsh = `#!/bin/sh
if [ "$1" != plugin ] || [ "$4" != add ]; then exit 1; fi
bundle="\${5#link:}"
mkdir -p "$DSH_HOME/profiles/web/node_modules"
ln -s "$bundle" "$DSH_HOME/profiles/web/node_modules/blackboard-relay"
printf '{"dependencies":{"blackboard-relay":"link"}}\\n' > "$DSH_HOME/profiles/web/package.json"
`;
  await writeFile(join(bin, 'codex'), codex); await chmod(join(bin, 'codex'), 0o755);
  await writeFile(join(bin, 'dsh'), dsh); await chmod(join(bin, 'dsh'), 0o755);
  const keys = ['HOME', 'CODEX_HOME', 'DSH_HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'PATH'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: testHome, CODEX_HOME: codexHome, DSH_HOME: dshHome, XDG_CONFIG_HOME: join(testHome, '.config'), GIT_CONFIG_GLOBAL: join(testHome, '.gitconfig'), PATH: `${bin}:${previous.PATH}` });
  try {
    const project = dirname(dirname(fileURLToPath(import.meta.url)));
    await setup(project, runtime);
    await setup(project, runtime);
    assert.match(await readFile(join(testHome, '.config', 'git', 'ignore'), 'utf8'), /^\.codex-dsh\/$/m);
    assert.match(await readFile(join(codexHome, 'skills', 'to-dsh', 'SKILL.md'), 'utf8'), /delegate_to_dsh/);
    assert.match(await readFile(join(dshHome, 'skills', 'to-codex', 'SKILL.md'), 'utf8'), /delegate_to_codex/);
    const backups = await readdir(join(runtime, 'backups'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(runtime, 'backups', backups[0]), 'utf8'), '# 用户原配置\n');
    await writeFile(join(codexHome, 'mock-mcp.json'), JSON.stringify({ transport: { command: 'other', args: [] } }));
    await assert.rejects(setup(project, runtime), /其他 MCP，未覆盖/);
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
