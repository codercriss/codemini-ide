// The runner's version handshake. The runner is deployed separately from the app, so it can be older than the app that talks to it (on
// 2026-10-28 a stale runner kept showing a bug that was already fixed, and nothing said the runner was the old part). Each runner page says its
// version in the hello-ack; the app needs a minimum for the execution host and says so when a runner is below it. How that behaves in a browser
// is in tests/e2e/runner-exec.e2e.js; this file holds the rules that have to hold in the source.
const assert = require('assert');
const paths = require('./lib/paths');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const cfg = paths.read('runner/config.js'), exec = paths.read('runner/exec.js'), shell = paths.read('runner/shell.js');
const client = paths.read('js/viewers/runner-client.js'), settings = paths.read('js/core/settings-profile.js');
const v = /version:\s*(\d+),\s*build:\s*'(\d{4}-\d{2}-\d{2})'/.exec(cfg);
// The runner has two homes: its own repository (CodeMini-Runner, which Vercel deploys) and the copy in this repository's runner/ folder, which
// is what these tests read. Copies drift: on 2026-10-28 this one lacked the version while the deployed runner had it, and CI failed although the
// phone showed everything working. Say what to do, instead of a bare assertion.
const STALE = ' The runner files belong together (config.js, exec.js, shell.js). This repository\'s runner/ folder is a copy of the CodeMini-Runner repository, where the runner is deployed from: copy the three current files into it.';
const needs = /var RUNNER_NEEDS = \{ preview: (\d+), exec: (\d+) \};/.exec(client);

console.log('runner version handshake');
t('the runner config carries an integer version (1 or more) and a dated build', () => {
  assert.ok(v, 'runner/config.js in this repository has no "version: N, build: \'YYYY-MM-DD\'" line, so it is older than the app.' + STALE);
  assert.ok(Number(v[1]) >= 1);
});
t('the runner config lists its current version in the level history, so a bump has to be written down', () => {
  assert.ok(new RegExp('//\\s+' + v[1] + ' \\+').test(cfg), 'add a "//   ' + v[1] + ' + what changed" line to the level list in runner/config.js');
});
t('both runner pages send the version and the build in the hello-ack', () => {
  for (const [name, src] of [['exec.js', exec], ['shell.js', shell]])
    assert.ok(/op: 'hello-ack', version: \(CFG\.version \| 0\), build: String\(CFG\.build \|\| ''\)/.test(src), 'runner/' + name + ' does not send its version and build in hello-ack.' + STALE);
});
t('the version is not put in the "ready" announcement, which can go to an unknown origin (only the acknowledged parent gets it)', () => {
  for (const src of [exec, shell]) {
    const ready = /op: 'ready'[^}]*\}/.exec(src);
    assert.ok(ready && !/version|build/.test(ready[0]));
  }
});
t('the app never needs more than the runner in the repository has (raise both together)', () => {
  assert.ok(needs, 'RUNNER_NEEDS not found in js/viewers/runner-client.js');
  assert.ok(Number(needs[1]) <= Number(v[1]) && Number(needs[2]) <= Number(v[1]), 'RUNNER_NEEDS ' + needs[0] + ' is above the runner version ' + v[1]);
  assert.ok(Number(needs[2]) >= 1, 'the execution host must need a real version, or the check does nothing');
});
t('the app keeps only a small integer and a short plain string from what a runner says about itself', () => {
  assert.ok(/function cleanInfo\(d\)/.test(client));
  assert.ok(/Number\.isInteger\(d\.version\) && d\.version >= 0 && d\.version < 1000/.test(client));
  assert.ok(/\/\^\[0-9A-Za-z\._-\]\{1,40\}\$\/\.test\(d\.build\)/.test(client));
});
t('the ack reaches the handshake with its content, and the execution host is refused below the minimum', () => {
  assert.ok(/s\.onAck\(d\)/.test(client) && /s\.onAck = function \(d\) \{ s\.info = cleanInfo\(d\)/.test(client));
  assert.ok(/if \(lastInfo\.exec\.version < RUNNER_NEEDS\.exec\) \{[^}]*throw new Error\(execLastError\)/.test(client), 'the execution host must throw when the runner is below the minimum');
});
t('the message names the runner project and says what to do', () => {
  assert.ok(/Redeploy the runner project \(codemini-runner\)/.test(client) && /before version numbers/.test(client));
});
t('Settings has a Check runner row, and fills it with textContent only', () => {
  assert.ok(/id="btnCheckRunner"/.test(settings) && /id="runnerVersionText"/.test(settings));
  const a = settings.indexOf('const btnCheckRunner'), b = settings.indexOf('// Clear UI Caches Logic');
  assert.ok(a > 0 && b > a);
  const block = settings.slice(a, b);
  assert.ok(/out\.textContent = r\.message/.test(block) && !/innerHTML/.test(block));
});
t('webR is pinned to one release, the same in the host and in the app (not /latest/, which served a moving development snapshot)', () => {
  const host = /var WEBR_URL = '(https:\/\/webr\.r-wasm\.org\/[^']+)'/.exec(exec);
  const app = /import\('(https:\/\/webr\.r-wasm\.org\/[^']+)'\)/.exec(paths.read('js/notebook/notebook-kernels.js'));
  assert.ok(host, 'WEBR_URL not found in runner/exec.js');
  assert.ok(app, 'the webR import not found in js/notebook/notebook-kernels.js');
  assert.ok(/^https:\/\/webr\.r-wasm\.org\/v\d+\.\d+\.\d+\/webr\.mjs$/.test(host[1]), 'the host must load a numbered release, not ' + host[1]);
  assert.strictEqual(app[1], host[1], 'the app and the runner must load the same webR version');
});
console.log(`\n${n} checks passed`);
