// The only addresses allowed to embed this runner and send it work. Keep it in step with the frame-ancestors
// value in vercel.json (the browser enforces that one; this list is the second, in-page check).
(function () {
    'use strict';
    var parents = ['https://codemini-ide.vercel.app'];
    // Development: a runner served from localhost may also be driven by a CodeMini served from localhost.
    // The deployed runner (a vercel.app host) never includes these.
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        parents.push('http://localhost:8765', 'http://127.0.0.1:8765');
    }
    // The runner is its own deployment, so it can be older than the app that talks to it. `version` is this runner's level: it goes UP when the
    // app starts to depend on something new here, and js/viewers/runner-client.js (RUNNER_NEEDS) is raised with it. Both pages send it, with
    // `build`, in their hello-ack, and the app refuses a runner below the level it needs, saying why (a runner from before this field says
    // nothing, which counts as 0). `build` is only shown to the person (the date of the change); nothing depends on it.
    //   1 previews (shell.html)
    //   2 + the Console and Terminal host (exec.html)
    //   3 + editor Run and Debug, Python, R and SQL notebooks, one session per window
    //   4 + R plots found by asking R for the file list (webR's FS has no readdir)
    // (The build date moves with any change to the runner files, even one that does not raise the level: 2026-10-31 pinned webR to v0.6.0.)
    window.CM_RUNNER_CONFIG = Object.freeze({ allowedParents: Object.freeze(parents), version: 4, build: '2026-10-31' });
})();
