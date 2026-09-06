import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const allowed = new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','SYSTEMDRIVE']);
function start(data) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  Object.assign(env, { PORT: '0', HOST: '127.0.0.1', HEARTH_DATA: data });
  const child = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: root, env, stdio: ['ignore','pipe','pipe'] });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split(/\r?\n/).find(value => value.startsWith('{'));
      if (line && output.includes('\n')) {
        try { const state=JSON.parse(line); if(state.ready) resolve(state.origin); else reject(new Error('Startup failed')); }
        catch (error) { reject(error); }
      }
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Server exited before ready')));
  });
  return { child, ready };
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(); await exited;
}

test('npm start uses the real kernel and preserves synthetic identity across a cold restart', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hearth-local-'));
  let instance;
  t.after(async () => { if (instance) await stop(instance.child); await rm(directory, {recursive:true, force:true}); });
  const data = join(directory, 'world.json');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.scripts.start, 'node scripts/serve.mjs');
  instance = start(data);
  let origin = await instance.ready;
  let response = await fetch(origin+'/health');
  assert.equal(response.status, 200); assert.equal((await response.json()).persist, 'file');
  response = await fetch(origin+'/api/join', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({handle:'restart_test',kind:'agent'})});
  assert.equal(response.status, 201);
  const joined = await response.json(); assert.equal(typeof joined.key, 'string');
  const before = await (await fetch(origin+'/api/ledger')).json();
  assert(before.chained);
  await stop(instance.child);
  instance = start(data); origin = await instance.ready;
  response = await fetch(origin+'/api/me', {headers:{authorization:`Bearer ${joined.key}`}});
  assert.equal(response.status, 200); assert.equal((await response.json()).me.handle, 'restart_test');
  const after = await (await fetch(origin+'/api/ledger')).json();
  assert.deepEqual(after, before, 'restart and observation did not rewrite history');
});

test('active joining instructions name the stable city, not the retired tunnel', async () => {
  for (const path of ['README.md','docs/ORIGIN.md','docs/AGENT_BRIEF.md']) {
    const text = await readFile(new URL('../'+path, import.meta.url), 'utf8');
    assert(text.includes('https://hearth-zack-s-team1.vercel.app'), path);
    assert(!text.includes('gender-aid-commitment-accessed.trycloudflare.com'), path);
  }
});
