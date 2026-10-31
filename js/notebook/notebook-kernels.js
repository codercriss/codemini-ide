// ==========================================
// notebook-kernels.js (Kernel Execution & WebAssembly)
// ==========================================

window._coreEngines = window._coreEngines || {
    pyodide: null,
    micropip: null,
    webr: null,
    sql: null,
    marked: null,
    loading: {
        pyodide: false,
        webr: false,
        sql: false,
        marked: false
    }
};

// --- Strict Isolation Registry ---
window._activeCellRegistry = window._activeCellRegistry || {};

const kernelRegistry = {
    sqlDbs: {},
    pyNamespaces: {},
    rNamespaces: {},
    php: { instances: {}, lines: {} },
    interrupted: {},
    packages: {}
};

function _getWinId() {
    return typeof cellActiveWinId !== 'undefined' ? cellActiveWinId : (localStorage.getItem('codemini_active_window') || 'win_default');
}

// ---- Notifications (Now Island) ----
// Long work (an engine download, a long run) is only worth a notification when the person is not looking at it:
// the app is in the background, or they have switched to another window/profile since it started.
const NB_LONG_RUN_MS = 15000; // shorter runs finish before anyone has looked away
function _nbAway(startWin) {
    return document.hidden || _getWinId() !== startWin;
}
function _nbNotify(n) {
    try {
        if (window.CodeMiniNotifications) window.CodeMiniNotifications.add(Object.assign({ source: 'Notebooks', kind: 'notebook' }, n));
    } catch (e) { /* notifications are optional */ }
}
function _nbTitleOf(pane) {
    try {
        const tab = pane && pane.id ? document.querySelector('.tab[data-target="' + pane.id + '"]') : null;
        const name = tab && tab.querySelector('span') ? tab.querySelector('span').textContent.trim() : '';
        return name || 'Your notebook';
    } catch (e) { return 'Your notebook'; }
}
// Called by Run All when it ends. `interrupted` runs are the person's own doing, so they are not announced.
window.notifyNotebookRunDone = function (pane, startedAt, startWin, interrupted) {
    if (interrupted || Date.now() - startedAt < NB_LONG_RUN_MS || !_nbAway(startWin)) return;
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const took = secs >= 60 ? Math.floor(secs / 60) + ' min ' + (secs % 60) + ' s' : secs + ' s';
    _nbNotify({
        id: 'nb-run-' + (pane && pane.id ? pane.id : 'x'),
        title: 'Notebook run finished',
        text: _nbTitleOf(pane) + ' finished running all its cells in ' + took + '.'
    });
};

Object.defineProperty(window, 'phpWebInstance', {
    get: () => kernelRegistry.php.instances[_getWinId()] || null,
    set: (v) => { kernelRegistry.php.instances[_getWinId()] = v; }
});
Object.defineProperty(window, '_phpConsoleLines', {
    get: () => kernelRegistry.php.lines[_getWinId()] || [],
    set: (v) => { kernelRegistry.php.lines[_getWinId()] = v; }
});

Object.defineProperty(window, 'kernelInterrupted', {
    get: () => kernelRegistry.interrupted[_getWinId()] || false,
    set: (v) => { kernelRegistry.interrupted[_getWinId()] = v; }
});

Object.defineProperty(window, 'installedPackages', {
    get: () => {
        const wid = _getWinId();
        if (!kernelRegistry.packages[wid]) kernelRegistry.packages[wid] = new Set();
        return kernelRegistry.packages[wid];
    },
    set: (v) => { kernelRegistry.packages[_getWinId()] = v; }
});

Object.defineProperty(window, 'micropip', {
    get: () => window._coreEngines.micropip
});

Object.defineProperty(window, 'sqlDb', {
    get: () => kernelRegistry.sqlDbs[_getWinId()] || null,
    set: (v) => { kernelRegistry.sqlDbs[_getWinId()] = v; }
});

window.cellMonacoEditors = {};

window.getNbAutoInstall = function() {
    if (window.appSettings && window.appSettings.nbAutoInstall !== undefined) {
        return window.appSettings.nbAutoInstall;
    }
    return true; 
}

// --- Centralized Kernel Status Management ---
window.resetKernelStatus = function(pane) {
    if (!pane) return;
    const kernelStatus = pane.querySelector('.kernel-status');
    if (!kernelStatus) return;
    const kType = kernelStatus.dataset.kernel;
    let baseTxt = '<i class="fab fa-python" style="color: var(--icon-py);"></i> Python 3 (Pyodide)';
    if (kType === 'r') baseTxt = '<i class="fab fa-r-project" style="color: #276dc3;"></i> R (WebR)';
    else if (kType === 'sql') baseTxt = '<i class="ri-database-2-line" style="color: #4CAF50;"></i> SQL (SQLite)';
    
    kernelStatus.innerHTML = `${baseTxt} -- Ready`;
    kernelStatus.style.color = '';
};

window.setKernelStatus = function(pane, msg, isError = false) {
    if (!pane) return;
    const kernelStatus = pane.querySelector('.kernel-status');
    if (!kernelStatus) return;
    const kType = kernelStatus.dataset.kernel;
    let baseTxt = '<i class="fab fa-python" style="color: var(--icon-py);"></i> Python 3 (Pyodide)';
    if (kType === 'r') baseTxt = '<i class="fab fa-r-project" style="color: #276dc3;"></i> R (WebR)';
    else if (kType === 'sql') baseTxt = '<i class="ri-database-2-line" style="color: #4CAF50;"></i> SQL (SQLite)';
    
    kernelStatus.innerHTML = `${baseTxt} -- ${CodeMiniEscape.html(msg)}`;
    kernelStatus.style.color = isError ? 'var(--color-danger)' : '';
};

window.forceCloseEnvironments = function(winId, isClosing = false) {
    if (window.CodeMiniExec) window.CodeMiniExec.forget(winId, isClosing); // the Console/Terminal's runner host, if this window started one
    if (kernelRegistry.interrupted) kernelRegistry.interrupted[winId] = true;
    if (window._bpConsoleRunningState) window._bpConsoleRunningState[winId] = false;
    
    // PHP's instance and Ruby's sandbox iframe are only fully torn down when
    // the window is genuinely being deleted (isClosing=true), not on every
    // ordinary switch-away - otherwise variables/state defined in either
    // language would be lost every time you switched to another window and
    // back, even though nothing was actually closed. Mirrors the same
    // survive-a-switch principle already applied to the Python/R namespaces.
    if (isClosing) {
        if (window.phpWebInstances && window.phpWebInstances[winId]) {
            window.phpWebInstances[winId] = null;
        }
        if (window._phpConsoleLines) window._phpConsoleLines[winId] = [];
        if (window.teardownRubySandbox) window.teardownRubySandbox(winId);
    }
    
    // NOTE: window._coreEngines (pyodide/webr/sql) are intentionally SHARED,
    // loaded-once WASM runtimes used by every window/profile - they must NOT
    // be nulled out here. This function tears down only winId's own isolated
    // state within those shared engines. Nulling the engines themselves would
    // force a full multi-megabyte reload for every other window still using
    // them (this was previously happening on every single window switch, not
    // just window close, since switchWindow calls this for the outgoing window).
    
    if (kernelRegistry.pyNamespaces) delete kernelRegistry.pyNamespaces[winId];
    if (kernelRegistry.rNamespaces) {
        if (kernelRegistry.rNamespaces[winId]) {
            try { kernelRegistry.rNamespaces[winId].destroy(); } catch(e) {}
            delete kernelRegistry.rNamespaces[winId];
        }
    }
    if (kernelRegistry.sqlDbs) {
        if (kernelRegistry.sqlDbs[winId]) {
            try { kernelRegistry.sqlDbs[winId].close(); } catch(e) {}
            delete kernelRegistry.sqlDbs[winId];
        }
    }
};

// --- JavaScript Helpers ---
window.inlineInputPrompt = function(promptText) {
    return new Promise((resolve) => {
        const cell = window._activeCellRegistry[_getWinId()];
        if (!cell) { resolve(prompt(promptText) || ""); return; }

        let outputWrapper = cell.querySelector('.cell-output-wrapper');
        const inputContainer = document.createElement('div');
        inputContainer.style.cssText = `
            display: flex; align-items: center; gap: 10px; padding: 8px 15px; 
            background-color: var(--bg-panel); border-top: 1px dashed var(--border-color); 
            border-bottom: 1px solid var(--border-color); font-family: var(--font-mono); 
            font-size: 13px;
        `;

        const label = document.createElement('span');
        label.textContent = promptText;
        label.style.color = 'var(--accent-blue)';

        const inputField = document.createElement('input');
        inputField.type = 'text';
        inputField.style.cssText = `
            flex: 1; background: var(--bg-white); border: 1px solid var(--border-color); 
            color: var(--text-main); padding: 4px 8px; border-radius: 4px; outline: none;
            font-family: var(--font-mono);
        `;

        inputField.addEventListener('focus', () => inputField.style.borderColor = 'var(--accent-blue)');
        inputField.addEventListener('blur', () => inputField.style.borderColor = 'var(--border-color)');

        inputContainer.appendChild(label);
        inputContainer.appendChild(inputField);

        let plotContainer = outputWrapper.querySelector('.plot-container');
        if (plotContainer) {
            outputWrapper.insertBefore(inputContainer, plotContainer);
        } else {
            outputWrapper.appendChild(inputContainer);
        }
        
        inputField.focus();

        inputField.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const val = inputField.value;
                inputContainer.innerHTML = `
                    <span style="color: var(--text-muted);">${promptText}</span> 
                    <span style="color: var(--term-green); font-weight: bold;">${val}</span>
                `;
                resolve(val);
            }
        });
    });
};

window.displayHTML = function(htmlContent) {
    const cell = window._activeCellRegistry[_getWinId()];
    if (!cell) return;
    
    const pane = cell.closest('.content-pane');
    const trustLink = pane ? pane.querySelector('.tb-trust') : null;
    const isTrusted = (trustLink ? trustLink.dataset.trusted === 'true' : true) && (!window.WorkspaceTrust || window.WorkspaceTrust.isTrusted());

    let finalHtml = htmlContent;
    let wasBlocked = false;

    if (!isTrusted) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlContent, 'text/html');

        const scripts = doc.querySelectorAll('script');
        if (scripts.length > 0) wasBlocked = true;
        scripts.forEach(s => s.remove());

        const allElements = doc.querySelectorAll('*');
        allElements.forEach(el => {
            for (let i = el.attributes.length - 1; i >= 0; i--) {
                const attr = el.attributes[i];
                if (attr.name.toLowerCase().startsWith('on') || attr.value.toLowerCase().includes('javascript:')) {
                    el.removeAttribute(attr.name);
                    wasBlocked = true;
                }
            }
        });
        finalHtml = doc.body.innerHTML;
    }

    let outputWrapper = cell.querySelector('.cell-output-wrapper');
    const displayDiv = document.createElement('div');
    displayDiv.className = 'cell-output custom-display';
    displayDiv.style.backgroundColor = 'transparent';
    displayDiv.style.padding = '10px 15px';

    let indicatorHtml = '';
    if (wasBlocked) {
        indicatorHtml = `<div class="blocked-content-indicator" style="color:var(--color-danger); border: 1px dashed var(--color-danger); padding: 5px; border-radius: 4px; font-size:12px; margin-bottom:5px; background: rgba(211, 47, 47, 0.05);"><i class="ri-shield-flash-line"></i> Sanitized Output: Blocked unsafe scripts/events (Untrusted)</div>\n`;
    }

    displayDiv.innerHTML = indicatorHtml + finalHtml;
    
    let plotContainer = outputWrapper.querySelector('.plot-container');
    if (plotContainer) {
        outputWrapper.insertBefore(displayDiv, plotContainer);
    } else {
        outputWrapper.appendChild(displayDiv);
    }
};

// On-demand markdown parser for markdown cells. Loaded the same way as the
// other CDN-hosted engines above (sql.js, Pyodide) and the on-demand imports
// used elsewhere in the app (pdf-viewer.js's pdf.js, php-wasm) - two
// independent CDN sources tried in order rather than one hardcoded import,
// since either can have an outage. Cached in the same shared
// window._coreEngines registry: like sql.js's own library reference, this is
// a stateless parser, not per-window state, so there's nothing here that
// needs the per-window isolation kernelRegistry.sqlDbs/pyNamespaces use.
async function getMarkedInstance() {
    if (window._coreEngines.marked) return window._coreEngines.marked;
    if (window._coreEngines.loading.marked) {
        while (!window._coreEngines.marked) {
            await new Promise(r => setTimeout(r, 50));
            if (!window._coreEngines.loading.marked && !window._coreEngines.marked) return null;
        }
        return window._coreEngines.marked;
    }
    window._coreEngines.loading.marked = true;
    let mod;
    try {
        mod = await import('https://esm.sh/marked@18.0.14');
    } catch (e1) {
        try {
            mod = await import('https://cdn.jsdelivr.net/npm/marked@18.0.14/+esm');
        } catch (e2) {
            window._coreEngines.loading.marked = false;
            console.error('Markdown renderer failed to load from all sources.', e1, e2);
            return null;
        }
    }
    // gfm enables tables, strikethrough, autolinks and task-list checkboxes.
    // breaks matches the old hand-rolled renderer's behavior of treating a
    // single line break as a visible line break rather than requiring a
    // blank line between them, which is what notebook authors here are used to.
    mod.marked.setOptions({ gfm: true, breaks: true });
    window._coreEngines.marked = mod.marked;
    window._coreEngines.loading.marked = false;
    return window._coreEngines.marked;
}

// Previously a hand-rolled chain of regex replacements - it had no concept of
// tables at all (GFM `| a | b |` syntax just fell through the generic
// paragraph-wrapping rule at the end and rendered as a literal line of pipe
// characters), its italics pattern (`/\*(.+?)\*\*/g`) required a trailing
// double-asterisk so single-asterisk *emphasis* essentially never matched,
// and numbered lists were converted to bare <li> elements that were never
// wrapped in an <ol> (only the unordered-list rule wrapped its <li>s in a
// <ul>), so ordered lists rendered as unmarked, unindented lines. Replaced
// with a real, GFM-aware parser (see getMarkedInstance above) instead of
// patching that chain further.
async function renderMarkdown(text) {
    if (!text) return '';
    const md = await getMarkedInstance();
    if (!md) {
        // CDN unreachable - show the raw source rather than nothing, so the
        // cell's content isn't just silently missing.
        const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<pre style="white-space: pre-wrap; font-family: var(--font-main); margin:0; color: var(--text-main);">${esc}</pre><div style="color: var(--color-danger); font-size: 12px; margin-top: 6px;"><i class="ri-error-warning-line"></i> Markdown renderer failed to load (check your connection) - showing raw text.</div>`;
    }

    const wrap = document.createElement('div');
    // Markdown cells can carry raw HTML from the .ipynb: keep the markup, drop anything that can run.
    wrap.innerHTML = CodeMiniEscape.sanitize(md.parse(text));

    // marked's plain output needs two small adjustments to match what this
    // app actually needs from it:
    // 1. Links get target="_blank" - marked doesn't add this, and without it
    //    clicking a link in a notebook cell would navigate the whole IDE away
    //    instead of opening in a new tab.
    // 2. Code elements keep the nb-inline-code/nb-code-block classes the old
    //    renderer used to hardcode - themes.css's premium theme pack styles
    //    notebook code by those class names specifically (see its
    //    "Notebook cell content" section), and marked has no reason to know
    //    to add them on its own.
    wrap.querySelectorAll('a[href]').forEach(a => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
    });
    wrap.querySelectorAll('pre').forEach(pre => pre.classList.add('nb-code-block'));
    wrap.querySelectorAll('code').forEach(code => {
        if (!code.closest('pre')) code.classList.add('nb-inline-code');
    });

    return wrap.innerHTML;
}

window.getSqlInstance = async function() {
    const winId = _getWinId();
    const pane = document.querySelector('.editor-group.active-group .content-pane.active') || document.querySelector('.content-pane.active');
    
    if (!window._coreEngines.sql) {
        if (window._coreEngines.loading.sql) {
            while (!window._coreEngines.sql) {
                await new Promise(r => setTimeout(r, 100));
                if (!window._coreEngines.loading.sql && !window._coreEngines.sql) return null; 
            }
        } else {
            window._coreEngines.loading.sql = true;
            try {
                const statusCircles = document.querySelectorAll('.status-circle');
                statusCircles.forEach(c => c.classList.add('running'));

                const SQL = await window.initSqlJs({ locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` });
                window._coreEngines.sql = SQL;
                
                statusCircles.forEach(c => c.classList.remove('running'));
            } catch(e) {
                window._coreEngines.loading.sql = false;
                document.querySelectorAll('.status-circle').forEach(c => c.classList.remove('running'));
                window.setKernelStatus(pane, 'Failed to load. Please refresh.', true);
                console.error("SQL init error:", e);
                return null;
            }
        }
    }
    
    if (!kernelRegistry.sqlDbs[winId]) {
        const SQL = window._coreEngines.sql;
        const db = new SQL.Database();

        db.create_function("POWER", (a, b) => Math.pow(a, b));
        db.create_function("SQRT", a => Math.sqrt(a));
        db.create_function("SIN", a => Math.sin(a));
        db.create_function("COS", a => Math.cos(a));
        db.create_function("TAN", a => Math.tan(a));
        db.create_function("LOG", a => Math.log(a));
        db.create_function("EXP", a => Math.exp(a));
        db.create_function("CEIL", a => Math.ceil(a));
        db.create_function("FLOOR", a => Math.floor(a));
        db.create_function("RANDOM_RANGE", (min, max) => Math.floor(Math.random() * (max - min + 1)) + min);

        kernelRegistry.sqlDbs[winId] = db;
    }
    
    window.resetKernelStatus(pane);
    return kernelRegistry.sqlDbs[winId];
};

window.getPyodideInstance = async function() {
    const winId = _getWinId();
    const pane = document.querySelector('.editor-group.active-group .content-pane.active') || document.querySelector('.content-pane.active');

    if (!window._coreEngines.pyodide) {
        if (window._coreEngines.loading.pyodide) {
            while (!window._coreEngines.pyodide) {
                await new Promise(r => setTimeout(r, 100));
                if (!window._coreEngines.loading.pyodide && !window._coreEngines.pyodide) return null;
            }
        } else {
            window._coreEngines.loading.pyodide = true;
            try {
                if (typeof loadPyodide === 'undefined') throw new Error("Pyodide not loaded. Please check your internet connection and refresh the page.");
                
                const statusCircles = document.querySelectorAll('.status-circle');
                statusCircles.forEach(c => c.classList.add('running'));
                
                const py = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.24.1/full/" });
                await py.loadPackage('micropip');
                window._coreEngines.micropip = py.pyimport('micropip');
                
                py.globals.set("custom_input", (prompt_text) => prompt(prompt_text) || "");
                py.globals.set("ainput", async (prompt_text) => await window.inlineInputPrompt(prompt_text));
                py.globals.set("display_html", (html_content) => window.displayHTML(html_content));
                
                py.registerJsModule("IPython", {
                    get_ipython: () => null,
                    display: {
                        HTML: (data) => {
                            window.displayHTML(data);
                            return "";
                        }
                    }
                });
                
                await py.runPythonAsync(`
import os
os.environ['MPLBACKEND'] = 'AGG'
import sys, io
import builtins

builtins.is_trusted = True
builtins.input = custom_input
builtins.ainput = ainput
builtins.display_html = display_html

try:
    import warnings
    warnings.filterwarnings("ignore", message="Matplotlib is currently using agg")
    
    import matplotlib
    matplotlib.use('agg')
    import matplotlib.pyplot as plt
    plt.ion = lambda: None
    plt.show = lambda *args, **kwargs: None
except Exception:
    pass
`);
                window._coreEngines.pyodide = py;
                statusCircles.forEach(c => c.classList.remove('running'));
                if (_nbAway(winId)) _nbNotify({ id: 'nb-engine-python', title: 'Python is ready', text: 'The Python engine finished loading. It is ready to run your notebook cells and stays loaded until you reload the app.' });
            } catch (e) {
                window._coreEngines.loading.pyodide = false;
                document.querySelectorAll('.status-circle').forEach(c => c.classList.remove('running'));
                window.setKernelStatus(pane, 'Failed to load. Please refresh.', true);
                console.error("Pyodide init error:", e);
                return null;
            }
        }
    }

    const py = window._coreEngines.pyodide;
    if (!py) return null;

    if (!kernelRegistry.pyNamespaces[winId]) {
        const ns = py.globals.get("dict")();
        kernelRegistry.pyNamespaces[winId] = ns;
        
        py.runPython(`
import sys, io
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
        `, { globals: ns });
    }
    
    const ns = kernelRegistry.pyNamespaces[winId];
    window.resetKernelStatus(pane);
    
    return new Proxy(py, {
        get(target, prop) {
            if (prop === 'runPython') {
                return (code, options = {}) => target.runPython(code, { ...options, globals: ns });
            }
            if (prop === 'runPythonAsync') {
                return (code, options = {}) => target.runPythonAsync(code, { ...options, globals: ns });
            }
            if (prop === 'globals') {
                return ns;
            }
            const val = target[prop];
            return typeof val === 'function' ? val.bind(target) : val;
        }
    });
};

// List files by asking R. webR's FS object has no readdir (a phone run on 2026-10-27 showed "w.FS.readdir is not a function"), and the
// code that used it was swallowing that error, so R plots never came back. `regex` is an R regular expression, written without backslashes.
window._rListFiles = async function(webr, dir, regex) {
    const code = 'list.files("' + dir + '", pattern = "' + regex + '")';
    if (typeof webr.evalRRaw === 'function') return (await webr.evalRRaw(code, 'string[]')) || [];
    const o = await webr.evalR(code);
    try { return ((await o.toArray()) || []).filter(function(x) { return typeof x === 'string'; }); }
    finally { try { await webr.destroy(o); } catch (e) { /* nothing to free */ } }
};

window.getWebRInstance = async function() {
    const winId = _getWinId();
    const pane = document.querySelector('.editor-group.active-group .content-pane.active') || document.querySelector('.content-pane.active');

    if (!window._coreEngines.webr) {
        if (window._coreEngines.loading.webr) {
            while (!window._coreEngines.webr) {
                await new Promise(r => setTimeout(r, 100));
                if (!window._coreEngines.loading.webr && !window._coreEngines.webr) return null;
            }
        } else {
            window._coreEngines.loading.webr = true;
            try {
                const statusCircles = document.querySelectorAll('.status-circle');
                statusCircles.forEach(c => c.classList.add('running'));

                const { WebR } = await import('https://webr.r-wasm.org/latest/webr.mjs');
                const webr = new WebR();
                await webr.init();
                window._coreEngines.webr = webr;

                statusCircles.forEach(c => c.classList.remove('running'));
                if (_nbAway(winId)) _nbNotify({ id: 'nb-engine-r', title: 'R is ready', text: 'The R engine finished loading. It is ready to run your notebook cells and stays loaded until you reload the app.' });
            } catch(e) {
                window._coreEngines.loading.webr = false;
                document.querySelectorAll('.status-circle').forEach(c => c.classList.remove('running'));
                window.setKernelStatus(pane, 'Failed to load. Please refresh.', true);
                console.error("WebR init error:", e);
                return null;
            }
        }
    }
    
    window.resetKernelStatus(pane);
    return window._coreEngines.webr;
};

// The webR engine itself is shared across every window/profile (loading it is
// expensive), but each window gets its own persistent R environment so
// variables assigned in one window's notebook never leak to or from another's.
// Mirrors getPyodideInstance's pyNamespaces pattern - see window.forceCloseEnvironments
// for the corresponding per-window cleanup (delete, not a full engine reload).
window.getRNamespace = async function(webr, winId) {
    if (!kernelRegistry.rNamespaces[winId]) {
        kernelRegistry.rNamespaces[winId] = await new webr.REnvironment({});
    }
    return kernelRegistry.rNamespaces[winId];
};

window.installPackage = async function(pkgName, kernel = 'python', e) {
    if(e) e.stopPropagation();
    const installWin = _getWinId();
    
    const statusDiv = document.getElementById(`pkg-status-${kernel}-${pkgName}`);
    if(statusDiv) statusDiv.innerHTML = '<i class="ri-loader-4-line pkg-install-btn" style="animation: spinStatus 0.5s linear infinite;"></i>';
    
    const pane = document.querySelector('.editor-group.active-group .content-pane.active') || document.querySelector('.content-pane.active');
    
    try {
        document.querySelectorAll('.status-circle').forEach(c => c.classList.add('running'));

        if (kernel === 'r' && await _nbUseHost(_getWinId())) {
            if (window.kernelInterrupted) throw new Error("Interrupted");
            await _nbHostRInstall(_getWinId(), [pkgName]);
        } else if (kernel === 'r') {
            const webr = await window.getWebRInstance();
            if (!webr) throw new Error("Failed to initialize WebR.");
            if (window.kernelInterrupted) throw new Error("Interrupted");
            await webr.installPackages([pkgName]); 
        } else if (await _nbUseHost(_getWinId())) {
            if (window.kernelInterrupted) throw new Error("Interrupted");
            await _nbHostPip(_getWinId(), [pkgName]);
        } else {
            const py = await window.getPyodideInstance();
            if (!py) throw new Error("Failed to initialize Pyodide.");
            if (window.kernelInterrupted) throw new Error("Interrupted");
            if (window.micropip) { 
                await window.micropip.install(pkgName); 
            } else { 
                await py.loadPackage(pkgName); 
            }
        }
        
        if (window.kernelInterrupted) throw new Error("Interrupted");

        window.installedPackages.add(`${kernel}:${pkgName}`);
        if(window.renderStacks) window.renderStacks();

        window.setKernelStatus(pane, `${pkgName} installed!`);
        setTimeout(() => window.resetKernelStatus(pane), 2000);
        if (_nbAway(installWin)) _nbNotify({ id: 'nb-pkg-' + kernel + '-' + pkgName, title: pkgName + ' is installed', text: 'The ' + (kernel === 'r' ? 'R' : 'Python') + ' package ' + pkgName + ' finished installing and can be imported in your notebooks.' });
        
    } catch (err) {
        if (err.message === 'Interrupted') {
            window.setKernelStatus(pane, '[Installation Interrupted]', true);
            setTimeout(() => window.resetKernelStatus(pane), 2000);
        } else {
            window.showCustomModal({title:'Install Failed', text:`Failed to install ${pkgName}: ${err.message}`, submitText:'OK'}, ()=>{});
        }
        // The name goes into a JS string inside an attribute: JSON-quote it, then HTML-escape the whole call argument.
        if(statusDiv) statusDiv.innerHTML = `<i class="ri-download-cloud-2-line pkg-install-btn" onclick="window.installPackage(${CodeMiniEscape.html(JSON.stringify(String(pkgName)))}, ${CodeMiniEscape.html(JSON.stringify(String(kernel)))}, event)" title="Install ${CodeMiniEscape.html(pkgName)}"></i>`;
    } finally { 
        document.querySelectorAll('.status-circle').forEach(c => c.classList.remove('running')); 
        window.kernelInterrupted = false;
    }
};

window.updateVariablesExplorer = async function(pane) {
    const contentDiv = pane.querySelector('.vars-content');
    if (!contentDiv) return;
    
    const kernelStatus = pane.querySelector('.kernel-status');
    const kernelType = kernelStatus ? kernelStatus.dataset.kernel : 'python';
    
    contentDiv.innerHTML = '<div style="text-align:center; padding: 30px;"><i class="ri-loader-4-line" style="animation: spinStatus 0.8s linear infinite; font-size: 24px; color: var(--accent-blue);"></i><p style="margin-top: 10px; color: var(--text-muted);">Fetching variables...</p></div>';

    try {
        let html = '';
        if (kernelType === 'python') {
            let vars;
            if (await _nbUseHost(_getWinId())) {
                // From the host: untrusted, so every field is escaped here (the renderer below only escapes '<').
                const hr = await window.CodeMiniExec.run(_getWinId(), { lang: 'python', code: window.CodeMiniPyVarsCode, opts: { raw: true } });
                const ht = hr && hr.value && hr.value.text;
                vars = (ht ? JSON.parse(ht) : []).map((v) => { const o = {}; for (const k of Object.keys(v)) o[k] = CodeMiniEscape.html(String(v[k])); return o; });
            } else {
            const py = await window.getPyodideInstance();
            if (!py) throw new Error("Kernel not ready");
            
            const code = `
import json, sys, types, builtins

_exclude_names = {
    '__builtins__', '__name__', '__doc__', '__package__', '__loader__', '__spec__',
    '__annotations__', '__file__', '__cached__', '__warningregistry__',
    'sys', 'json', 'types', 'os', 'io', 'js', 'builtins', 'warnings', 'ast',
    'base64', 'copy', 'math', 'random', 're', 'string', 'time', 'datetime',
    'itertools', 'functools', 'collections', 'pathlib', 'traceback',
    'micropip', 'pyodide', 'pyodide_js', 'pyodide_ffi', 'asyncio',
    'matplotlib', 'plt', 'np', 'pd', 'Figure', 'Axes', 'pyplot',
    'AxesSubplot', 'Subplot', 'FigureCanvas', 'NavigationToolbar',
    'display', 'get_ipython', 'exit', 'quit', 'copyright', 'license', 'credits',
    'In', 'Out', 'getsizeof', 'pi', 'e', 'tau', 'inf', 'nan',
    'ainput', 'custom_input', 'display_html', 'is_trusted',
    '_code_to_parse', '_fmt_code', 'builtins_proxy',
    '_matplotlib_cache', 'mpld3', 'IPython',
    'HTML', 'display_html_builtin', '__builtins_snapshot__',
    'k', 'v', 'val_str', 'modules',
}

def _is_public_name(name):
    return (not name.startswith('_') and 
            not name.startswith('\\x00') and
            name not in _exclude_names)

def _is_user_value(v):
    if v is None:
        return False
    vtype = type(v)
    type_name = vtype.__name__
    if type_name in (
        'module', 'function', 'builtin_function_or_method',
        'type', 'method_descriptor', 'wrapper_descriptor',
        'getset_descriptor', 'member_descriptor', 'method-wrapper',
        'classmethod', 'staticmethod', 'ABCMeta', 'property',
        'BuiltinFunctionType', 'BuiltinMethodType', 'FunctionType'
    ):
        return False
    if hasattr(v, '__module__'):
        module = getattr(v, '__module__', '')
        if module and (module.startswith('pyodide') or 
                       module.startswith('_pyodide') or
                       module in ('builtins', 'sys', 'os')):
            return False
    if 'matplotlib' in str(type(v)).lower() or 'tkinter' in str(type(v)).lower():
        return False
    return True

def _collect_variables():
    _vars = []
    for _k in list(globals().keys()):
        if _is_public_name(_k):
            try:
                _v = globals()[_k]
                if _is_user_value(_v):
                    try:
                        _val_str = repr(_v)
                        if len(_val_str) > 50:
                            _val_str = _val_str[:47] + '...'
                        if not _val_str.startswith('<') or _val_str.startswith('<class'):
                            _vars.append({"name": _k, "type": type(_v).__name__, "value": _val_str})
                    except Exception:
                        pass
            except Exception:
                pass
    return _vars

_result = _collect_variables()
json.dumps(_result)
`;

            const res = await py.runPythonAsync(code);
            vars = JSON.parse(res);
            }
            
            if (vars.length === 0) {
                html = '<div class="empty-state" style="padding:30px; text-align:center; color:var(--text-muted);">No variables defined yet.</div>';
            } else {
                html = '<table class="vars-table"><thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead><tbody>';
                vars.forEach(v => {
                    html += `<tr><td style="font-weight:600; color:var(--accent-blue);">${v.name.replace(/</g, '&lt;')}</td><td><span class="var-type-badge">${v.type.replace(/</g, '&lt;')}</span></td><td style="font-family:monospace;">${v.value.replace(/</g, '&lt;')}</td></tr>`;
                });
                html += '</tbody></table>';
            }
        } else if (kernelType === 'sql') {
            let res;
            if (await _nbUseHost(_getWinId())) {
                res = await _nbHostSqlExec(_getWinId(), "SELECT name FROM sqlite_master WHERE type='table';");
            } else {
                const db = await window.getSqlInstance();
                if (!db) throw new Error("Kernel not ready");
                res = db.exec("SELECT name FROM sqlite_master WHERE type='table';");
            }
            if (res.length > 0 && res[0].values.length > 0) {
                html = '<table class="vars-table"><thead><tr><th>Table Name</th></tr></thead><tbody>';
                res[0].values.forEach(row => {
                    html += `<tr><td style="font-weight:600; color:var(--accent-blue);"><i class="ri-table-2" style="margin-right: 5px;"></i>${CodeMiniEscape.html(row[0])}</td></tr>`;
                });
                html += '</tbody></table>';
            } else {
                html = '<div class="empty-state" style="padding:30px; text-align:center; color:var(--text-muted);">No tables created yet.</div>';
            }
        } else {
            html = `<div class="empty-state" style="padding:30px; text-align:center; color:var(--text-muted);">Variable explorer is not yet supported for ${kernelType}.</div>`;
        }
        contentDiv.innerHTML = html;
    } catch (err) {
        contentDiv.innerHTML = `<div style="padding: 20px; color: var(--color-danger); text-align:center;">Failed to fetch variables: ${CodeMiniEscape.html(err.message)}</div>`;
    }
};

window.downloadSqlCsv = function(tableId, filename) {
    const table = document.getElementById(tableId);
    if (!table) return;
    
    let csvContent = "";
    const rows = table.querySelectorAll('tr');
    
    rows.forEach((row) => {
        let rowData = [];
        const cols = row.querySelectorAll('th, td');
        cols.forEach((col) => {
            let data = col.innerText.replace(/"/g, '""');
            rowData.push(`"${data}"`);
        });
        csvContent += rowData.join(",") + "\n";
    });
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

window.copySqlTable = function(tableId) {
    const table = document.getElementById(tableId);
    if (!table) return;
    
    let textContent = "";
    const rows = table.querySelectorAll('tr');
    
    rows.forEach((row) => {
        let rowData = [];
        const cols = row.querySelectorAll('th, td');
        cols.forEach((col) => rowData.push(col.innerText.trim()));
        textContent += rowData.join("\t") + "\n";
    });
    
    navigator.clipboard.writeText(textContent).then(() => {
        if(window.showCustomModal) {
            window.showCustomModal({ title: 'Success', text: 'Table copied to clipboard!', submitText: 'OK' }, () => {});
        }
    }).catch(err => console.error("Clipboard copy failed:", err));
};

function formatPythonCode(code) {
    let lines = code.split('\n'); const formatted = []; let indentLevel = 0; const indentSize = 4;
    for (let line of lines) {
        line = line.trimEnd(); const trimmed = line.trim();
        if (trimmed === '') { formatted.push(''); continue; }
        if (trimmed.match(/^(else|elif|except|finally)/)) indentLevel = Math.max(0, indentLevel - 1);
        formatted.push(' '.repeat(indentLevel * indentSize) + trimmed);
        if (trimmed.endsWith(':') && !trimmed.startsWith('import ') && !trimmed.startsWith('from ')) indentLevel++;
    }
    return formatted.join('\n');
}

function formatJavaScriptCode(code) {
    let formatted = code; let lines = formatted.split('\n'); let indentLevel = 0; const result = [];
    for (let line of lines) {
        line = line.trimEnd(); const trimmed = line.trim();
        if (trimmed === '') { result.push(''); continue; }
        if (trimmed.startsWith('}') || trimmed.startsWith(']')) indentLevel = Math.max(0, indentLevel - 1);
        result.push('  '.repeat(indentLevel) + trimmed);
        if (trimmed.endsWith('{') || trimmed.endsWith('[') || (trimmed.endsWith('(') && !trimmed.endsWith(');'))) indentLevel++;
    }
    return result.join('\n');
}

function getCellCodeFromEditor(cell) {
    if (window.cellMonacoEditors && window.cellMonacoEditors[cell.dataset.cellId]) {
        return window.cellMonacoEditors[cell.dataset.cellId].getValue();
    }
    const monacoContainer = cell.querySelector('.cell-monaco-container');
    if (monacoContainer && monacoContainer.hasAttribute('data-saved-code')) {
        return decodeURIComponent(monacoContainer.getAttribute('data-saved-code'));
    }
    const editor = cell.querySelector('.cell-editor');
    return editor ? editor.innerText : '';
}

function setCellCodeInEditor(cell, code) {
    if (window.cellMonacoEditors && window.cellMonacoEditors[cell.dataset.cellId]) {
        window.cellMonacoEditors[cell.dataset.cellId].setValue(code);
        return;
    }
    const editor = cell.querySelector('.cell-editor');
    if (editor) editor.innerText = code;
}

// ---- Python cells on the runner's host (Isolation on for Notebooks) ---------------------------------------------------------------
// The notebook's Python then runs in the same per-window host as the Console, the Terminal and the editor's Run, so they share one Python session and
// none of it can touch the app. Everything the host sends back is untrusted: output is escaped, HTML goes through the sanitizer, plots through the
// base64 filter, and variable names and values are escaped before they reach the Variables Explorer. R and SQL cells still run in the app.
window._nbHostRun = window._nbHostRun || {};

// The scratchpad's Python on the host: the same session as this window's cells. Returns the payload shape of the in-app wrapper
// ({ stdout, stderr, plots, result }) so the scratchpad's existing rendering (textContent, filtered base64) is reused as it is.
async function _nbHostScratch(winId, code) {
    let stdout = '', stderr = '';
    const res = await window.CodeMiniExec.run(winId, { lang: 'python', code, opts: { trusted: !window.WorkspaceTrust || window.WorkspaceTrust.isTrusted(), autoInstall: !(window.appSettings && window.appSettings.nbAutoInstall === false) } },
        (e) => { if (e.kind === 'stdout') stdout += e.text; else if (e.kind === 'stderr') stderr += e.text; },
        (text) => (window.inlineInputPrompt ? window.inlineInputPrompt(text) : Promise.resolve(window.prompt(text) || '')));
    if (res.error) stderr += (res.error.text || res.error.message) + '\n';
    return { stdout, stderr, plots: Array.isArray(res.plots) ? res.plots : [], result: res.value && res.value.text ? String(res.value.text) : '' };
}

// SQL on the host: sql.js runs there and sends the result sets back as JSON text. That text is untrusted, so it is validated into the shape of
// db.exec()'s return value here, and (for the cell and the scratchpad) escaped field by field before the existing renderers see it.
async function _nbHostSqlExec(winId, sql) {
    const res = await window.CodeMiniExec.run(winId, { lang: 'sql', code: sql, opts: {} }, () => {}, () => Promise.resolve(''));
    // The host answers BadRequest to a language it does not know: that happens when the deployed runner is older than this app (the two deploy separately).
    if (res.error) throw new Error(res.error.name === 'BadRequest' ? 'The runner did not accept this SQL: it is too long, or the deployed runner is older than this version and does not know SQL yet. Redeploy the runner, or set Settings > Security > Notebooks to Normal.' : (res.error.message || 'SQL error'));
    let sets;
    try { sets = JSON.parse(res.value && res.value.type === 'sql' ? res.value.text : '[]'); } catch (e) { return []; }
    if (!Array.isArray(sets)) return [];
    const cell = (v) => (v === null ? null : (typeof v === 'number' || typeof v === 'string') ? v : String(v));
    return sets.filter((r) => r && Array.isArray(r.columns) && Array.isArray(r.values))
        .map((r) => ({ columns: r.columns.map(String), values: r.values.filter(Array.isArray).map((row) => row.map(cell)), cut: r.cut === true }));
}
function _nbEscapeSets(sets) {
    return sets.map((r) => ({ columns: r.columns.map((c) => CodeMiniEscape.html(c)), cut: r.cut,
        values: r.values.map((row) => row.map((v) => (v === null ? null : CodeMiniEscape.html(String(v))))) }));
}
// The SQL cell on the host: registers the run so that Interrupt can end it, and returns the escaped result sets.
async function _nbHostSqlCell(winId, sql) {
    const hostRun = { interrupted: false };
    window._nbHostRun[winId] = hostRun;
    try {
        return _nbEscapeSets(await _nbHostSqlExec(winId, sql));
    } catch (e) {
        if (hostRun.interrupted || window.kernelInterrupted) { const kk = new Error('KeyboardInterrupt'); kk.hostKilled = hostRun.interrupted; kk.hostInterrupt = true; throw kk; }
        throw e;
    } finally {
        if (window._nbHostRun[winId] === hostRun) delete window._nbHostRun[winId];
    }
}

// The package manager for R on the host (webR's installPackages runs there). Registered like a run so that Interrupt can end it.
async function _nbHostRInstall(winId, pkgs) {
    const run = { interrupted: false };
    window._nbHostRun[winId] = run;
    try {
        const res = await window.CodeMiniExec.run(winId, { lang: 'r', code: '# install', opts: { install: pkgs.map(String) } }, () => {}, () => Promise.resolve(''));
        if (res.error) throw new Error(res.error.name === 'BadRequest' ? _NB_OLD_RUNNER_R : (res.error.message || 'install failed'));
    } catch (e) {
        if (run.interrupted) throw new Error('Interrupted');
        throw e;
    } finally {
        if (window._nbHostRun[winId] === run) delete window._nbHostRun[winId];
    }
}
const _NB_OLD_RUNNER_R = 'The runner did not accept this R code: it is too long, or the deployed runner is older than this version and does not know R yet. Redeploy the runner, or set Settings > Security > Notebooks to Normal.';

async function _nbUseHost(winId) {
    return !!(window.CodeMiniExec && await window.CodeMiniExec.use('notebooks', winId));
}

// '!pip install' and the package manager: micropip lives inside the host's Pyodide, so the install happens there.
async function _nbHostPip(winId, pkgs) {
    const run = { interrupted: false };
    window._nbHostRun[winId] = run;
    try {
        const code = "import pyodide_js\nawait pyodide_js.loadPackage('micropip')\nimport micropip\nawait micropip.install(" + JSON.stringify(pkgs.map(String)) + ")";
        const res = await window.CodeMiniExec.run(winId, { lang: 'python', code, opts: { trusted: true, autoInstall: false } }, () => {}, () => Promise.resolve(''));
        if (res.error) throw new Error(res.error.message || res.error.text || 'install failed');
    } catch (e) {
        if (run.interrupted) throw new Error('Interrupted');
        throw e;
    } finally {
        if (window._nbHostRun[winId] === run) delete window._nbHostRun[winId];
    }
}

async function runCell(cell, pane) {
    // Workspace Trust: executing a code cell runs workspace content, which Restricted Mode turns off.
    // (Markdown/raw cells only render, and their output is sanitized below, so they stay usable.)
    if ((cell.dataset.cellType || 'code') === 'code' && window.WorkspaceTrust && !window.WorkspaceTrust.guard('Running notebook cells')) return;
    const code = getCellCodeFromEditor(cell);
    if (!code && !code.trim()) return;

    if (cell.dataset.lastExecutedCode === code) {
        let outputWrapper = cell.querySelector('.cell-output-wrapper');
        if (outputWrapper) {
            const origBorder = outputWrapper.style.borderLeft;
            outputWrapper.style.borderLeft = '3px solid var(--term-green)';
            outputWrapper.style.paddingLeft = '10px';
            setTimeout(() => {
                outputWrapper.style.borderLeft = origBorder;
                outputWrapper.style.paddingLeft = '0';
            }, 400);
        }
        return; 
    }
    
    let outputWrapper = cell.querySelector('.cell-output-wrapper');
    if (!outputWrapper) {
        outputWrapper = document.createElement('div'); outputWrapper.className = 'cell-output-wrapper'; cell.querySelector('.cell-content-wrapper').appendChild(outputWrapper);
    }
    
    if (window.kernelInterrupted) { 
        outputWrapper.innerHTML = '<div class="cell-output"><span style="color: var(--color-danger); font-weight: bold;">[Execution Interrupted] The kernel was stopped by the user. Please restart if necessary.</span></div>'; 
        return; 
    }

    outputWrapper.innerHTML = '';
    
    let outputDiv = document.createElement('div'); outputDiv.className = 'cell-output';
    let plotContainer = document.createElement('div'); plotContainer.className = 'plot-container';

    outputWrapper.appendChild(outputDiv);
    outputWrapper.appendChild(plotContainer);

    const prompt = cell.querySelector('.cell-prompt'); const originalPrompt = prompt.innerHTML;
    
    const kernelStatus = pane.querySelector('.kernel-status');
    const kernelType = kernelStatus ? kernelStatus.dataset.kernel : 'python';
    const cellType = cell.dataset.cellType || 'code';
    
    const trustLink = pane.querySelector('.tb-trust');
    const isTrusted = (trustLink ? trustLink.dataset.trusted === 'true' : true) && (!window.WorkspaceTrust || window.WorkspaceTrust.isTrusted());
    
    if (cellType === 'markdown') {
        let renderedHtml = await renderMarkdown(code);
        if (!isTrusted) {
            let wasBlocked = false;
            const parser = new DOMParser();
            const doc = parser.parseFromString(renderedHtml, 'text/html');
            const scripts = doc.querySelectorAll('script');
            if (scripts.length > 0) wasBlocked = true;
            scripts.forEach(s => s.remove());
            doc.querySelectorAll('*').forEach(el => {
                for (let i = el.attributes.length - 1; i >= 0; i--) {
                    const attr = el.attributes[i];
                    if (attr.name.toLowerCase().startsWith('on') || attr.value.toLowerCase().includes('javascript:')) {
                        el.removeAttribute(attr.name);
                        wasBlocked = true;
                    }
                }
            });
            renderedHtml = doc.body.innerHTML;
            if (wasBlocked) {
                const indicator = `<div class="blocked-content-indicator" style="color:var(--color-danger); border: 1px dashed var(--color-danger); padding: 5px; border-radius: 4px; font-size:12px; margin-bottom:5px; background: rgba(211, 47, 47, 0.05);"><i class="ri-shield-flash-line"></i> Sanitized Output: Blocked unsafe scripts/events (Untrusted)</div>\n`;
                renderedHtml = indicator + renderedHtml;
            }
        }
        outputWrapper.innerHTML = `<div class="markdown-rendered custom-markdown-view" title="Double click to edit">${renderedHtml}</div>`;
        cell.classList.add('markdown-mode-active');
        cell.dataset.lastExecutedCode = code;
        triggerNotebookSave(pane);
        setTimeout(() => window.generateTOC(pane), 200);
        return;
    }

    if (cellType === 'raw') {
        outputWrapper.innerHTML = '';
        cell.dataset.lastExecutedCode = code;
        triggerNotebookSave(pane);
        return;
    }
    
    prompt.innerHTML = '[*]:'; prompt.style.color = 'var(--accent-blue)'; outputDiv.innerHTML = '<span style="color: var(--accent-blue);">Running...</span>'; plotContainer.innerHTML = '';
    
    const statusCircle = pane.querySelector('.status-circle');
    if (statusCircle) statusCircle.classList.add('running');
    
    const interruptBtns = pane.querySelectorAll('.tb-interrupt');
    interruptBtns.forEach(b => b.classList.remove('disabled'));
    
    const startTime = performance.now();
    
    window._activeCellRegistry = window._activeCellRegistry || {};
    window._activeCellRegistry[_getWinId()] = cell;

    const interruptCheck = () => window.kernelInterrupted; window.kernelInterrupted = false;

    try {
        let outputText = ''; let errorText = '';
        let plots = [];
        let useHost = false;
        {
            useHost = await _nbUseHost(_getWinId());
            if (!useHost) { const note = window.CodeMiniExec && window.CodeMiniExec.fallbackNotice('notebooks'); if (note) outputText += '[Note] ' + note + '\n'; }
        }

        if (kernelType === 'sql') {
            const db = useHost ? null : await window.getSqlInstance();
            if (!db && !useHost) throw new Error("Failed to load SQL runtime.");
            if (interruptCheck()) throw new Error("KeyboardInterrupt");
            
            try {
                const res = useHost ? await _nbHostSqlCell(_getWinId(), code) : db.exec(code);
                if (res.length > 0) {
                    res.forEach((resultset, idx) => {
                        let tableId = 'sql-table-' + Date.now() + '-' + idx;
                        let tableHtml = `<div class="sql-table-responsive" style="margin-bottom: 10px;">`;
                        tableHtml += `<table id="${tableId}">`;
                        tableHtml += `<thead><tr>`;
                        resultset.columns.forEach(col => {
                            tableHtml += `<th>${col.replace(/</g, '&lt;')}</th>`;
                        });
                        tableHtml += '</tr></thead><tbody>';
                        resultset.values.forEach(row => {
                            tableHtml += '<tr>';
                            row.forEach(val => {
                                const displayVal = val === null ? '<em style="color: var(--text-muted);">NULL</em>' : String(val).replace(/</g, '&lt;');
                                tableHtml += `<td>${displayVal}</td>`;
                            });
                            tableHtml += '</tr>';
                        });
                        tableHtml += '</tbody></table></div>';

                        let toolbarHtml = `
                            <div style="display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 15px;">
                                <button class="sql-table-btn" onclick="window.downloadSqlCsv('${tableId}', 'query_result.csv')" style="background: transparent; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 10px; cursor: pointer; color: var(--text-muted); font-size: 12px; transition: all 0.2s;"><i class="ri-download-line"></i> CSV</button>
                                <button class="sql-table-btn" onclick="window.copySqlTable('${tableId}')" style="background: transparent; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 10px; cursor: pointer; color: var(--text-muted); font-size: 12px; transition: all 0.2s;"><i class="ri-clipboard-line"></i> Copy</button>
                                <button class="sql-table-btn" onclick="window.openTablePreview('${tableId}', 'Cell ${getNextExecutionCount(cell)}')" style="background: transparent; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 10px; cursor: pointer; color: var(--text-muted); font-size: 12px; transition: all 0.2s;"><i class="ri-fullscreen-line"></i> Maximize</button>
                            </div>
                        `;
                        outputText += tableHtml + toolbarHtml;
                    });
                    if (res.some((r) => r.cut)) outputText += '<span style="color: var(--text-muted);">[Result cut: only the first rows are shown]</span>';
                } else {
                    outputText += '<span style="color: var(--term-green);">Success (no result to display)</span>';
                }
            } catch(e) {
                if (e && e.hostInterrupt) throw e;   // Interrupt shut the host down on purpose: not an SQL error
                errorText += e.message;
            }

        } else if (kernelType === 'r' && useHost) {
            // R on the runner's per-window host (one environment per host; plots come back as base64 and go through the filter below).
            const winId = _getWinId();
            const execCode = code.split('\n').filter((l) => !l.trim().startsWith('%time')).join('\n');
            if (interruptCheck()) throw new Error("KeyboardInterrupt");
            if (window.getNbAutoInstall() && /(?:library|require)\(\s*(['"]?)([^)'"\s]+)\1\s*\)/.test(execCode)) {
                outputDiv.innerHTML = '<span style="color: var(--accent-blue);">Resolving R dependencies...</span>';
            }
            const hostRun = { interrupted: false };
            window._nbHostRun[winId] = hostRun;
            let evOut = '', evErr = '', hostRes;
            try {
                hostRes = await window.CodeMiniExec.run(winId, { lang: 'r', code: execCode, opts: { autoInstall: !!window.getNbAutoInstall() } },
                    (e) => { if (e.kind === 'stdout') evOut += e.text; else if (e.kind === 'stderr') evErr += e.text; },
                    () => Promise.resolve(''));
            } catch (e) {
                if (hostRun.interrupted || window.kernelInterrupted) { const kk = new Error('KeyboardInterrupt'); kk.hostKilled = hostRun.interrupted; throw kk; }
                throw e;
            } finally {
                if (window._nbHostRun[winId] === hostRun) delete window._nbHostRun[winId];
            }
            if (hostRes.error) throw new Error(hostRes.error.name === 'BadRequest' ? _NB_OLD_RUNNER_R : hostRes.error.message);
            outputText += evOut;
            errorText += evErr;
            plots = Array.isArray(hostRes.plots) ? hostRes.plots : [];
        } else if (kernelType === 'r') {
            const webr = await window.getWebRInstance();
            if (!webr) throw new Error("Failed to load WebR runtime. Please refresh the page.");
            if (interruptCheck()) throw new Error("KeyboardInterrupt");
            
            const winId = _getWinId();
            const rEnv = await window.getRNamespace(webr, winId);
            
            let lines = code.split('\n');
            let cleanCodeLines = [];
            for (let line of lines) {
                if(line.trim().startsWith('%time')) {
                } else {
                    cleanCodeLines.push(line);
                }
            }
            let execCode = cleanCodeLines.join('\n');

            if (window.getNbAutoInstall()) {
                const rImports = [...execCode.matchAll(/(?:library|require)\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g)].map(m => m[2]);
                if (rImports.length > 0) {
                    outputDiv.innerHTML = '<span style="color: var(--accent-blue);">Resolving R dependencies...</span>';
                    try {
                        await webr.installPackages(rImports);
                    } catch (err) {
                        console.warn("Could not auto-install some R packages:", err);
                    }
                }
            }
            
            if (interruptCheck()) throw new Error("KeyboardInterrupt");
            
            let shelter = await new webr.Shelter();
            
            const tmpFolder = '/tmp/win_' + winId.replace(/[^a-zA-Z0-9]/g, '_');
            try { await webr.FS.mkdir(tmpFolder); } catch(e) {}
            
            try {
                try {
                    const oldFiles = await window._rListFiles(webr, tmpFolder, '^webr_plot_');
                    for(let f of oldFiles) {
                        if(f.startsWith('webr_plot_')) await webr.FS.unlink(tmpFolder + '/' + f);
                    }
                } catch(e) {}

                await webr.evalRVoid(`png(file="${tmpFolder}/webr_plot_%03d.png", width=800, height=600, res=100)`);

                const capture = await shelter.captureR(execCode, {
                    withAutoprint: true,
                    captureStreams: true,
                    captureConditions: false,
                    captureGraphics: false,   // the png device above gets the plot; webR's canvas device would take it otherwise (and has reloaded iOS)
                    env: rEnv
                });
                
                capture.output.forEach(out => {
                    if (out.type === 'stdout') outputText += out.data + '\n';
                    if (out.type === 'stderr') errorText += out.data + '\n';
                });
            } finally {
                shelter.purge();
                await webr.evalRVoid(`tryCatch(dev.off(), error=function(e) NULL)`);
                
                try {
                    const files = await window._rListFiles(webr, tmpFolder, '^webr_plot_.*[.]png$');
                    for (let f of files) {
                        if (f.startsWith('webr_plot_') && f.endsWith('.png')) {
                            const fileData = await webr.FS.readFile(tmpFolder + '/' + f);
                            let binary = '';
                            const bytes = new Uint8Array(fileData);
                            if (!bytes.byteLength) { errorText += '[R plot not read: ' + f + ' is empty]\n'; await webr.FS.unlink(tmpFolder + '/' + f); continue; }
                            for (let i = 0; i < bytes.byteLength; i++) {
                                binary += String.fromCharCode(bytes[i]);
                            }
                            plots.push(btoa(binary));
                            await webr.FS.unlink(tmpFolder + '/' + f);
                        }
                    }
                } catch(e) {
                    console.error("R Plot Capture Error:", e);
                    errorText += '[R plot not read: ' + ((e && e.message) || String(e)) + ']\n';   // shown in the cell: there is no console on a phone
                }
            }

        } else if (useHost) {
            // Python on the runner's per-window host. Keep the magics in step with the in-app branch below.
            const winId = _getWinId();
            let lines = code.split('\n');
            let cleanCodeLines = [];
            let pipInstalls = [];
            let isTimeMagic = false;

            for (let line of lines) {
                const tLine = line.trim();
                if (tLine.startsWith('!pip install ')) {
                    let pkgs = tLine.replace('!pip install', '').trim().split(/\s+/);
                    pipInstalls.push(...pkgs);
                } else if (tLine.startsWith('!ls')) {
                    cleanCodeLines.push("import os; print('\\n'.join(os.listdir('.')))");
                } else if (tLine.startsWith('!pwd')) {
                    cleanCodeLines.push("import os; print(os.getcwd())");
                } else if (tLine.startsWith('!echo ')) {
                    cleanCodeLines.push(`print("${tLine.replace('!echo ', '').replace(/"/g, '\\"')}")`);
                } else if (tLine.startsWith('%time ') || tLine.startsWith('%%time')) {
                    isTimeMagic = true;
                    if (tLine.startsWith('%time ')) {
                        cleanCodeLines.push(line.replace('%time ', ''));
                    }
                } else if (tLine.startsWith('%matplotlib')) {
                } else {
                    cleanCodeLines.push(line);
                }
            }
            const cleanCode = cleanCodeLines.join('\n');

            if (pipInstalls.length > 0) {
                outputDiv.innerHTML = `<span style="color: var(--accent-blue);">Installing packages: ${CodeMiniEscape.html(pipInstalls.join(', '))}...</span>`;
                try {
                    await _nbHostPip(winId, pipInstalls);
                } catch (e) {
                    if (e.message === 'Interrupted') { const k = new Error('KeyboardInterrupt'); k.hostKilled = true; throw k; }
                    errorText += `Failed to pip install: ${e.message}\n`;
                }
            }
            if (interruptCheck()) throw new Error("KeyboardInterrupt");
            if (window.getNbAutoInstall()) outputDiv.innerHTML = '<span style="color: var(--accent-blue);">Resolving Python dependencies...</span>';

            const hostRun = { interrupted: false };
            window._nbHostRun[winId] = hostRun;
            let evOut = '', evErr = '';
            const htmlParts = [];
            const jsStartTime = performance.now();
            let hostRes;
            try {
                hostRes = await window.CodeMiniExec.run(winId, { lang: 'python', code: cleanCode, opts: { trusted: isTrusted, autoInstall: !!window.getNbAutoInstall() } },
                    (e) => { if (e.kind === 'stdout') evOut += e.text; else if (e.kind === 'stderr') evErr += e.text; else if (e.kind === 'html') htmlParts.push(e.text); },
                    (text) => (window.inlineInputPrompt ? window.inlineInputPrompt(text) : Promise.resolve(window.prompt(text) || '')));
            } catch (e) {
                // Interrupt shuts the host down on purpose: that is an interruption, not a failure.
                if (hostRun.interrupted || window.kernelInterrupted) { const k = new Error('KeyboardInterrupt'); k.hostKilled = hostRun.interrupted; throw k; }
                throw e;
            } finally {
                if (window._nbHostRun[winId] === hostRun) delete window._nbHostRun[winId];
            }
            const jsEndTime = performance.now();
            if (hostRes.error) throw new Error(hostRes.error.text || hostRes.error.message);
            if (isTimeMagic) {
                outputText += `CPU times: user ${(jsEndTime - jsStartTime).toFixed(2)} ms, sys: 0.00 ms, total: ${(jsEndTime - jsStartTime).toFixed(2)} ms\nWall time: ${(jsEndTime - jsStartTime).toFixed(2)} ms\n`;
            }
            outputText += evOut;
            errorText += evErr;
            if (hostRes.value && hostRes.value.text) outputText += String(hostRes.value.text);
            for (const h of htmlParts) {
                const displayDiv = document.createElement('div');
                displayDiv.className = 'cell-output custom-display';
                displayDiv.style.backgroundColor = 'transparent';
                displayDiv.style.padding = '10px 15px';
                displayDiv.innerHTML = CodeMiniEscape.sanitize(h);   // always sanitized: scripts from the sandbox never run in the app
                outputWrapper.insertBefore(displayDiv, plotContainer);
            }
            plots = Array.isArray(hostRes.plots) ? hostRes.plots : [];
        } else {
            const py = await window.getPyodideInstance();
            if (!py) throw new Error("Failed to load Pyodide runtime. Please refresh the page.");
            if (interruptCheck()) throw new Error("KeyboardInterrupt");
            
            py.runPython(`import builtins\nbuiltins.is_trusted = ${isTrusted ? 'True' : 'False'}`);
            
            let lines = code.split('\n');
            let cleanCodeLines = [];
            let pipInstalls = [];
            let isTimeMagic = false;

            for (let line of lines) {
                const tLine = line.trim();
                if (tLine.startsWith('!pip install ')) {
                    let pkgs = tLine.replace('!pip install', '').trim().split(/\s+/);
                    pipInstalls.push(...pkgs);
                } else if (tLine.startsWith('!ls')) {
                    cleanCodeLines.push("import os; print('\\n'.join(os.listdir('.')))");
                } else if (tLine.startsWith('!pwd')) {
                    cleanCodeLines.push("import os; print(os.getcwd())");
                } else if (tLine.startsWith('!echo ')) {
                    cleanCodeLines.push(`print("${tLine.replace('!echo ', '').replace(/"/g, '\\"')}")`);
                } else if (tLine.startsWith('%time ') || tLine.startsWith('%%time')) {
                    isTimeMagic = true;
                    if (tLine.startsWith('%time ')) {
                        cleanCodeLines.push(line.replace('%time ', ''));
                    }
                } else if (tLine.startsWith('%matplotlib')) {
                } else {
                    cleanCodeLines.push(line);
                }
            }

            const cleanCode = cleanCodeLines.join('\n');

            if (pipInstalls.length > 0) {
                outputDiv.innerHTML = `<span style="color: var(--accent-blue);">Installing packages: ${pipInstalls.join(', ')}...</span>`;
                try {
                    if (window.micropip) {
                        await window.micropip.install(pipInstalls);
                    }
                } catch(e) {
                    errorText += `Failed to pip install: ${e.message}\n`;
                }
            }
            if (interruptCheck()) throw new Error("KeyboardInterrupt");

            if (window.getNbAutoInstall()) {
                outputDiv.innerHTML = '<span style="color: var(--accent-blue);">Resolving Python dependencies...</span>';
                
                try {
                    await py.loadPackagesFromImports(cleanCode);
                } catch (err) {
                    console.warn("Pyodide native load warning:", err);
                }
                
                try {
                    py.globals.set('_code_to_parse', cleanCode);
                    const importedModules = py.runPython(`
import ast
try:
    tree = ast.parse(_code_to_parse)
    modules = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for n in node.names: modules.add(n.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module: modules.add(node.module.split('.')[0])
    list(modules)
except Exception:
    []
                    `);
                    if (importedModules && importedModules.toJs) {
                        const mods = importedModules.toJs();
                        const pkgsToInstall = mods.filter(m => m !== 'seaborn' && m !== 'requests');
                        if (pkgsToInstall.length > 0 && window.micropip) {
                            await window.micropip.install(pkgsToInstall);
                        }
                        importedModules.destroy();
                    }
                } catch (err) {
                    console.warn("Could not auto-install PyPI packages via micropip:", err);
                }
            }
            
            if (interruptCheck()) throw new Error("KeyboardInterrupt");
            
            py.runPython(`
import sys, io
_cm_stdout = io.StringIO()
_cm_stderr = io.StringIO()
sys.stdout = _cm_stdout
sys.stderr = _cm_stderr
`);

            try {
                let jsStartTime = isTimeMagic ? performance.now() : 0;
                const result = await py.runPythonAsync(cleanCode);
                let jsEndTime = isTimeMagic ? performance.now() : 0;

                if (interruptCheck()) throw new Error("KeyboardInterrupt");
                
                const stdout = py.runPython("_cm_stdout.getvalue()"); 
                const stderr = py.runPython("_cm_stderr.getvalue()");
                
                if (isTimeMagic) {
                    outputText += `CPU times: user ${(jsEndTime - jsStartTime).toFixed(2)} ms, sys: 0.00 ms, total: ${(jsEndTime - jsStartTime).toFixed(2)} ms\nWall time: ${(jsEndTime - jsStartTime).toFixed(2)} ms\n`;
                }

                if (stdout) outputText += stdout; 
                if (stderr) errorText += stderr;
                if (result !== undefined && result !== null) { 
                    const resultStr = result.toString(); 
                    if (resultStr !== 'undefined' && resultStr !== 'null') outputText += resultStr; 
                }
            } catch (execError) {
                const stderr = py.runPython("sys.stderr.getvalue()"); 
                if (stderr) errorText += stderr; 
                throw execError;
            }
            
            try {
                const plotCode = `
import matplotlib
matplotlib.use('agg')
import matplotlib.pyplot as plt
import io, base64
_figs = [plt.figure(n) for n in plt.get_fignums()]
_res = []
for _fig in _figs:
    _buf = io.BytesIO()
    _fig.savefig(_buf, format='png', bbox_inches='tight', dpi=100)
    _res.append(base64.b64encode(_buf.getvalue()).decode('utf-8'))
plt.close('all')
_res
`;
                const proxy = await py.runPythonAsync(plotCode);
                if (proxy && proxy.toJs) { plots = proxy.toJs(); proxy.destroy(); }
            } catch(e) { console.error("Plot render error:", e); }
        }

        const endTime = performance.now();
        const execTime = ((endTime - startTime) / 1000).toFixed(2);

        if (!isTrusted && kernelType === 'sql') {
            let wasBlocked = false;
            const parser = new DOMParser();
            const doc = parser.parseFromString(outputText, 'text/html');
            const scripts = doc.querySelectorAll('script');
            if (scripts.length > 0) wasBlocked = true;
            scripts.forEach(s => s.remove());
            doc.querySelectorAll('*').forEach(el => {
                for (let i = el.attributes.length - 1; i >= 0; i--) {
                    const attr = el.attributes[i];
                    if (attr.name.toLowerCase().startsWith('on') || attr.value.toLowerCase().includes('javascript:')) {
                        el.removeAttribute(attr.name);
                        wasBlocked = true;
                    }
                }
            });
            outputText = doc.body.innerHTML;
            if (wasBlocked) {
                const indicator = `<div class="blocked-content-indicator" style="color:var(--color-danger); border: 1px dashed var(--color-danger); padding: 5px; border-radius: 4px; font-size:12px; margin-bottom:5px; background: rgba(211, 47, 47, 0.05);"><i class="ri-shield-flash-line"></i> Sanitized Output: Blocked unsafe scripts/events (Untrusted)</div>\n`;
                outputText = indicator + outputText;
            }
        }

        outputDiv.innerHTML = '';

        if (outputText || errorText) {
            const actionsBar = document.createElement('div');
            actionsBar.className = 'output-actions-bar';
            actionsBar.innerHTML = `
                <i class="ri-file-copy-line output-copy-btn" title="Copy Output"></i>
                <i class="ri-arrow-up-s-line output-collapse-btn" title="Collapse Output"></i>
            `;
            outputWrapper.insertBefore(actionsBar, outputDiv);
        }

        if (outputText) { 
            if (kernelType === 'sql') {
                outputDiv.style.backgroundColor = 'transparent';
                outputDiv.style.padding = '0';
                outputDiv.innerHTML += outputText;
            } else {
                const outputLines = outputText.split('\n'); 
                outputDiv.innerHTML += outputLines.map(line => line === '' ? '&nbsp;' : line.replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>'); 
            }
        }
        if (errorText) outputDiv.innerHTML += `<span style="color: var(--color-danger);">${errorText.replace(/\n/g, '<br>').replace(/</g, '&lt;')}</span>`;
        
        if (plots.length > 0) {
            const bgStr = (window.appSettings && window.appSettings.nbPlotBackground === 'Transparent') ? 'transparent' : 'var(--bg-white)';
            
            plots.forEach((b64, idx) => { 
                const card = document.createElement('div'); 
                card.className = 'plot-card'; 
                card.style.display = 'inline-block';
                card.style.padding = '0';
                card.style.overflow = 'hidden';
                card.style.border = '1px solid var(--border-color)';                

                const imgSrc = `data:image/png;base64,${String(b64).replace(/[^A-Za-z0-9+/=]/g, '')}`;
                
                card.innerHTML = `
                    <div style="padding: 10px; background: ${bgStr}; text-align: center;">
                        <img src="${imgSrc}" class="output-plot-img" style="max-width:100%; display:inline-block;" />
                    </div>
                    <div class="plot-toolbar" style="display:flex; justify-content:flex-end; gap:12px; padding: 6px 10px; background: var(--bg-panel); border-top: 1px solid var(--border-color);">
                        <i class="ri-download-2-line plot-dl-btn" title="Download Plot" style="cursor:pointer; color:var(--icon-gray); font-size:15px; transition:color 0.2s;"></i>
                        <i class="ri-fullscreen-line plot-max-btn" title="Maximize Plot" style="cursor:pointer; color:var(--icon-gray); font-size:15px; transition:color 0.2s;"></i>
                    </div>
                `; 
                plotContainer.appendChild(card); 
            }); 
        }

        if (!outputDiv.innerHTML) outputDiv.remove();
        if (plots.length === 0) plotContainer.remove();
        
        const customDisplays = outputWrapper.querySelectorAll('.custom-display').length;
        if (!outputText && !errorText && plots.length === 0 && customDisplays === 0) {
             outputWrapper.innerHTML = '<div class="cell-output"><span style="color: var(--text-muted); font-style: italic;">(Completed with no output)</span></div>';
        }
        
        const timeDiv = document.createElement('div');
        timeDiv.style.cssText = "font-size: 10px; color: var(--text-muted); text-align: right; margin-top: 5px; width: 100%;";
        timeDiv.textContent = `Executed in ${execTime}s`;
        outputWrapper.appendChild(timeDiv);
        
        prompt.innerHTML = originalPrompt.replace('[ ]:', `[${getNextExecutionCount(cell)}]:`); prompt.style.color = '';
        
    } catch (err) {
        console.error("Execution error:", err); const errorMessage = err.toString();
        if (errorMessage.includes('KeyboardInterrupt') || errorMessage.includes('InterruptException') || window.kernelInterrupted) {
            if (err && err.hostKilled) {
                outputDiv.innerHTML = '<span style="color: var(--color-danger); font-weight: bold;">[Execution Interrupted] The kernel was stopped by the user. The isolated host of this window was shut down, so the variables of its Python, R and SQL sessions were reset.</span>';
            } else {
                outputDiv.innerHTML = '<span style="color: var(--color-danger); font-weight: bold;">[Execution Interrupted] The kernel was stopped by the user.</span>';
            }
        } else {
            outputDiv.innerHTML = `<span style="color: var(--color-danger);">Error: ${CodeMiniEscape.html(errorMessage).replace(/\n/g, '<br>')}</span>`;
        }
        prompt.innerHTML = originalPrompt; prompt.style.color = '';
    } finally {
        if (statusCircle) statusCircle.classList.remove('running');
        interruptBtns.forEach(b => b.classList.add('disabled'));
        window.kernelInterrupted = false; 
        
        cell.dataset.lastExecutedCode = code;
        
        triggerNotebookSave(pane);

        const varsPanel = pane.querySelector('.vars-explorer-panel');
        if (varsPanel && varsPanel.classList.contains('show')) {
            setTimeout(() => {
                window.updateVariablesExplorer(pane);
            }, 100);
        }
        
        setTimeout(() => window.generateTOC(pane), 200);
    }
}

function getNextExecutionCount(cell) { 
    return Array.from(cell.closest('.cells-container').querySelectorAll('.cell')).indexOf(cell) + 1; 
}

function exportNotebook(pane) {
    const cells = pane.querySelectorAll('.cell');
    const kernelStatus = pane.querySelector('.kernel-status');
    const kernelType = kernelStatus ? kernelStatus.dataset.kernel : 'python';
    const lang = kernelType === 'r' ? 'r' : (kernelType === 'sql' ? 'sql' : 'python3');
    
    const trustLink = pane.querySelector('.tb-trust');
    const isTrusted = trustLink ? trustLink.dataset.trusted === 'true' : true;
    
    const notebookData = { cells: [], metadata: { kernel: lang, language: kernelType, trusted: isTrusted } };
    cells.forEach(cell => {
        const code = getCellCodeFromEditor(cell);
        const outputs = []; const outputDiv = cell.querySelector('.cell-output'); const plotContainer = cell.querySelector('.plot-container');
        
        const tagsContainer = cell.querySelector('.cell-tags');
        const tags = tagsContainer ? Array.from(tagsContainer.querySelectorAll('.cell-tag')).map(t => t.textContent.trim()) : [];
        const cellMetadata = tags.length > 0 ? { tags: tags } : {};

        if (outputDiv && outputDiv.innerHTML && !outputDiv.classList.contains('collapsed')) {
            outputs.push({ output_type: 'stream', text: outputDiv.innerText });
        }
        if (plotContainer) {
            plotContainer.querySelectorAll('img').forEach(img => { 
                outputs.push({ output_type: 'display_data', data: { 'image/png': img.src.split(',')[1] } }); 
            });
        }
        
        notebookData.cells.push({ cell_type: cell.dataset.cellType || 'code', metadata: cellMetadata, source: code, outputs: outputs });
    });
    return JSON.stringify(notebookData, null, 2);
}