// Console and Terminal code on the runner's execution host, in a real browser with two origins (app :8765, runner :8766).
// JavaScript runs for real. Python, PHP and Ruby need engines from CDNs, which are not reachable from the test sandbox, so
// small stand-ins are served instead: they check the plumbing (protocol, rendering, errors, plots, argv, settings, fallback),
// NOT the real Pyodide / php-wasm / Opal.
const path = require('path');
const { chromium } = require('playwright');
const { createServer } = require('./lib/static-server');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x).slice(0, 300) : '')); };
const APP = 'http://localhost:8765', RUNNER = 'http://localhost:8766';
const CORS = { 'access-control-allow-origin': '*' };

const FAKE_PYODIDE = `
window.loadPyodide = async function () {
  let out = '', err = '', lastUser = '';
  const dict = () => { py.__dicts = (py.__dicts || 0) + 1; return { set(k, v) { this['_' + k] = v; } }; };
  const py = {
    async loadPackage() {}, async loadPackagesFromImports() {}, registerJsModule() {},
    globals: { set(k, v) { py['g_' + k] = v; }, get(k) { return k === 'dict' ? dict : py['g_' + k]; } },
    runPython(code, o) {
      if (/_cm_stdout = io\\.StringIO/.test(code)) { out = ''; err = ''; return; }
      if (/sys\\.argv = sys_argv/.test(code)) { out += 'argv=' + JSON.stringify(o && o.globals && o.globals._sys_argv) + '\\n'; return; }
      if (code === '_cm_stdout.getvalue()') return out;
      if (code === '_cm_stderr.getvalue()' || code === 'sys.stderr.getvalue()') return err;
    },
    async runPythonAsync(code) {
      (py.__codes = py.__codes || []).push(code);
      if (/^import os/.test(code)) return;
      if (code.indexOf('get_fignums') > -1) return { toJs: () => (/plot/.test(lastUser) ? ['QUJD'] : []), destroy() {} };
      if (code.indexOf('import json, sys, types, builtins') > -1) return py.__vars ? JSON.stringify(py.__vars) : '[{"name":"host_var","type":"int","value":"5"}]';
      lastUser = code;
      let m = code.match(/^print\\((.*)\\)$/);
      if (m) { out += String(eval(m[1])) + '\\n'; return undefined; }
      if (/^raise /.test(code)) { err += 'ValueError: boom\\n'; throw new Error('PythonError: ValueError: boom'); }
      if (/sys\\.argv/.test(code)) { out += 'argv-used\\n'; return undefined; }
      return eval(code);
    }
  };
  return py;
};`;
const FAKE_OPAL = `window.Opal = { eval(code) { const m = code.match(/^puts\\s+"(.*)"$/); if (m) { console.log(m[1]); return null; } if (/^raise/.test(code)) throw new Error('RuntimeError: boom'); const s = code.replace(/\\s/g, ''); if (s === '1+1') return 2; return 'nil'; } };`;
// sql.js stand-in: counts the databases it creates (window.__dbCount, in whichever page loads it) and answers a few fixed queries.
const FAKE_SQLJS = [
  "window.initSqlJs = async function () { return { Database: function () {",
  "  window.__dbCount = (window.__dbCount || 0) + 1; var tables = [];",
  "  this.create_function = function () {}; this.close = function () { window.__dbClosed = (window.__dbClosed || 0) + 1; };",
  "  this.exec = function (sql) {",
  "    if (sql.indexOf('boom') > -1) throw new Error('near \"boom\": syntax error');",
  "    var m = /CREATE TABLE ([a-z_]+)/i.exec(sql); if (m) { tables.push(m[1]); return []; }",
  "    if (sql.indexOf('sqlite_master') > -1) return tables.length ? [{ columns: ['name'], values: tables.map(function (t) { return [t]; }) }] : [];",
  "    if (sql.indexOf('SELECT 6*7') > -1) return [{ columns: ['answer'], values: [[42]] }];",
  "    if (sql.indexOf('SELECT hostile') > -1) return [{ columns: ['<b>col</b>', 'plain'], values: [['<img src=x onerror=window.__pwn=7>', null], ['&lt;b&gt;', 3.5]] }];",
  "    if (sql.indexOf('SELECT blob') > -1) return [{ columns: ['b'], values: [[new Uint8Array([1, 2, 3])]] }];",
  "    return [];",
  "  }; } }; };"
].join('\n');
// webR stand-in: a real ES module file (see lib/fake-webr.mjs), served for https://webr.r-wasm.org/<version>/webr.mjs (any version path, so the tests do not change when the pin does)
const FAKE_WEBR = require('fs').readFileSync(path.join(__dirname, 'lib', 'fake-webr.mjs'), 'utf8');
const FAKE_PHP = `export class PhpWeb extends EventTarget { async run(code) { if (/trigger_error/.test(code)) { this.dispatchEvent(new CustomEvent('error', { detail: 'PHP Fatal: boom' })); return; } const m = code.match(/echo "(.*?)";/); if (m) this.dispatchEvent(new CustomEvent('output', { detail: m[1] })); } }`;

async function open(browser, runnerUrl, extraLs, stubs, ctxOptions) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 800 } }, ctxOptions || {}));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(([runnerUrl, extraLs]) => {
    if (location.port === '8765') { if (runnerUrl) localStorage.setItem('codemini_runner_url', runnerUrl); Object.keys(extraLs || {}).forEach(k => localStorage.setItem(k, extraLs[k])); }
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  }, [runnerUrl, extraLs || {}]);
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  if (stubs !== false) {
    await page.route('https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', headers: CORS, body: FAKE_PYODIDE }));
    // (Playwright tries the most recently added route first: the generic empty one goes in FIRST, the real stand-in after it.)
    await page.route(/^https:\/\/cdn\.opalrb\.com\/opal\/1\.8\.3\/.+\.js$/, r => r.fulfill({ status: 200, contentType: 'text/javascript', headers: CORS, body: '' }));
    await page.route(/^https:\/\/cdn\.opalrb\.com\/opal\/1\.8\.3\/opal\.min\.js$/, r => r.fulfill({ status: 200, contentType: 'text/javascript', headers: CORS, body: FAKE_OPAL }));
    await page.route('https://unpkg.com/php-wasm@0.1.0/PhpWeb.mjs', r => r.fulfill({ status: 200, contentType: 'text/javascript', headers: CORS, body: FAKE_PHP }));
    await page.route(/^https:\/\/webr\.r-wasm\.org\/[^/]+\/webr\.mjs$/, r => r.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: FAKE_WEBR }));
    await page.route('https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', headers: CORS, body: FAKE_SQLJS }));
  }
  await page.goto(APP + '/index.html'); await sleep(3500);
  return { ctx, page, errors };
}
// Open a language Console and give back functions to run a command and read its output.
async function openConsole(page, language) {
  await page.evaluate((l) => window.openLanguageConsole(l), language); await sleep(900);
  const run = async (cmd, wait) => {
    await page.evaluate((cmd) => { const i = [...document.querySelectorAll('.console-input')].pop(); i.value = cmd; [...document.querySelectorAll('.run-btn')].pop().click(); }, cmd);
    await sleep(wait || 1800);
    return page.evaluate(() => [...document.querySelectorAll('.console-output')].pop().innerText);
  };
  return run;
}
const framesOfHosts = (page) => page.frames().filter(f => /\/exec\.html/.test(f.url()));

(async () => {
  const runnerServer = createServer(require('../lib/paths').runnerDir(), { headers: { 'Content-Security-Policy': "frame-ancestors 'self' http://localhost:8765 http://127.0.0.1:8765" } });
  await new Promise(r => runnerServer.listen(8766, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  console.log('\n[Console, JavaScript, Isolated]');
  let { ctx, page, errors } = await open(browser, RUNNER);
  let run = await openConsole(page, 'JavaScript');
  let o = await run('6 * 7');
  ok(/42/.test(o), 'an expression is evaluated and its result shown', o);
  ok(framesOfHosts(page).length === 1 && framesOfHosts(page)[0].url().startsWith(RUNNER + '/exec.html'), 'it ran in a hidden frame on the runner origin');
  o = await run("console.log('hi'); console.warn('careful'); 5");
  ok(/hi[\s\S]*careful[\s\S]*5/.test(o), 'console output comes first, then the result, in order', o);
  o = await run('null.x');
  ok(/\[JS Error\] TypeError/.test(o), 'an error is shown as [JS Error] with its name', o);
  await run('var kept = 41'); o = await run('kept + 2');
  ok(/43/.test(o), 'globals persist between commands', o);
  o = await run("try { window.top.CodeMiniShield; 'reachable' } catch (e) { 'blocked: ' + e.name }");
  ok(/blocked: SecurityError/.test(o), 'the code cannot reach CodeMini (window.top.CodeMiniShield is blocked)', o);
  o = await run("String(localStorage.getItem('codemini_active_window'))");
  ok(/"null"/.test(o), "and the app's localStorage is not there (the runner has its own)", o);
  o = await run('document.title');
  ok(/CodeMini runner: code execution/.test(o), 'its document is the runner\'s, not the app\'s', o);
  o = await run("'<img src=x onerror=window.__pwn=1>'");
  ok(await page.evaluate(() => !window.__pwn && document.querySelectorAll('.console-output img[src="x"]').length === 0), 'output is escaped: no HTML injected into the app', o);
  await run("window.parent.postMessage({ cmRunner: 1, op: 'exec-done', id: 1, nonce: '0'.repeat(32), value: { type: 'text', text: 'FORG' + 'ED' } }, '*'); 'sent'");
  o = await page.evaluate(() => [...document.querySelectorAll('.console-output')].pop().innerText);
  ok(/sent/.test(o) && !/FORGED/.test(o), 'a forged result posted by the code is ignored (no nonce)', o.slice(-80));
  const bad1 = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(bad1.length === 0, 'no page errors', bad1);

  console.log('\n[per-surface setting: Normal vs Isolated, applied at once]');
  await page.evaluate(() => window.saveSetting('isolationConsole', 'Normal'));
  o = await run('typeof window.CodeMiniShield');
  ok(/"object"/.test(o), 'Console set to Normal: the code runs inside CodeMini (it can see CodeMiniShield)', o);
  await page.evaluate(() => window.saveSetting('isolationConsole', 'Use global'));
  o = await run('typeof window.CodeMiniShield');
  ok(/"undefined"/.test(o), 'back to "Use global" (Isolated): it cannot', o);
  await page.evaluate(() => { window.saveSetting('isolationMode', 'Normal'); });
  o = await run('typeof window.CodeMiniShield');
  ok(/"object"/.test(o), 'the global mode Normal applies to the Console too', o);
  await page.evaluate(() => { window.saveSetting('isolationMode', 'Isolated'); window.saveSetting('isolationConsole', 'Use global'); });
  await ctx.close();

  console.log('\n[Console: the other three languages (stand-in engines)]');
  ({ ctx, page, errors } = await open(browser, RUNNER));
  run = await openConsole(page, 'Python');
  o = await run('print(2+2)', 2500); ok(/4/.test(o), 'Python: stdout is shown', o);
  o = await run('1+1'); ok(/2/.test(o.split('\n').slice(-3).join('\n')), 'Python: the result value is shown', o);
  o = await run('raise ValueError("boom")'); ok(/\[Python Error\][\s\S]*ValueError: boom/.test(o), 'Python: an error shows its traceback text', o);
  o = await run("print('plot')");
  ok(await page.evaluate(() => [...document.querySelectorAll('.console-output')].pop().querySelectorAll('img[src^="data:image/png;base64,QUJD"]').length) === 1, 'Python: a plot is rendered as an image', o);
  // display_html is the one path where output produced on the runner is rendered AS HTML in CodeMini's own page, so it must be
  // sanitized even though this Console is Trusted (the default; "Trusted" must not let sandboxed code run scripts in the app's origin).
  // The stand-in hands unknown code to eval, so this calls the runner's own display_html hook (py.g_display_html) with hostile HTML.
  await page.evaluate(() => { window.__pwn = 0; });
  o = await run(`py.g_display_html('<b>bold</b><img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script><a href="javascript:window.__pwn=3">link</a>')`, 1800);
  await sleep(800); // an image error handler would fire asynchronously
  const dh = await page.evaluate(() => {
    const last = [...document.querySelectorAll('.console-output')].pop();
    return { pwn: window.__pwn, bold: last.querySelectorAll('b').length,
      script: last.querySelectorAll('script').length, handler: last.querySelectorAll('[onerror]').length,
      jsHref: [...last.querySelectorAll('a')].filter(a => /^\s*javascript:/i.test(a.getAttribute('href') || '')).length };
  });
  ok(dh.bold === 1, 'Python display_html: harmless HTML is rendered (bold)', JSON.stringify(dh));
  ok(dh.pwn === 0, 'Python display_html: hostile HTML ran nothing in CodeMini (window.__pwn is still 0)', JSON.stringify(dh));
  ok(dh.script === 0 && dh.handler === 0 && dh.jsHref === 0, 'Python display_html: <script>, on* handlers and javascript: links are stripped even in a Trusted Console', JSON.stringify(dh));
  // Variables Explorer, Isolated: the Console's own Refresh must read the HOST's interpreter and never the in-app Pyodide. In 1.3.1 the
  // notebook's page-wide .vars-refresh handler also ran on a Console, asked the in-app Python and wrote its answer over the Console's list.
  await page.evaluate(() => { window.__inAppPy = 0; window.__origGetPy = window.getPyodideInstance; window.getPyodideInstance = async () => { window.__inAppPy++; return null; }; });
  const lastConsole = '[...document.querySelectorAll(".console-container")].pop()';
  // run() returns the Console's whole history; these checks read only the LAST output block, so an old timestamp or "executed in 19ms" cannot satisfy them.
  const lastBlock = () => page.evaluate(`[...${lastConsole}.querySelectorAll('.output-block')].pop().innerText`);
  await page.evaluate(`${lastConsole}.querySelector('.tb-vars').click()`); await sleep(1500);
  await page.evaluate(`${lastConsole}.querySelector('.vars-refresh').click()`); await sleep(1500);
  const vx = await page.evaluate(`({ text: ${lastConsole}.querySelector('.vars-content').innerText, inApp: window.__inAppPy })`);
  ok(/host_var/.test(vx.text), "Variables Explorer (Isolated Python): Refresh lists the host interpreter's variables", JSON.stringify(vx));
  ok(vx.inApp === 0, 'Variables Explorer (Isolated Python): Refresh never asks the in-app Pyodide', JSON.stringify(vx));
  await page.evaluate(() => { window.getPyodideInstance = window.__origGetPy; });

  // ainput asks the APP (exec-prompt -> exec-prompt reply) and the answer reaches Python; a cancelled prompt answers "" and must not hang the host.
  await page.evaluate(() => { window.__asked = null; window.__origPrompt = window.prompt; window.prompt = (t) => { window.__asked = t; return '19'; }; });
  await run('py.g_ainput("age? ")', 1500); o = await lastBlock();
  ok(/^'?19'?$/m.test(o) && (await page.evaluate(() => window.__asked)) === 'age? ', 'ainput: the app is asked the question and the answer comes back to Python', o);
  await page.evaluate(() => { window.prompt = () => null; });
  await run('py.g_ainput("again? ")', 1500);
  await run('print(2)', 1500); o = await lastBlock(); ok(/^2$/m.test(o), 'a cancelled ainput answers "" and the host is not stuck (the next command runs)', o);
  await page.evaluate(() => { window.prompt = window.__origPrompt; });

  // input() is a real dialog opened by the runner frame itself (its sandbox has allow-modals).
  let dialogText = null;
  page.once('dialog', async (d) => { dialogText = d.message(); await d.accept('7'); });
  await run('py.g_custom_input("n? ")', 1800); o = await lastBlock();
  ok(/^'?7'?$/m.test(o) && dialogText === 'n? ', 'input(): the runner frame opens the dialog and the typed answer comes back to Python', JSON.stringify({ o, dialogText }));

  run = await openConsole(page, 'PHP');
  o = await run('echo "hello";', 2500); ok(/hello/.test(o), 'PHP: output is shown', o);
  o = await run('trigger_error("x");'); ok(/PHP Fatal: boom/.test(o), 'PHP: errors the engine reports are shown', o);
  run = await openConsole(page, 'Ruby');
  o = await run('puts "hi from ruby"', 2500); ok(/hi from ruby/.test(o), 'Ruby: output is shown', o);
  o = await run('1 + 1'); ok(/2/.test(o), 'Ruby: the result is shown', o);
  o = await run('raise "x"'); ok(/\[Ruby Error\] RuntimeError: boom/.test(o), 'Ruby: errors are shown', o);
  ok(framesOfHosts(page).length === 1, 'all four languages share ONE host for the window (so the Console and Terminal share state)');
  const bad2 = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(bad2.length === 0, 'no page errors', bad2);

  console.log('\n[Terminal]');
  // State set in the JavaScript Console of THIS page, to be read back from the Terminal (they must share one host per window).
  // (An earlier version of this test read a variable that had only ever been set in a different, already closed page.)
  const jsConsole = await openConsole(page, 'JavaScript'); await jsConsole('var kept = 41');
  await page.evaluate(() => document.getElementById('terminalIconItem').click()); await sleep(1500);
  // The page has TWO ".term-input"/".term-output" pairs: the Terminal window's and the Live Preview console's (#lpConsoleInput /
  // #lpConsoleContent, which comes later in the DOM). An earlier version of this helper took the LAST match and so drove the Preview
  // console, not the Terminal. Always scope to the Terminal window ([data-term-index]).
  const TERM = '[data-term-index]';
  const termText = () => page.evaluate((T) => [...document.querySelectorAll(T + ' .term-output')].pop().innerText, TERM);
  // Runs a command and returns ONLY what the Terminal printed after the echoed command line (the echo itself contains the command,
  // so searching the whole output gives false passes: HANDOVER lesson 10). Returns null if the echo is missing (nothing was typed here).
  const term = async (cmd, wait) => {
    const before = (await termText()).length;
    await page.evaluate(([cmd, T]) => { const i = [...document.querySelectorAll(T + ' .term-input')].pop(); i.value = cmd; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, [cmd, TERM]);
    await sleep(wait || 1500);
    const delta = (await termText()).slice(before);
    const at = delta.indexOf('$ ' + cmd);
    return at < 0 ? null : delta.slice(at + 2 + cmd.length).trim();
  };
  const has = (o, re) => o !== null && re.test(o);

  // Harness proof first: with the Terminal pinned to Normal (the original in-app code), a command must print its result.
  await page.evaluate(() => window.saveSetting('isolationTerminal', 'Normal'));
  o = await term('js 6 * 7');
  ok(o !== null, 'harness: the command was echoed in the Terminal window itself (not the Preview console)', o);
  ok(has(o, /^42$/), 'Terminal set to Normal: js 6 * 7 prints exactly 42 (proves the harness)', o);
  o = await term('js typeof window.CodeMiniShield'); ok(has(o, /object/), 'Terminal set to Normal: js runs inside CodeMini (it can see CodeMiniShield)', o);
  await page.evaluate(() => window.saveSetting('isolationTerminal', 'Use global')); // global = Isolated

  o = await term('js 6 * 7'); ok(has(o, /42/), 'js: an expression is evaluated on the host', o);
  o = await term('js typeof window.CodeMiniShield'); ok(has(o, /undefined/), 'js: and it cannot see CodeMini', o);
  o = await term('js kept + 2'); ok(has(o, /43/), 'the Terminal shares JavaScript state with the Console (same host)', o);
  o = await term('python -c print(5)'); ok(has(o, /5/), 'python -c prints its output', o);
  // The snippet is quoted as in a real shell: unquoted, the Terminal's parser strips the double quotes (and splits at the ";"), so the
  // engine would receive `echo x1` instead of `echo "x1";`.
  o = await term(`php -r 'echo "x1";'`); ok(has(o, /x1/), 'php -r prints its output', o);
  o = await term(`ruby -e 'puts "r1"'`); ok(has(o, /r1/), 'ruby -e prints its output', o);
  await page.evaluate(() => window.saveSetting('isolationTerminal', 'Normal'));
  o = await term('js typeof window.CodeMiniShield'); ok(has(o, /object/), 'Terminal set to Normal again: js runs inside CodeMini', o);
  await page.evaluate(() => window.saveSetting('isolationTerminal', 'Use global'));

  console.log('\n[running script files from the Terminal]');
  await page.evaluate(async () => {
    const put = (r) => new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put(r); tx.oncomplete = res; });
    await put({ id: 'f_js', parentId: 'root', name: 'a.js', type: 'file', content: "console.log('from a.js'); 6 * 7", timestamp: Date.now() });
    await put({ id: 'f_py', parentId: 'root', name: 'a.py', type: 'file', content: 'print("from a.py")', timestamp: Date.now() });
    loadFilesFromDB();
  }); await sleep(800);
  o = await term('./a.js', 2200);
  // Workspace Trust has its own suite (terminal-trust.e2e.js). Here the run must actually work: accepting "or blocked by Trust" would let a
  // broken run pass and silently skip the .py checks below.
  ok(has(o, /from a\.js/), './a.js runs on the host', o);
  {
    ok(has(o, /42/), './a.js: its result is printed too', o);
    // Only .sh and .js files are executable by default; like in a real shell, a .py file needs chmod +x before ./a.py ("Permission denied" otherwise).
    await term('chmod +x a.py');
    o = await term('./a.py x y', 2200); ok(has(o, /from a\.py/) && has(o, /argv=\["python","a\.py","x","y"\]/), './a.py runs, and its arguments reach sys.argv (python, a.py, x, y)', o);
  }

  console.log('\n[the host goes away with its window]');
  ok(framesOfHosts(page).length === 1, 'there is one host');
  await page.evaluate(() => window.forceCloseEnvironments('win_default', true)); await sleep(500);
  ok(framesOfHosts(page).length === 0, 'closing the window removes the host');
  o = await term('js 1 + 1'); ok(has(o, /2/) && framesOfHosts(page).length === 1, 'and the next command starts a fresh host', o);
  await ctx.close();

  console.log('\n[Stop really stops a runaway command (Isolated)]');
  ({ ctx, page, errors } = await open(browser, RUNNER));
  const stopOf = '[...document.querySelectorAll(".console-container")].pop().querySelector(".stop-btn")';
  // A command that never finishes: JavaScript awaiting a promise nobody resolves.
  run = await openConsole(page, 'JavaScript');
  await run('var kept = 41');
  ok(framesOfHosts(page).length === 1, 'there is a host, holding the window\'s state');
  await run('await new Promise(() => {})', 700);
  ok(await page.evaluate(`!${stopOf}.classList.contains('disabled')`), 'while the command runs, Stop is enabled');
  await page.evaluate(`${stopOf}.click()`); await sleep(1000);
  let stop = await page.evaluate(() => { const blocks = [...document.querySelectorAll('.console-container')].pop().querySelectorAll('.output-block'); return { text: blocks[blocks.length - 1].innerText, n: blocks.length }; });
  ok(framesOfHosts(page).length === 0, 'Stop shut the runaway host down');
  ok((stop.text.match(/Execution Interrupted/g) || []).length === 1, 'the command\'s own block says "Execution Interrupted", once', stop.text);
  ok(!/System Error|host was closed|ran inside CodeMini/.test(stop.text), 'it is not shown as an error and it did not fall back to the in-app engine', stop.text);
  ok(await page.evaluate(`${stopOf}.classList.contains('disabled')`), 'afterwards the Console is idle again (Stop disabled)');
  await run('typeof kept', 1500);
  stop = await page.evaluate(() => { const blocks = [...document.querySelectorAll('.console-container')].pop().querySelectorAll('.output-block'); return blocks[blocks.length - 1].innerText; });
  ok(/undefined/.test(stop) && framesOfHosts(page).length === 1, 'the next command starts a fresh host (the old variables are gone)', stop);
  // Python waiting forever for an answer to ainput(): the same Stop ends it.
  await page.evaluate(() => { window.inlineInputPrompt = () => new Promise(() => {}); });
  run = await openConsole(page, 'Python');
  await run('py.g_ainput("never answered? ")', 700);
  await page.evaluate(`${stopOf}.click()`); await sleep(1000);
  stop = await page.evaluate(() => { const blocks = [...document.querySelectorAll('.console-container')].pop().querySelectorAll('.output-block'); return blocks[blocks.length - 1].innerText; });
  ok(/Execution Interrupted/.test(stop) && !/System Error/.test(stop), 'Python waiting for an answer is stopped the same way', stop);
  ok(await page.evaluate(`${stopOf}.classList.contains('disabled')`), 'and that Console is idle again');
  // Normal mode keeps the old behaviour: Stop only releases the UI (code inside CodeMini cannot be interrupted from outside).
  // (A fresh page, so that the JavaScript Console is the only one: openConsole's helpers always address the LAST console in the page.)
  await ctx.close();
  ({ ctx, page, errors } = await open(browser, RUNNER));
  await page.evaluate(() => window.saveSetting('isolationConsole', 'Normal'));
  run = await openConsole(page, 'JavaScript');
  const framesBefore = framesOfHosts(page).length;
  await run('await new Promise(() => {})', 700);
  ok(await page.evaluate(`!${stopOf}.classList.contains('disabled')`), 'Normal mode: while a command runs, Stop is enabled');
  await page.evaluate(`${stopOf}.click()`); await sleep(600);
  stop = await page.evaluate(() => { const blocks = [...document.querySelectorAll('.console-container')].pop().querySelectorAll('.output-block'); return { text: blocks[blocks.length - 1].innerText, n: blocks.length }; });
  ok(/Execution Interrupted/.test(stop.text) && await page.evaluate(`${stopOf}.classList.contains('disabled')`), 'Normal mode: Stop keeps its old role (it releases the UI and says "Execution Interrupted")', JSON.stringify(stop));
  ok(framesOfHosts(page).length === framesBefore, 'Normal mode: Stop touches no runner host', String(framesOfHosts(page).length));
  await ctx.close();

  console.log('\n[Editor Run (the bottom-panel Console) goes through the host]');
  ({ ctx, page, errors } = await open(browser, RUNNER));
  const bpLast = () => page.evaluate(() => { const o = document.getElementById('bpConsoleOutput'); return o.lastElementChild ? o.lastElementChild.innerText : ''; });
  const bpAll = () => page.evaluate(() => document.getElementById('bpConsoleOutput').innerText);
  const bpRun = async (code, ext, wait) => { await page.evaluate(([c, e]) => { window.runInBottomConsole(c, e); }, [code, ext]); await sleep(wait || 2500); };
  // Before this change a .js file was evaluated with eval.call(window, ...): in the app's own global scope.
  await bpRun('window.__editorMark = 1; typeof window.CodeMiniShield', 'js');
  let last = await bpLast();
  ok(/^undefined$/.test(last), 'Editor Run (JavaScript, Isolated): the code cannot see CodeMini (typeof CodeMiniShield is undefined)', last);
  const leak = await page.evaluate(() => typeof window.__editorMark);
  ok(leak === 'undefined' && framesOfHosts(page).length === 1, 'Editor Run (JavaScript, Isolated): it ran on the runner host and set nothing on the app\'s window', JSON.stringify({ leak, hosts: framesOfHosts(page).length }));
  await bpRun('print(2+2)', 'py'); last = await bpLast(); ok(/^4$/.test(last), 'Editor Run (Python, Isolated): output is printed', last);
  await bpRun('echo "x1";', 'php'); last = await bpLast(); ok(/x1/.test(last), 'Editor Run (PHP, Isolated): output is printed', last);
  await bpRun('puts "r1"', 'rb'); last = await bpLast(); ok(/r1/.test(last), 'Editor Run (Ruby, Isolated): output is printed', last);
  // The bottom Console's own input field runs through the same function.
  await page.evaluate(() => { const i = document.getElementById('bpConsoleInput'); i.value = '6*7'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }); await sleep(2000);
  last = await bpLast(); ok(/^42$/.test(last), 'the bottom Console input field also runs on the host', last);
  // Stop really ends a runaway run (same machinery as the Console's Stop).
  await page.evaluate(() => { window.runInBottomConsole('await new Promise(() => {})', 'js'); }); await sleep(900);
  const stopState = await page.evaluate(() => ({ stop: !document.getElementById('bpConsoleStopBtn').classList.contains('disabled'), play: !document.getElementById('bpConsolePlayBtn').classList.contains('disabled') }));
  ok(stopState.stop && !stopState.play, 'while an editor run is going, Stop is enabled and Play is not', JSON.stringify(stopState));
  await page.evaluate(() => document.getElementById('bpConsoleStopBtn').click()); await sleep(1000);
  const afterStop = await bpAll();
  const idle = await page.evaluate(() => ({ stop: document.getElementById('bpConsoleStopBtn').classList.contains('disabled'), play: !document.getElementById('bpConsolePlayBtn').classList.contains('disabled') }));
  ok(framesOfHosts(page).length === 0, 'Editor Run: Stop shut the runaway host down');
  ok((afterStop.match(/Execution Interrupted/g) || []).length === 1 && !/System Error/.test(afterStop), 'Editor Run: Stop reports "Execution Interrupted" once, not an error');
  ok(idle.stop && idle.play, 'Editor Run: afterwards Play is available and Stop is disabled again', JSON.stringify(idle));
  // Normal mode keeps the in-app engine.
  await page.evaluate(() => window.saveSetting('isolationConsole', 'Normal'));
  await bpRun('typeof window.CodeMiniShield', 'js', 1200); last = await bpLast();
  ok(/^object$/.test(last) && framesOfHosts(page).length === 0, 'Editor Run (Normal mode): runs inside CodeMini as before, with no host', JSON.stringify({ last, hosts: framesOfHosts(page).length }));
  await ctx.close();

  console.log('\n[Debug runs on the host]');
  ({ ctx, page, errors } = await open(browser, RUNNER));
  const dbgLog = () => page.evaluate(() => window.debugLogRegistry[window._getEditorWinId()] || '');
  const dbgPanel = () => page.evaluate(() => document.getElementById('debugPanelContent').innerText);
  // updateDebugPanel reads the active tab's file name and needs the Debug panel to be open: make both so.
  const dbgSetup = (name) => page.evaluate((n) => {
    document.getElementById('debugPanelContent').style.display = 'block';
    const pane = document.querySelector('.content-pane.active'); const tab = document.querySelector('.tab[data-target="' + pane.id + '"]');
    tab.querySelector('span').textContent = n;
  }, name);
  const dbgRun = async (ext, code, bps) => { await page.evaluate(([e, c, b]) => { window._runDebugCore(window._getEditorWinId(), 'dbg.' + e, e, c, b); }, [ext, code, bps || []]); await sleep(2300); };
  // JavaScript: before this change the file ran in the app's scope, with console.log and console.error of the APP patched meanwhile.
  await dbgSetup('dbg.js');
  await page.evaluate(() => window.updateDebugPanel()); await sleep(900);
  ok(framesOfHosts(page).length === 0, 'opening the Debug panel does not start a host just to list variables');
  await dbgRun('js', 'var dbgVar = 5; console.log("dbg hi", typeof window.CodeMiniShield);', [1]);
  let dl = await dbgLog();
  ok(/\[Log\] dbg hi undefined/.test(dl), 'Debug (JavaScript, Isolated): the file runs on the host (it cannot see CodeMini) and its console output is logged', dl.slice(-300));
  ok((await page.evaluate(() => typeof window.dbgVar)) === 'undefined' && framesOfHosts(page).length === 1, 'Debug (JavaScript, Isolated): nothing is set on the app\'s window, and one host is in use');
  let panel = await dbgPanel();
  ok(/dbgVar/.test(panel) && /\b5\b/.test(panel), 'Debug (JavaScript): the Variables panel lists the host\'s variables', panel.slice(0, 300));
  ok(!/appSettings|breakpointRegistry|debugLogRegistry|CodeMiniShield/.test(panel), 'Debug (JavaScript): the Variables panel does not list the app\'s own globals', panel.slice(0, 300));
  // Python
  await dbgSetup('dbg.py');
  await dbgRun('py', 'print(6*7)');
  dl = await dbgLog();
  ok(/42/.test(dl.slice(dl.lastIndexOf('[Start]'))) && /\[Finished\] Python debug execution/.test(dl), 'Debug (Python, Isolated): output is logged and the run finishes', dl.slice(-300));
  panel = await dbgPanel();
  ok(/host_var/.test(panel), 'Debug (Python): the Variables panel lists the host interpreter\'s variables', panel.slice(0, 300));
  // The names and values come from the sandbox, so they must be escaped.
  await page.evaluate(() => { window.__pwn = 0; });
  await dbgRun('py', '(py.__vars = [{"name": "<img src=x onerror=window.__pwn=7>", "type": "str", "value": "\\"><script>window.__pwn=8</script>"}])');
  await sleep(600);
  const hostile = await page.evaluate(() => { const p = document.getElementById('debugPanelContent'); return { pwn: window.__pwn, imgs: p.querySelectorAll('img').length, scripts: p.querySelectorAll('.debug-sidebar script').length, text: p.innerText }; });
  ok(hostile.pwn === 0 && hostile.imgs === 0 && hostile.scripts === 0, 'Debug (Python): a hostile variable name or value runs nothing and creates no element in the panel', JSON.stringify(hostile).slice(0, 300));
  ok(hostile.text.indexOf('<img src=x onerror=window.__pwn=7>') > -1, 'Debug (Python): ... it is shown as plain text instead', hostile.text.slice(0, 200));
  // Normal mode keeps the in-app engine
  await page.evaluate(() => window.saveSetting('isolationConsole', 'Normal'));
  await page.evaluate(() => { window._debugHostUsed = {}; });
  await dbgSetup('dbg.js');
  await dbgRun('js', 'console.log("normal", typeof window.CodeMiniShield);');
  dl = await dbgLog();
  ok(/\[Log\] normal object/.test(dl), 'Debug (Normal mode): runs inside CodeMini as before', dl.slice(-200));
  await ctx.close();

  console.log('\n[Notebook Python cells run on the host]');
  ({ ctx, page, errors } = await open(browser, RUNNER));
  // The notebook pane is built from the app's own template (with its first cell); Monaco is replaced by a fake editor, and the in-app interpreter is
  // replaced by a counter so that any use of it in Isolated mode is caught.
  await page.evaluate(() => {
    window.__nbInApp = 0; window.getPyodideInstance = async () => { window.__nbInApp++; return null; };
    const pane = document.createElement('div'); pane.id = 'nbpane'; pane.className = 'content-pane active'; pane.innerHTML = window.getNotebookHTML('python');
    document.body.appendChild(pane); window.cellMonacoEditors = window.cellMonacoEditors || {}; window.__pwn = 0;
  });
  const nbRun = async (code, wait) => { await page.evaluate((c) => { const pane = document.getElementById('nbpane'); const cell = pane.querySelector('.cell'); window.cellMonacoEditors[cell.dataset.cellId] = { getValue: () => c }; window.runCell(cell, pane); }, code); await sleep(wait || 1800); };
  const nbOut = () => page.evaluate(() => { const w = document.querySelector('#nbpane .cell-output-wrapper'); return w ? w.innerText : ''; });
  const nbClick = (sel) => page.evaluate((s) => document.querySelector('#nbpane ' + s).click(), sel);
  let nbo;
  await nbRun('print(6*7)'); nbo = await nbOut();
  ok(/(^|\n)42(\n|$)/.test(nbo) && framesOfHosts(page).length === 1, 'Notebook (Isolated): a Python cell runs on the host and prints its output', nbo.slice(0, 200));
  ok((await page.evaluate(() => window.__nbInApp)) === 0, 'Notebook (Isolated): the in-app interpreter is never used');
  // Everything from the sandbox is untrusted.
  await nbRun('print("<img src=x onerror=window.__pwn=1>")'); nbo = await nbOut();
  const esc1 = await page.evaluate(() => ({ imgs: document.querySelectorAll('#nbpane .cell-output-wrapper img').length, pwn: window.__pwn }));
  ok(esc1.imgs === 0 && esc1.pwn === 0 && nbo.indexOf('<img src=x onerror=window.__pwn=1>') > -1, 'Notebook (Isolated): hostile output is shown as text and runs nothing', JSON.stringify(esc1));
  await nbRun(`py.g_display_html('<b>bold</b><img src=x onerror="window.__pwn=2"><script>window.__pwn=3</script>')`);
  const dh2 = await page.evaluate(() => { const d = document.querySelector('#nbpane .custom-display'); return { has: !!d, bold: d ? d.querySelectorAll('b').length : 0, bad: d ? [...d.querySelectorAll('*')].filter((n) => n.tagName === 'SCRIPT' || [...n.attributes].some((a) => /^on/i.test(a.name))).length : -1, pwn: window.__pwn }; });
  ok(dh2.has && dh2.bold === 1 && dh2.bad === 0 && dh2.pwn === 0, 'Notebook (Isolated): display_html is sanitized (bold stays; scripts and handlers do not run)', JSON.stringify(dh2));
  await nbRun('print("plot")');
  ok(await page.evaluate(() => !!document.querySelector('#nbpane img[src*="base64,QUJD"]')), 'Notebook (Isolated): a plot from the host is shown');
  await page.evaluate(() => { window.__asked = null; window.inlineInputPrompt = (t) => { window.__asked = t; return Promise.resolve('19'); }; });
  await nbRun('py.g_ainput("age? ")'); nbo = await nbOut();
  ok(/(^|\n)19(\n|$)/.test(nbo) && (await page.evaluate(() => window.__asked)) === 'age? ', 'Notebook (Isolated): ainput asks the app and the answer reaches Python', nbo.slice(0, 200));
  await nbRun('%time print(1)'); nbo = await nbOut();
  ok(/CPU times: user/.test(nbo) && /(^|\n)1(\n|$)/.test(nbo), 'Notebook (Isolated): the %time magic still reports', nbo.slice(0, 200));
  await nbRun('!pip install foo\nprint(5)', 2500); nbo = await nbOut();
  await nbRun('JSON.stringify(py.__codes.filter(c => /micropip/.test(c)))'); const codesOut = await nbOut();
  ok(/micropip/.test(codesOut) && /foo/.test(codesOut) && /(^|\n)5(\n|$)/.test(nbo), '!pip install is sent to the host (micropip), and the rest of the cell still runs', (nbo + ' || ' + codesOut).slice(0, 300));
  await page.evaluate(() => { window.installPackage('barpkg', 'python'); }); await sleep(1800);
  // (a different string than the first dump: runCell skips a cell whose code has not changed since its last run)
  await nbRun('JSON.stringify(py.__codes.filter(c => /micropip.install/.test(c)))'); const codes2 = await nbOut();
  ok(/micropip/.test(codes2) && /barpkg/.test(codes2) && (await page.evaluate(() => window.__nbInApp)) === 0, 'The package manager installs inside the host (not in the app)', codes2.slice(-200));
  // Variables Explorer: the host's variables, and nothing the host says can reach the page as markup.
  await page.evaluate(() => window.updateVariablesExplorer(document.getElementById('nbpane'))); await sleep(1500);
  let vtxt = await page.evaluate(() => document.querySelector('#nbpane .vars-content').innerText);
  ok(/host_var/.test(vtxt), 'Notebook Variables Explorer (Isolated): lists the host interpreter\'s variables', vtxt.slice(0, 200));
  await nbRun(`(py.__vars = [{"name": "<img src=x onerror=window.__pwn=4>", "type": "str", "value": "\\" onmouseover=\\"window.__pwn=5\\" x=\\""}, {"name": "ent", "type": "str", "value": "&lt;b&gt;"}])`);
  await page.evaluate(() => window.updateVariablesExplorer(document.getElementById('nbpane'))); await sleep(1500);
  const hv = await page.evaluate(() => { const c = document.querySelector('#nbpane .vars-content'); return { imgs: c.querySelectorAll('img').length, handlers: c.querySelectorAll('[onmouseover]').length, pwn: window.__pwn, text: c.innerText }; });
  ok(hv.imgs === 0 && hv.handlers === 0 && hv.pwn === 0 && hv.text.indexOf('<img src=x onerror=window.__pwn=4>') > -1 && hv.text.indexOf('&lt;b&gt;') > -1, 'Notebook Variables Explorer: hostile names and values are shown as text and run nothing, and an entity-looking value is shown literally', JSON.stringify(hv).slice(0, 300));
  // Restart gives the window a fresh Python session on the host (the host itself stays).
  await nbRun('String(py.__dicts)'); const d1 = parseInt((await nbOut()).match(/(^|\n)(\d+)(\n|$)/)[2], 10);
  await nbClick('.tb-restart'); await sleep(1500);
  await nbRun('String(py.__dicts) + " "'); const d2 = parseInt((await nbOut()).match(/(^|\n)(\d+) /)[2], 10);
  ok(d2 === d1 + 1 && framesOfHosts(page).length === 1, 'Notebook Restart: a fresh Python namespace on the host, and the host is kept', JSON.stringify({ d1, d2, hosts: framesOfHosts(page).length }));
  // Interrupt really ends a runaway cell.
  await page.evaluate(() => { window.inlineInputPrompt = () => new Promise(() => {}); });
  await nbRun('py.g_ainput("wait? ")', 800);
  await nbClick('.tb-interrupt'); await sleep(1200);
  nbo = await nbOut();
  ok(framesOfHosts(page).length === 0, 'Notebook Interrupt: the runaway host is shut down');
  ok((nbo.match(/Execution Interrupted/g) || []).length === 1 && /variables of its Python, R and SQL sessions were reset/.test(nbo) && !/Python host/.test(nbo) && !/Error:/.test(nbo), 'Notebook Interrupt: the cell says "Execution Interrupted" (and that the variables of the Python, R and SQL sessions were reset: the host serves all three, so it does not say "Python host"), not an error', nbo.slice(0, 250));
  await nbRun('print(8)'); nbo = await nbOut();
  ok(/(^|\n)8(\n|$)/.test(nbo) && framesOfHosts(page).length === 1, 'Notebook: the next cell starts a fresh host and runs', nbo.slice(0, 200));
  // The scratchpad (a quick-run panel of the notebook) used to execute Python in the app too.
  const spRun = async (code, wait) => { await page.evaluate((c) => { const pane = document.getElementById('nbpane'); window.__spCode = c; pane._spEditor = { getValue: () => window.__spCode }; pane.querySelector('.sp-run').click(); }, code); await sleep(wait || 1800); };
  const spOut = () => page.evaluate(() => document.querySelector('#nbpane .sp-output').innerText);
  const hostsBefore = framesOfHosts(page).length;
  await page.evaluate(() => { window.__nbInApp = 0; });
  await spRun('print(6*7)'); let spo = await spOut();
  ok(/(^|\n)42(\n|$)/.test(spo) && framesOfHosts(page).length === hostsBefore && (await page.evaluate(() => window.__nbInApp)) === 0, 'Scratchpad (Isolated): Python runs on the same host as the notebook cells, not in the app', JSON.stringify({ spo: spo.slice(0, 120), hosts: framesOfHosts(page).length, before: hostsBefore }));
  await spRun('print("plot")');
  ok(await page.evaluate(() => !!document.querySelector('#nbpane .sp-output img[src*="base64,QUJD"]')), 'Scratchpad (Isolated): a plot from the host is shown');
  await spRun('print("<img src=x onerror=window.__pwn=6>")'); spo = await spOut();
  const spEsc = await page.evaluate(() => ({ imgs: document.querySelectorAll('#nbpane .sp-output img').length, pwn: window.__pwn }));
  ok(spEsc.imgs === 0 && spEsc.pwn === 0 && spo.indexOf('<img src=x onerror=window.__pwn=6>') > -1, 'Scratchpad (Isolated): hostile output is shown as text and runs nothing', JSON.stringify(spEsc));
  await spRun('scratch_missing_name_zz'); spo = await spOut();
  ok(/scratch_missing_name_zz/.test(spo), 'Scratchpad (Isolated): an error from the host is shown', spo.slice(0, 160));
  // Normal mode keeps the in-app interpreter (here the counter stands in for it).
  await page.evaluate(() => window.saveSetting('isolationNotebooks', 'Normal'));
  await page.evaluate(() => { window.__nbInApp = 0; });
  await nbRun('print(9)'); nbo = await nbOut();
  ok((await page.evaluate(() => window.__nbInApp)) >= 1 && !/(^|\n)9(\n|$)/.test(nbo), 'Notebook (Normal mode): the in-app interpreter is used, as before', nbo.slice(0, 200));
  await page.evaluate(() => { window.__nbInApp = 0; });
  await spRun('print(10)'); spo = await spOut();
  ok((await page.evaluate(() => window.__nbInApp)) >= 1 && !/(^|\n)10(\n|$)/.test(spo), 'Scratchpad (Normal mode): the in-app interpreter is used, as before', spo.slice(0, 160));
  await ctx.close();

  console.log('\n[Notebook SQL cells run on the host]');
  ({ ctx, page, errors } = await open(browser, RUNNER));
  await page.evaluate(() => {
    const pane = document.createElement('div'); pane.id = 'sqlpane'; pane.className = 'content-pane active'; pane.innerHTML = window.getNotebookHTML('sql');
    document.body.appendChild(pane); window.cellMonacoEditors = window.cellMonacoEditors || {}; window.__pwn = 0;
  });
  const sqRun = async (code, wait) => { await page.evaluate((c) => { const pane = document.getElementById('sqlpane'); const cell = pane.querySelector('.cell'); window.cellMonacoEditors[cell.dataset.cellId] = { getValue: () => c }; window.runCell(cell, pane); }, code); await sleep(wait || 1800); };
  const sqOut = () => page.evaluate(() => { const w = document.querySelector('#sqlpane .cell-output-wrapper'); return w ? w.innerText : ''; });
  const sqTable = () => page.evaluate(() => { const t = document.querySelector('#sqlpane .sql-table-responsive'); if (!t) return null; const norm = (h) => h.replace(/sql-table-\d+-\d+/g, 'T').replace(/Cell \d+/g, 'Cell N'); return { ths: [...t.querySelectorAll('th')].map((n) => n.innerText), tds: [...t.querySelectorAll('td')].map((n) => n.innerText), bolds: t.querySelectorAll('b').length, imgs: document.querySelectorAll('#sqlpane .cell-output-wrapper img').length, html: norm(t.outerHTML + (t.nextElementSibling ? t.nextElementSibling.outerHTML : '')) }; });
  const hostDbs = () => page.evaluate(async () => { const r = await window.CodeMiniExec.run(window._getWinId(), { lang: 'javascript', code: 'String(window.__dbCount || 0)', opts: {} }, () => {}, () => Promise.resolve('')); return parseInt(r.value && r.value.text, 10) || 0; });
  let sq;
  await sqRun('SELECT 6*7 AS answer'); sq = await sqTable();
  ok(sq && sq.ths.join() === 'answer' && sq.tds.join() === '42' && framesOfHosts(page).length === 1, 'SQL cell (Isolated): the query runs and its table is shown', JSON.stringify(sq && { ths: sq.ths, tds: sq.tds }));
  ok((await page.evaluate(() => window.__dbCount || 0)) === 0 && (await hostDbs()) === 1, 'SQL cell (Isolated): the database lives on the host, and the in-app SQL engine was not used');
  const goldIso = sq && sq.html;
  await sqRun('SELECT hostile'); sq = await sqTable();
  const hostileOk = sq && sq.ths[0] === '<b>col</b>' && sq.tds.indexOf('<img src=x onerror=window.__pwn=7>') > -1 && sq.tds.indexOf('NULL') > -1 && sq.tds.indexOf('&lt;b&gt;') > -1 && sq.tds.indexOf('3.5') > -1 && sq.bolds === 0 && sq.imgs === 0;
  ok(hostileOk && (await page.evaluate(() => window.__pwn)) === 0, 'SQL cell (Isolated): hostile names and values are shown as text and run nothing; entity-looking text is shown literally; NULL is shown', JSON.stringify(sq && { ths: sq.ths, tds: sq.tds, bolds: sq.bolds, imgs: sq.imgs }));
  await sqRun('SELECT blob'); sq = await sqTable();
  ok(sq && sq.tds.join() === '1,2,3', 'SQL cell (Isolated): a BLOB is shown as its bytes, as before', JSON.stringify(sq && sq.tds));
  await sqRun('SELECT boom'); const sqe = await sqOut();
  ok(/near "boom": syntax error/.test(sqe) && !/Success \(no result/.test(sqe), 'SQL cell (Isolated): an SQL error is shown as the error (and not as a success)', sqe.slice(0, 200));
  // State lives in the host: a table survives between cells, the Variables Explorer lists it, and Restart gives a fresh database.
  await sqRun('CREATE TABLE people(x)'); const sqc = await sqOut();
  await page.evaluate(() => window.updateVariablesExplorer(document.getElementById('sqlpane'))); await sleep(1200);
  const vx1 = await page.evaluate(() => document.querySelector('#sqlpane .vars-content').innerText);
  ok(/Success/.test(sqc) && /people/.test(vx1), 'SQL (Isolated): a created table is kept on the host and listed by the Variables Explorer', (sqc + ' || ' + vx1).slice(0, 200));
  await page.evaluate(() => document.querySelector('#sqlpane .tb-restart').click()); await sleep(1500);
  await sqRun('SELECT 6*7 AS answer -- after restart'); await page.evaluate(() => window.updateVariablesExplorer(document.getElementById('sqlpane'))); await sleep(1200);
  const vx2 = await page.evaluate(() => document.querySelector('#sqlpane .vars-content').innerText);
  ok((await hostDbs()) === 2 && !/people/.test(vx2) && framesOfHosts(page).length === 1, 'SQL Restart: a fresh database on the host (the old table is gone) and the host is kept', JSON.stringify({ dbs: await hostDbs(), vx2: vx2.slice(0, 80) }));
  // The scratchpad
  const sqSp = async (code) => { await page.evaluate((c) => { const pane = document.getElementById('sqlpane'); window.__spCode = c; pane._spEditor = { getValue: () => window.__spCode }; pane.querySelector('.sp-run').click(); }, code); await sleep(1800); };
  await sqSp('SELECT hostile');
  const sps = await page.evaluate(() => { const o = document.querySelector('#sqlpane .sp-output'); return { text: o.innerText, imgs: o.querySelectorAll('img').length, bolds: o.querySelectorAll('b').length, pwn: window.__pwn }; });
  ok(/<b>col<\/b>/.test(sps.text) && /<img src=x onerror=window.__pwn=7>/.test(sps.text) && sps.imgs === 0 && sps.bolds === 0 && sps.pwn === 0 && (await hostDbs()) === 2, 'SQL scratchpad (Isolated): runs on the same host database and shows hostile data as text', JSON.stringify(sps).slice(0, 260));
  // Normal mode keeps the in-app engine, and produces the same table markup as the host path for safe data.
  await page.evaluate(() => window.saveSetting('isolationNotebooks', 'Normal'));
  await sqRun('SELECT 6*7 AS answer -- normal'); sq = await sqTable();
  ok(sq && sq.tds.join() === '42' && (await page.evaluate(() => window.__dbCount || 0)) >= 1, 'SQL cell (Normal mode): the in-app engine is used, as before', JSON.stringify(sq && sq.tds));
  ok(sq && goldIso && sq.html === goldIso, 'SQL cell: Normal mode and Isolated mode produce the same table markup for the same data', JSON.stringify({ same: sq && sq.html === goldIso, a: (sq && sq.html || '').slice(0, 160), b: (goldIso || '').slice(0, 160) }));
  await ctx.close();

  console.log('\n[Notebook R cells run on the host]');
  ({ ctx, page, errors } = await open(browser, RUNNER));
  await page.evaluate(() => {
    window.__rInApp = 0; window.getWebRInstance = async () => { window.__rInApp++; return null; };   // any use of the in-app webR in Isolated mode is caught
    const pane = document.createElement('div'); pane.id = 'rpane'; pane.className = 'content-pane active'; pane.innerHTML = window.getNotebookHTML('r');
    document.body.appendChild(pane); window.cellMonacoEditors = window.cellMonacoEditors || {}; window.__pwn = 0;
  });
  const rRun = async (code, wait) => { await page.evaluate((c) => { const pane = document.getElementById('rpane'); const cell = pane.querySelector('.cell'); window.cellMonacoEditors[cell.dataset.cellId] = { getValue: () => c }; window.runCell(cell, pane); }, code); await sleep(wait || 1800); };
  const rOut = () => page.evaluate(() => { const w = document.querySelector('#rpane .cell-output-wrapper'); return w ? w.innerText : ''; });
  const hostJs = (expr) => page.evaluate(async (e) => { const r = await window.CodeMiniExec.run(window._getWinId(), { lang: 'javascript', code: e, opts: {} }, () => {}, () => Promise.resolve('')); return r.value && r.value.text; }, expr);
  let ro;
  await rRun('cat("hello")'); ro = await rOut();
  ok(/hello/.test(ro) && framesOfHosts(page).length === 1 && (await hostJs('String(window.__webrCount || 0)')) === '1', 'R cell (Isolated): the code runs on the host (webR started there)', ro.slice(0, 160));
  ok((await page.evaluate(() => window.__rInApp)) === 0, 'R cell (Isolated): the in-app webR is never used');
  await rRun('x <- 5'); await rRun('x'); ro = await rOut();
  ok(/\[1\] 5/.test(ro), 'R (Isolated): variables are kept between cells (one environment per host)', ro.slice(0, 160));
  await rRun('cat("<img src=x onerror=window.__pwn=8>")'); ro = await rOut();
  const resc = await page.evaluate(() => ({ imgs: document.querySelectorAll('#rpane .cell-output-wrapper img').length, pwn: window.__pwn }));
  ok(resc.imgs === 0 && resc.pwn === 0 && ro.indexOf('<img src=x onerror=window.__pwn=8>') > -1, 'R cell (Isolated): hostile output is shown as text and runs nothing', JSON.stringify(resc));
  await rRun('plot(1)');
  ok(await page.evaluate(() => !!document.querySelector('#rpane img[src*="base64,QUJD"]')), 'R cell (Isolated): a plot from the host is shown');
  await rRun('plot_unreadable(1)'); ro = await rOut();
  ok(/R plot not read: EIO simulated/.test(ro) && !/Completed with no output/.test(ro), 'R cell (Isolated): a plot that cannot be read is reported in the cell, not swallowed as "no output"', ro.slice(0, 160));
  await rRun('stop("boom")'); ro = await rOut();
  ok(/boom/.test(ro), 'R cell (Isolated): an R error is shown', ro.slice(0, 160));
  await rRun('warning_out(1)'); ro = await rOut();
  ok(/Warning message: careful/.test(ro), 'R cell (Isolated): stderr output is shown', ro.slice(0, 160));
  await rRun('library(zzpkg)\ncat("ok")', 2200); ro = await rOut();
  ok(/ok/.test(ro) && /zzpkg/.test(await hostJs('JSON.stringify(window.__rInstalled || [])')), 'R cell (Isolated): library(x) packages are installed on the host (auto-install)', ro.slice(0, 120));
  await page.evaluate(() => { window.installPackage('cli', 'r'); }); await sleep(1800);
  ok(/"cli"/.test(await hostJs('JSON.stringify(window.__rInstalled || [])')) && (await page.evaluate(() => window.__rInApp)) === 0, 'The package manager installs R packages inside the host (not in the app)');
  // Restart gives a fresh R environment on the host (the host itself stays).
  await page.evaluate(() => document.querySelector('#rpane .tb-restart').click()); await sleep(1500);
  await rRun('x '); ro = await rOut();
  ok(/object 'x' not found/.test(ro) && framesOfHosts(page).length === 1 && Number(await hostJs('String(window.__rEnvCount || 0)')) >= 2, 'R Restart: a fresh environment on the host (the old variable is gone) and the host is kept', JSON.stringify({ ro: ro.slice(0, 120), envs: await hostJs('String(window.__rEnvCount || 0)') }));
  // The scratchpad (R's global environment, as before)
  await page.evaluate(() => { const pane = document.getElementById('rpane'); window.__spCode = 'cat("sp hello")\nplot(1)'; pane._spEditor = { getValue: () => window.__spCode }; pane.querySelector('.sp-run').click(); }); await sleep(1800);
  const rsp = await page.evaluate(() => { const o = document.querySelector('#rpane .sp-output'); return { text: o.innerText, img: !!o.querySelector('img[src*="base64,QUJD"]') }; });
  ok(/sp hello/.test(rsp.text) && rsp.img && (await page.evaluate(() => window.__rInApp)) === 0, 'R scratchpad (Isolated): runs on the host, with its plot, and not in the app', JSON.stringify(rsp).slice(0, 200));
  // Normal mode keeps the in-app webR (here the counter stands in for it)
  await page.evaluate(() => window.saveSetting('isolationNotebooks', 'Normal')); await page.evaluate(() => { window.__rInApp = 0; });
  await rRun('cat("normal")'); ro = await rOut();
  ok((await page.evaluate(() => window.__rInApp)) >= 1 && (await hostJs('String(window.__webrCount || 0)')) === '1' && !/(^|\n)normal(\n|$)/.test(ro), 'R cell (Normal mode): the in-app webR is used, as before', ro.slice(0, 160));
  await ctx.close();

  console.log('\n[Notebook R cells in Normal mode: the in-app webR (here the stand-in), plots included]');
  // This path once called FS.readdir, which real webR does not have: on a phone every plot ended in "no output" and nothing said why.
  // The app's service worker would answer the in-app import of webR itself, and the test routes do not see a service worker's requests: block it here.
  ({ ctx, page, errors } = await open(browser, RUNNER, null, undefined, { serviceWorkers: 'block' }));
  await page.evaluate(() => {
    const pane = document.createElement('div'); pane.id = 'rpane'; pane.className = 'content-pane active'; pane.innerHTML = window.getNotebookHTML('r');
    document.body.appendChild(pane); window.cellMonacoEditors = window.cellMonacoEditors || {};
    window.saveSetting('isolationNotebooks', 'Normal');
  });
  const rShow = () => page.evaluate(() => { const w = document.querySelector('#rpane .cell-output-wrapper'); return { img: !!(w && w.querySelector('img[src*="base64,QUJD"]')), text: w ? w.innerText : '' }; });
  await rRun('plot(1)', 3500); let nr = await rShow();
  ok(nr.img && !/R plot not read/.test(nr.text), 'R cell (Normal mode): the plot comes back, through the file listing', JSON.stringify(nr).slice(0, 200));
  await rRun('plot_unreadable(1)', 3000); nr = await rShow();
  ok(/R plot not read: EIO simulated/.test(nr.text) && !/Completed with no output/.test(nr.text), 'R cell (Normal mode): a plot that cannot be read is reported in the cell, not swallowed', JSON.stringify(nr).slice(0, 200));
  await page.evaluate(() => { const pane = document.getElementById('rpane'); window.__spCode = 'cat("sp normal")\nplot(1)'; pane._spEditor = { getValue: () => window.__spCode }; pane.querySelector('.sp-run').click(); }); await sleep(3000);
  const nsp = await page.evaluate(() => { const o = document.querySelector('#rpane .sp-output'); return { text: o.innerText, img: !!o.querySelector('img[src*="base64,QUJD"]') }; });
  ok(/sp normal/.test(nsp.text) && nsp.img && !/R plot not read/.test(nsp.text), 'R scratchpad (Normal mode): the plot comes back, through the file listing', JSON.stringify(nsp).slice(0, 200));
  await ctx.close();

  console.log('\n[an older runner that does not know SQL]');
  // Simulated by serving the runner's own exec.js with the sql language removed: the app and the runner deploy separately.
  ({ ctx, page, errors } = await open(browser, RUNNER));
  const oldExec = require('fs').readFileSync(require('../lib/paths').resolve('runner/exec.js'), 'utf8').replace('ruby: 1, sql: 1, r: 1 }', 'ruby: 1 }');
  ok(oldExec.indexOf('sql: 1') === -1 && oldExec.indexOf(' r: 1') === -1, 'the simulated older runner really has neither the sql nor the r language');
  await page.route(RUNNER + '/exec.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: oldExec }));
  await page.evaluate(() => {
    const pane = document.createElement('div'); pane.id = 'sqlpane'; pane.className = 'content-pane active'; pane.innerHTML = window.getNotebookHTML('sql');
    document.body.appendChild(pane); window.cellMonacoEditors = window.cellMonacoEditors || {};
  });
  await page.evaluate(() => { const pane = document.getElementById('sqlpane'); const cell = pane.querySelector('.cell'); window.cellMonacoEditors[cell.dataset.cellId] = { getValue: () => 'SELECT 6*7 AS answer' }; window.runCell(cell, pane); }); await sleep(2200);
  const oldOut = await page.evaluate(() => document.querySelector('#sqlpane .cell-output-wrapper').innerText);
  ok(/older than this version/.test(oldOut) && /Notebooks to Normal/.test(oldOut), 'SQL cell against an older runner: a clear message says what to do instead of "unsupported language or code"', oldOut.slice(0, 260));
  await page.evaluate(() => {
    const pane = document.createElement('div'); pane.id = 'rpane'; pane.className = 'content-pane active'; pane.innerHTML = window.getNotebookHTML('r');
    document.body.appendChild(pane);
    const cell = pane.querySelector('.cell'); window.cellMonacoEditors[cell.dataset.cellId] = { getValue: () => 'cat("x")' }; window.runCell(cell, pane);
  }); await sleep(2200);
  const oldROut = await page.evaluate(() => document.querySelector('#rpane .cell-output-wrapper').innerText);
  ok(/older than this version/.test(oldROut) && /does not know R yet/.test(oldROut), 'R cell against an older runner: the same clear message', oldROut.slice(0, 260));
  await ctx.close();

  console.log('\n[the runner says which version it is; the app does not use one that is too old, and says why]');
  // Real browser, the real runner. An old runner is simulated by serving its config.js with a different (or no) version, which is exactly what
  // an older deployment looks like: the app and the runner deploy separately (a runner from before version numbers sends nothing).
  const realConfig = require('fs').readFileSync(require('../lib/paths').resolve('runner/config.js'), 'utf8');
  const cm = /version:\s*(\d+),\s*build:\s*'([^']*)'/.exec(realConfig);
  if (!cm) throw new Error('runner/config.js has no "version: N, build: \'YYYY-MM-DD\'" line: the runner in this repository is older than the app. This repository\'s runner/ folder is a copy of the CodeMini-Runner repository: copy the current config.js, exec.js and shell.js into it.');
  ok(!!cm, 'the runner config carries a version and a build');
  const realVersion = Number(cm[1]), realBuild = cm[2];
  const asConfig = (version, build) => realConfig.replace(/,\s*version:\s*\d+,\s*build:\s*'[^']*'/, version === null ? '' : ', version: ' + version + ', build: ' + JSON.stringify(build));
  ok(asConfig(null).indexOf('version:') === -1 && asConfig(3, 'x').indexOf('version: 3') > -1, 'the simulated configs really differ (none / version 3)');
  const serveConfig = (pg, body) => pg.route(RUNNER + '/config.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body }));
  const probe = (pg) => pg.evaluate(async () => {
    const used = await window.CodeMiniExec.use('console');
    // Callers ask for the notice only when use() said no (that is what fallbackNotice is for), so that is what is done here.
    return { used, note: used ? '' : window.CodeMiniExec.fallbackNotice('console'), info: window.CodeMiniRunner.runnerInfo(), check: await window.CodeMiniRunner.checkRunner() };
  });

  ({ ctx, page, errors } = await open(browser, RUNNER));
  let vr = await probe(page);
  ok(vr.used === true, 'current runner: the execution host is used (no fallback, so no notice to ask for)');
  ok(vr.info.exec && vr.info.exec.version === realVersion && vr.info.exec.build === realBuild, 'current runner: the app knows its version and build', JSON.stringify(vr.info.exec));
  ok(vr.info.needs.exec <= realVersion && vr.info.needs.exec >= 1, 'the app needs a version the repository runner has', JSON.stringify(vr.info.needs));
  ok(vr.check.state === 'ok' && /up to date/.test(vr.check.message) && vr.check.version === realVersion, 'Check runner on the current runner: up to date', vr.check.message);
  await ctx.close();

  ({ ctx, page, errors } = await open(browser, RUNNER));
  await serveConfig(page, asConfig(null));
  vr = await probe(page);
  ok(vr.used === false, 'a runner from before version numbers: the execution host is not used (code runs in the app instead)');
  ok(/out of date/.test(vr.note) && /before version numbers/.test(vr.note) && /needs version \d+ or newer/.test(vr.note) && /Redeploy the runner project \(codemini-runner\)/.test(vr.note), 'the one-time notice says the runner is out of date, why, and what to do', vr.note.slice(0, 260));
  ok(vr.info.exec && vr.info.exec.version === 0, 'a missing version counts as 0');
  ok(vr.check.state === 'outdated' && /^The runner is out of date/.test(vr.check.message), 'Check runner on an old runner: says it is out of date', vr.check.message);
  // The runner is redeployed: the next check sees it and the app uses it at once (no waiting out the retry delay, no reload).
  await page.unroute(RUNNER + '/config.js');
  const again = await page.evaluate(async () => { const c = await window.CodeMiniRunner.checkRunner(); return { c, used: await window.CodeMiniExec.use('console') }; });
  ok(again.c.state === 'ok' && again.used === true, 'after the runner is redeployed, Check runner finds it and the host is used straight away', JSON.stringify(again.c).slice(0, 160));
  await ctx.close();

  ({ ctx, page, errors } = await open(browser, RUNNER));
  await serveConfig(page, asConfig(realVersion - 1, '2026-01-02'));
  vr = await probe(page);
  ok(vr.used === false && vr.check.state === 'outdated' && vr.check.version === realVersion - 1 && vr.check.build === '2026-01-02', 'a numbered but older runner is refused too', JSON.stringify(vr.check).slice(0, 220));
  ok(new RegExp('version ' + (realVersion - 1) + ', built 2026-01-02').test(vr.note), 'the notice names the version and build it found', vr.note.slice(0, 200));
  await ctx.close();

  ({ ctx, page, errors } = await open(browser, RUNNER));
  await serveConfig(page, asConfig(99999, '<img src=x onerror=alert(1)>'));
  vr = await probe(page);
  ok(vr.info.exec && vr.info.exec.version === 0 && vr.info.exec.build === '', 'hostile values from a runner (a huge version, markup as the build) are dropped, not kept', JSON.stringify(vr.info.exec));
  ok(!/[<>]|onerror/.test(vr.note + vr.check.message), 'and they never reach the notice or the Settings message');
  await ctx.close();

  console.log('\n[runner unreachable: the code still runs, and says why]');
  ({ ctx, page, errors } = await open(browser, 'http://localhost:8767'));
  run = await openConsole(page, 'JavaScript');
  o = await run('1 + 1', 5000);
  ok(/2/.test(o), 'the command runs inside CodeMini as a fallback', o);
  ok(await page.evaluate(() => [...document.querySelectorAll('.console-output')].some(e => /Isolation is on for the console, but the runner could not be used/.test(e.innerText) || /Isolation is on for the console/.test(document.body.innerText))), 'with a visible one-time note about why');
  o = await run('typeof window.CodeMiniShield', 1500);
  ok(/"object"/.test(o), 'and, as the note says, that fallback code runs inside CodeMini', o);
  await ctx.close();

  console.log('\n[a missing exec.html does not switch preview isolation off]');
  const half = createServer(require('../lib/paths').runnerDir(), { headers: { 'Content-Security-Policy': "frame-ancestors 'self' http://localhost:8765 http://127.0.0.1:8765" } });
  const baseHandler = half.listeners('request')[0]; half.removeAllListeners('request');
  half.on('request', (req, res) => { if (req.url.split('?')[0].startsWith('/exec.')) { res.writeHead(404); res.end('missing'); } else baseHandler(req, res); });
  await new Promise(r => half.listen(8770, r));
  ({ ctx, page, errors } = await open(browser, 'http://localhost:8770'));
  run = await openConsole(page, 'JavaScript');
  o = await run('2 + 2', 5000);
  ok(/4/.test(o), 'the Console falls back when only exec.html is missing (the app was deployed, the runner was not)', o);
  ok(await page.evaluate(async () => { const f = document.createElement('iframe'); document.body.appendChild(f); try { return window.CodeMiniRunner.status() !== 'fallback' && !!window.CodeMiniRunner.execError(); } finally { f.remove(); } }), 'it remembers that failure for the execution host only, and the preview runner is untouched');
  await ctx.close(); half.close();

  await browser.close(); runnerServer.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
