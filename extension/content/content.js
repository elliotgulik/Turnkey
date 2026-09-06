// Entry point for the Google Earth content script. Kept as a classic
// (non-module) script — Manifest V3 content scripts can't use top-level
// `import`, but they CAN dynamically import() a module that itself uses
// real ES module syntax, as long as that module is listed in
// web_accessible_resources (see manifest.json). Everything past this file
// is real ES modules (content/panel/app.js and friends).
//
// The whole overlay lives inside a single Shadow DOM root appended to
// <body> — this is what satisfies "do not interfere with normal Google
// Earth functionality" (see the build brief, §3): Earth's own DOM, event
// listeners and canvas are never touched, and Earth's page CSS can't leak
// into (or be leaked into by) the TurnKey panel.
(function () {
  if (document.getElementById('turnkey-ext-root')) return; // already injected (e.g. a second content-script run)

  const host = document.createElement('div');
  host.id = 'turnkey-ext-root';
  // Fixed positioning context for the panel; the host element itself is
  // otherwise invisible/inert until app.js renders into the shadow root.
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  import(chrome.runtime.getURL('content/panel/app.js'))
    .then((mod) => mod.init(shadow))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[TurnKey] failed to load the extension panel', err);
    });
})();
