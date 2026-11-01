// CodeMini runner: execution host. The code typed into CodeMini's Console and Terminal (JavaScript, Python, PHP, Ruby) runs
// HERE, on the runner's own origin, instead of inside the app. A page on another origin cannot read the app's storage
// (My Keys vault, GitHub token record, device key) or call its functions; this host can only talk to the app by
// postMessage, and the app treats everything it says as untrusted data.
//
// One host exists per CodeMini window/profile and lives as long as it, so JavaScript globals and the Python namespace
// persist between commands (and are shared by the Console and Terminal), as they did before.
//
// Protocol (every message {cmRunner:1, op, ...}; messages from here carry the nonce chosen by the app):
//   app -> host   hello{nonce}                     the handshake (only an allowed parent origin, only once)
//                 exec{id, lang, code, opts}       run code; lang is javascript | python | php | ruby | sql | r
//                                                   (sql: the result sets come back as JSON text in value {type:'sql', text})
//                                                   opts: trusted, autoInstall, raw (return the result text, no capture), sep
//                 prompt-reply{pid, value}         the answer to an exec-prompt
//                 reset{id, lang}                  forget a language's state (python: a fresh namespace; sql: a fresh database; r: a fresh environment)
//   host -> app   ready / hello-ack{version, build}   (the runner's level and build date, see config.js)
//                 exec-out{id, kind, text}         output as it happens: stdout stderr log info warn error html
//                 exec-prompt{id, pid, text}       Python's ainput(): the app asks the person and replies
//                 exec-done{id, value, plots, error, ms}
//                 reset-done{id}
// Only one command runs at a time; the rest wait their turn.
(function () {
    'use strict';
    var CFG = window.CM_RUNNER_CONFIG || { allowedParents: [] };
    var host = window.parent !== window ? window.parent : null;
    var hostOrigin = null, nonce = null;
    var LANGS = { javascript: 1, python: 1, php: 1, ruby: 1, sql: 1, r: 1 };
    var MAX_CODE = 1000000, MAX_TEXT = 200000;
    var PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/';
    var OPAL = ['opal.min.js', 'opal-parser.min.js', 'math.min.js', 'json.min.js', 'base64.min.js'].map(function (f) { return 'https://cdn.opalrb.com/opal/1.8.3/' + f; });

    function allowed(o) { return CFG.allowedParents.indexOf(o) !== -1; }
    function send(msg) {
        if (!host || !hostOrigin) return;
        msg.nonce = nonce;
        try { host.postMessage(msg, hostOrigin); } catch (e) { /* the app window is gone */ }
    }
    function clip(s) { s = String(s); return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n...[output cut]' : s; }
    function out(id, kind, text) { send({ cmRunner: 1, op: 'exec-out', id: id, kind: kind, text: clip(text) }); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function loadScript(src) {
        return new Promise(function (res, rej) {
            var s = document.createElement('script');
            s.src = src; s.onload = res; s.onerror = function () { rej(new Error('Failed to load ' + src)); };
            document.head.appendChild(s);
        });
    }

    // One command at a time: console.log is intercepted while a command runs, so two must never overlap.
    var queue = Promise.resolve();
    function enqueue(fn) { var p = queue.then(fn, fn); queue = p.catch(function () { /* the next command starts clean */ }); return p; }

    // ---- values ----------------------------------------------------------------------------------------------
    function safeStringify(obj) {
        var seen = [];
        return JSON.stringify(obj, function (k, v) {
            if (typeof v === 'object' && v !== null) return seen.indexOf(v) > -1 ? '[Circular Reference]' : (seen.push(v), v);
            return typeof v === 'function' ? '[Function: ' + (v.name || 'anonymous') + ']' : v;
        }, 2);
    }
    function describeElement(e) { return '<' + e.tagName.toLowerCase() + (e.id ? ' id="' + e.id + '"' : '') + (e.className && typeof e.className === 'string' ? ' class="' + e.className + '"' : '') + '>'; }
    function fmtArg(a) {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof Element !== 'undefined' && a instanceof Element) return describeElement(a);
        if (typeof a === 'object' && a !== null) { try { return safeStringify(a); } catch (e) { return String(a); } }
        return String(a);
    }
    // What the app shows for a JavaScript result: a type tag and plain text (the app picks colours and escapes it).
    function describe(v) {
        if (v === undefined) return null;
        if (typeof Element !== 'undefined' && v instanceof Element) return { type: 'element', text: describeElement(v) };
        if (typeof v === 'object' && v !== null) { try { return { type: 'object', text: safeStringify(v) }; } catch (e) { return { type: 'text', text: String(v) }; } }
        if (typeof v === 'string') return { type: 'string', text: v };
        if (typeof v === 'number' || typeof v === 'boolean') return { type: 'number', text: String(v) };
        if (typeof v === 'function') return { type: 'function', text: v.name || 'anonymous' };
        return { type: 'text', text: String(v) };
    }
    function errInfo(e) { return { name: String(e && e.name || 'Error'), message: String(e && e.message || e), text: String(e && e.stack || e) }; }

    // Intercept console.* while `fn` runs, sending each line to the app. The original methods still run too.
    async function capturing(id, fn) {
        var orig = {};
        ['log', 'info', 'warn', 'error'].forEach(function (lvl) {
            orig[lvl] = console[lvl];
            console[lvl] = function () {
                var args = Array.prototype.slice.call(arguments);
                out(id, lvl, args.map(fmtArg).join(' '));
                try { orig[lvl].apply(console, args); } catch (e) { /* ignore */ }
            };
        });
        try { return await fn(); }
        finally { ['log', 'info', 'warn', 'error'].forEach(function (lvl) { console[lvl] = orig[lvl]; }); }
    }

    // ---- JavaScript --------------------------------------------------------------------------------------------
    async function runJs(id, code) {
        return capturing(id, async function () {
            var result;
            if (/\bawait\b/.test(code)) {
                var AsyncFunction = Object.getPrototypeOf(async function () { /* constructor only */ }).constructor, fn;
                // Try it as an expression first; only a SYNTAX problem sends it to the statement form (a runtime error must not run it twice).
                try { fn = new AsyncFunction('return (' + code + ');'); } catch (syntax) { fn = new AsyncFunction(code); }
                result = await fn();
            } else result = (1, eval)(code);
            return { value: describe(result), plots: [], error: null };
        });
    }

    // ---- Python (Pyodide) ----------------------------------------------------------------------------------------
    var py = null, pyLoading = null, pyNs = null, activeId = 0, asks = {}, askSeq = 0;
    function askApp(text) {
        return new Promise(function (resolve) {
            var pid = ++askSeq; asks[pid] = resolve;
            send({ cmRunner: 1, op: 'exec-prompt', id: activeId, pid: pid, text: clip(text) });
        });
    }
    var PY_INIT = [
        'import os', "os.environ['MPLBACKEND'] = 'AGG'", 'import sys, io', 'import builtins', 'builtins.is_trusted = True',
        'builtins.input = custom_input', 'builtins.ainput = ainput', 'builtins.display_html = display_html',
        'try:', '    import warnings', '    warnings.filterwarnings("ignore", message="Matplotlib is currently using agg")',
        '    import matplotlib', "    matplotlib.use('agg')", '    import matplotlib.pyplot as plt', '    plt.ion = lambda: None',
        '    plt.show = lambda *args, **kwargs: None', 'except Exception:', '    pass'
    ].join('\n');
    var PY_PLOTS = ['import base64, io', 'import matplotlib.pyplot as plt', '_figs = [plt.figure(n) for n in plt.get_fignums()]', '_res = []',
        'for _fig in _figs:', '    _buf = io.BytesIO()', "    _fig.savefig(_buf, format='png', bbox_inches='tight', dpi=100)",
        "    _res.append(base64.b64encode(_buf.getvalue()).decode('utf-8'))", "plt.close('all')", '_res'].join('\n');
    function getPy() {
        if (py) return Promise.resolve(py);
        if (pyLoading) return pyLoading;
        pyLoading = (async function () {
            if (typeof loadPyodide === 'undefined') await loadScript(PYODIDE + 'pyodide.js');
            var p = await loadPyodide({ indexURL: PYODIDE });
            await p.loadPackage('micropip');
            // window.prompt is a real dialog (this frame may open modals); ainput asks the app's own input box.
            p.globals.set('custom_input', function (t) { return window.prompt(t) || ''; });
            p.globals.set('ainput', function (t) { return askApp(t); });
            p.globals.set('display_html', function (h) { out(activeId, 'html', String(h)); });
            p.registerJsModule('IPython', { get_ipython: function () { return null; }, display: { HTML: function (d) { out(activeId, 'html', String(d)); return ''; } } });
            await p.runPythonAsync(PY_INIT);
            py = p; pyNs = p.globals.get('dict')();
            p.runPython('import sys, io\nsys.stdout = io.StringIO()\nsys.stderr = io.StringIO()', { globals: pyNs });
            return p;
        })();
        pyLoading.catch(function () { pyLoading = null; });
        return pyLoading;
    }
    async function runPy(id, code, opts) {
        var p = await getPy();
        var R = function (c) { return p.runPython(c, { globals: pyNs }); };
        var RA = function (c) { return p.runPythonAsync(c, { globals: pyNs }); };
        if (opts.raw) { var raw = await RA(code); return { value: { type: 'text', text: String(raw) }, plots: [], error: null }; }
        R('import sys, io\n_cm_stdout = io.StringIO()\n_cm_stderr = io.StringIO()\nsys.stdout = _cm_stdout\nsys.stderr = _cm_stderr\n' +
          'try:\n    import builtins\n    builtins.is_trusted = ' + (opts.trusted === false ? 'False' : 'True') + '\n    import warnings\n' +
          '    warnings.filterwarnings("ignore", message="Matplotlib is currently using agg")\n    import matplotlib\n    matplotlib.use(\'agg\')\nexcept Exception:\n    pass\n');
        try {
            if (Array.isArray(opts.argv)) { pyNs.set('sys_argv', opts.argv.map(String)); R('import sys; sys.argv = sys_argv.to_py()'); }   // running a script file
            if (opts.autoInstall) { try { await p.loadPackagesFromImports(code); } catch (e) { /* the run reports a missing package itself */ } }
            var result = await RA(code);
            var so = R('_cm_stdout.getvalue()'), se = R('_cm_stderr.getvalue()');
            var plots = [];
            try { var proxy = await RA(PY_PLOTS); if (proxy && proxy.toJs) { plots = proxy.toJs(); proxy.destroy(); } } catch (e) { /* no plots */ }
            if (so) out(id, 'stdout', so);
            if (se) out(id, 'stderr', se);
            var value = null;
            if (result !== undefined && result !== null) { var s = result.toString(); if (s !== 'undefined' && s !== 'null' && s !== 'None') value = { type: 'text', text: s }; }
            return { value: value, plots: plots.map(String), error: null };
        } catch (e) {
            var errText = '';
            try { errText = R('sys.stderr.getvalue()'); } catch (x) { /* fall through */ }
            return { value: null, plots: [], error: { name: 'PythonError', message: String(e && e.message || e), text: errText || String(e) } };
        }
    }

    // ---- PHP (php-wasm) ------------------------------------------------------------------------------------------
    var php = null, phpLoading = null, phpLines = [];
    function getPhp() {
        if (php) return Promise.resolve(php);
        if (phpLoading) return phpLoading;
        phpLoading = (async function () {
            var mod;
            try { mod = await import('https://unpkg.com/php-wasm@0.1.0/PhpWeb.mjs'); }
            catch (e) { mod = await import('https://cdn.jsdelivr.net/npm/php-wasm@0.1.0/PhpWeb.mjs'); }
            var inst = new mod.PhpWeb();
            inst.addEventListener('output', function (ev) { phpLines.push({ kind: 'stdout', text: String(ev.detail) }); });
            inst.addEventListener('error', function (ev) { phpLines.push({ kind: 'stderr', text: String(ev.detail) }); });
            await sleep(200);
            php = inst; return inst;
        })();
        phpLoading.catch(function () { phpLoading = null; });
        return phpLoading;
    }
    async function runPhp(id, code) {
        var inst = await getPhp();
        phpLines = [];
        try { await inst.run(code); }
        catch (e) { phpLines.forEach(function (l) { out(id, l.kind, l.text); }); return { value: null, plots: [], error: errInfo(e) }; }
        phpLines.forEach(function (l) { out(id, l.kind, l.text); });
        return { value: null, plots: [], error: null };
    }

    // ---- Ruby (Opal) ---------------------------------------------------------------------------------------------
    var opalLoading = null;
    function getOpal() {
        if (window.Opal && window.Opal.eval) return Promise.resolve(window.Opal);
        if (opalLoading) return opalLoading;
        opalLoading = (async function () { for (var i = 0; i < OPAL.length; i++) await loadScript(OPAL[i]); return window.Opal; })();
        opalLoading.catch(function () { opalLoading = null; });
        return opalLoading;
    }
    async function runRuby(id, code, opts) {
        var opal = await getOpal();
        var lines = [], sep = typeof opts.sep === 'string' ? opts.sep : '\t', orig = console.log;
        console.log = function () { lines.push(Array.prototype.slice.call(arguments).map(function (a) { return typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(sep)); };
        try {
            var r = opal.eval(code), value = null;
            if (r !== undefined && r !== null && String(r) !== 'nil') value = { type: 'text', text: String(r) };
            if (lines.length) out(id, 'stdout', lines.join('\n'));
            return { value: value, plots: [], error: null };
        } catch (e) {
            if (lines.length) out(id, 'stdout', lines.join('\n'));
            return { value: null, plots: [], error: errInfo(e) };
        } finally { console.log = orig; }
    }

    // ---- SQL (sql.js) --------------------------------------------------------------------------------------------
    // One database per host (so per CodeMini window), like the in-app SQL kernel, with the same helper functions. The result sets go back as JSON
    // text (BLOBs as their comma-separated bytes, as the notebook always showed them); the app validates and escapes them.
    var SQLJS = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/', sqlLib = null, sqlLoading = null, sqlDb = null, SQL_MAX = 1000000;
    function getSql() {
        if (sqlLib) return Promise.resolve(sqlLib);
        if (sqlLoading) return sqlLoading;
        sqlLoading = (async function () {
            if (typeof window.initSqlJs === 'undefined') await loadScript(SQLJS + 'sql-wasm.js');
            sqlLib = await window.initSqlJs({ locateFile: function (f) { return SQLJS + f; } });
            return sqlLib;
        })();
        sqlLoading.catch(function () { sqlLoading = null; });
        return sqlLoading;
    }
    function newSqlDb(SQL) {
        var db = new SQL.Database();
        db.create_function('POWER', function (a, b) { return Math.pow(a, b); });
        db.create_function('SQRT', function (a) { return Math.sqrt(a); });
        db.create_function('SIN', function (a) { return Math.sin(a); });
        db.create_function('COS', function (a) { return Math.cos(a); });
        db.create_function('TAN', function (a) { return Math.tan(a); });
        db.create_function('LOG', function (a) { return Math.log(a); });
        db.create_function('EXP', function (a) { return Math.exp(a); });
        db.create_function('CEIL', function (a) { return Math.ceil(a); });
        db.create_function('FLOOR', function (a) { return Math.floor(a); });
        db.create_function('RANDOM_RANGE', function (min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; });
        return db;
    }
    async function runSql(id, code) {
        var SQL = await getSql();
        if (!sqlDb) sqlDb = newSqlDb(SQL);
        var sets = sqlDb.exec(code), budget = SQL_MAX;
        var plain = sets.map(function (r) {
            var rows = [], cut = false;
            for (var i = 0; i < r.values.length; i++) {
                var row = r.values[i].map(function (v) { return v instanceof Uint8Array ? Array.prototype.join.call(v, ',') : v; });
                budget -= JSON.stringify(row).length;
                if (budget < 0) { cut = true; break; }
                rows.push(row);
            }
            return { columns: r.columns.map(String), values: rows, cut: cut };
        });
        return { value: { type: 'sql', text: JSON.stringify(plain) }, plots: [], error: null };
    }

    // ---- R (webR) ------------------------------------------------------------------------------------------------
    // webR starts a Web Worker of its own from here. The runner has no cross-origin-isolation headers (like the app), so webR uses the same
    // fallback channel it always used. One environment per host for notebook cells (the in-app kernel had one per window); the scratchpad
    // (opts.global) runs in R's global environment, as before. Plots go through a png device into a temporary folder and come back as base64.
    // Pinned to a release, not to /latest/: on 2026-10-31 /latest/ served "0.6.1-dev+dd30a59", a development snapshot that changes under you. 0.6.0 is the release
    // (R 4.6.0) closest to what was tested on a phone. Keep it the same as the in-app import in js/notebook/notebook-kernels.js (tests/runner-version.test.js checks).
    var WEBR_URL = 'https://webr.r-wasm.org/v0.6.0/webr.mjs', webR = null, webRLoading = null, rEnv = null, R_TMP = '/tmp/cm_plots';
    function getWebR() {
        if (webR) return Promise.resolve(webR);
        if (webRLoading) return webRLoading;
        webRLoading = (async function () {
            var mod = await import(WEBR_URL);
            var w = new mod.WebR();
            await w.init();
            webR = w;
            return w;
        })();
        webRLoading.catch(function () { webRLoading = null; });
        return webRLoading;
    }
    // webR's FS has no readdir ("w.FS.readdir is not a function", seen on a phone 2026-10-27), so list files by asking R. `regex` is an R regular
    // expression written without backslashes.
    async function rListFiles(w, dir, regex) {
        var code = 'list.files("' + dir + '", pattern = "' + regex + '")';
        if (typeof w.evalRRaw === 'function') return (await w.evalRRaw(code, 'string[]')) || [];
        var o = await w.evalR(code);
        try { return ((await o.toArray()) || []).filter(function (x) { return typeof x === 'string'; }); }
        finally { try { await w.destroy(o); } catch (e) { /* nothing to free */ } }
    }
    async function runR(id, code, opts) {
        var w = await getWebR();
        if (Array.isArray(opts.install)) {            // the package manager
            await w.installPackages(opts.install.map(String));
            return { value: null, plots: [], error: null };
        }
        var env = null;
        if (!opts.global) { if (!rEnv) rEnv = await new w.REnvironment({}); env = rEnv; }
        if (opts.autoInstall) {
            var imports = [], re = /(?:library|require)\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g, m;
            while ((m = re.exec(code)) !== null) imports.push(m[2]);
            if (imports.length) { try { await w.installPackages(imports); } catch (e) { /* not fatal, as before */ } }
        }
        var shelter = await new w.Shelter();
        try { await w.FS.mkdir(R_TMP); } catch (e) { /* exists */ }
        try { var old = await rListFiles(w, R_TMP, '^webr_plot_'); for (var i = 0; i < old.length; i++) await w.FS.unlink(R_TMP + '/' + old[i]); } catch (e) { /* nothing to clear */ }
        await w.evalRVoid('png(file="' + R_TMP + '/webr_plot_%03d.png", width=800, height=600, res=100)');
        var plots = [];
        try {
            // captureGraphics: false on purpose. webR's default opens its own canvas device and sends the plot there as an ImageBitmap; the png device
            // above would stay empty ("Completed with no output"), and on iOS that canvas path has reloaded the page.
            var capOpts = { withAutoprint: true, captureStreams: true, captureConditions: false, captureGraphics: false };
            if (env) capOpts.env = env;
            var cap = await shelter.captureR(code, capOpts);
            cap.output.forEach(function (o) {
                if (o.type === 'stdout') out(id, 'stdout', o.data + '\n');
                else if (o.type === 'stderr') out(id, 'stderr', o.data + '\n');
            });
        } finally {
            shelter.purge();
            await w.evalRVoid('tryCatch(dev.off(), error=function(e) NULL)');
            try {
                var files = await rListFiles(w, R_TMP, '^webr_plot_.*[.]png$');
                for (var j = 0; j < files.length; j++) {
                    if (files[j].indexOf('webr_plot_') !== 0 || files[j].slice(-4) !== '.png') continue;
                    var bytes = new Uint8Array(await w.FS.readFile(R_TMP + '/' + files[j])), bin = '';
                    if (!bytes.byteLength) { out(id, 'stderr', '[R plot not read: ' + files[j] + ' is empty]\n'); await w.FS.unlink(R_TMP + '/' + files[j]); continue; }
                    for (var k = 0; k < bytes.byteLength; k++) bin += String.fromCharCode(bytes[k]);
                    plots.push(btoa(bin));
                    await w.FS.unlink(R_TMP + '/' + files[j]);
                }
            } catch (e) {
                // Say so in the cell. A silent catch here made a failing plot look like "Completed with no output", with no console on a phone to tell why.
                out(id, 'stderr', '[R plot not read: ' + (e && e.message ? e.message : String(e)) + ']\n');
            }
        }
        return { value: null, plots: plots, error: null };
    }

    // ---- dispatch ------------------------------------------------------------------------------------------------
    async function execOne(d) {
        var t0 = Date.now(), opts = d.opts && typeof d.opts === 'object' ? d.opts : {};
        activeId = d.id;
        var res;
        try {
            if (d.lang === 'javascript') res = await runJs(d.id, d.code);
            else if (d.lang === 'python') res = await runPy(d.id, d.code, opts);
            else if (d.lang === 'php') res = await runPhp(d.id, d.code);
            else if (d.lang === 'sql') res = await runSql(d.id, d.code);
            else if (d.lang === 'r') res = await runR(d.id, d.code, opts);
            else res = await runRuby(d.id, d.code, opts);
        } catch (e) { res = { value: null, plots: [], error: errInfo(e) }; }
        res.ms = Date.now() - t0;
        return res;
    }

    function control(e, d) {
        if (d.op === 'hello') {
            if (hostOrigin) return;
            if (typeof d.nonce !== 'string' || d.nonce.length < 16 || d.nonce.length > 128) return;
            hostOrigin = e.origin; nonce = d.nonce;
            send({ cmRunner: 1, op: 'hello-ack', version: (CFG.version | 0), build: String(CFG.build || '') });   // see config.js: lets the app tell an out-of-date runner
            return;
        }
        if (!hostOrigin) return;
        if (d.op === 'exec') {
            if (!LANGS[d.lang] || typeof d.code !== 'string' || d.code.length > MAX_CODE || typeof d.id !== 'number') {
                send({ cmRunner: 1, op: 'exec-done', id: d.id, value: null, plots: [], ms: 0, error: { name: 'BadRequest', message: 'unsupported language or code', text: '' } });
                return;
            }
            enqueue(function () { return execOne(d); }).then(function (res) {
                send({ cmRunner: 1, op: 'exec-done', id: d.id, value: res.value, plots: res.plots, error: res.error, ms: res.ms });
            });
        } else if (d.op === 'prompt-reply') {
            var fn = asks[d.pid];
            if (fn) { delete asks[d.pid]; fn(typeof d.value === 'string' ? d.value : ''); }
        } else if (d.op === 'reset') {
            // Python: a fresh namespace. Everything else cannot be reset in place; the app discards the whole host instead.
            if (d.lang === 'python' && py) pyNs = py.globals.get('dict')();
            if (d.lang === 'sql' && sqlDb) { try { sqlDb.close(); } catch (err) { /* already gone */ } sqlDb = null; }
            if (d.lang === 'r') {
                if (rEnv) { try { rEnv.destroy(); } catch (err) { /* already gone */ } rEnv = null; }
                // not awaited (this handler is synchronous): webR runs its requests in order, so any later run queues behind this clean-up
                if (webR) { try { webR.evalRVoid('rm(list = ls(envir = globalenv()), envir = globalenv())').catch(function () { /* nothing to clear */ }); } catch (err) { /* not started */ } }
            }
            send({ cmRunner: 1, op: 'reset-done', id: d.id });
        }
    }

    window.addEventListener('message', function (e) {
        if (!host || e.source !== host) return;                       // only the embedding app (the code that runs here shares this window and could post to itself)
        if (!allowed(e.origin) || (hostOrigin && e.origin !== hostOrigin)) return;
        if (e.data && typeof e.data === 'object' && e.data.cmRunner === 1) control(e, e.data);
    });

    if (host) {
        var guess = (location.ancestorOrigins && location.ancestorOrigins[0]) || null;
        if (!guess || allowed(guess)) host.postMessage({ cmRunner: 1, op: 'ready', v: 1 }, guess || '*');
    }
})();
