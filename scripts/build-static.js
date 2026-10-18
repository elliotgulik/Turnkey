#!/usr/bin/env node
// Deploy only browser assets. Server code, credentials, archives and test dependencies stay out of Netlify's publish directory.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
execFileSync(process.execPath, [path.join(__dirname, "generate-config.js")], {
  cwd: root,
  stdio: "inherit",
});
const target = path.join(root, ".netlify-dist");
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
const assets = [
  "index.html",
  "session-flow.js",
  "workspace-controls.js",
  "workspace-experience.js",
  "workspace-experience.css",
  "settings-experience.js",
  "settings-experience.css",
  "booking.html",
  "quote.html",
  "measure.html",
  "measure.js",
  "measure.css",
  "measurement-editor.js",
  "extension-quote-link.js",
  "job-workspace.js",
  "job-workspace.css",
  "job-calendar.js",
  "job-calendar.css",
  "operations-workspace.js",
  "operations-workspace.css",
  "operations-bridge.js",
  "privacy.html",
  "404.html",
  "config.js",
  "pricing-engine.js",
  "cost-engine.js",
  "sales-engine.js",
  "sales-metrics.js",
  "pipeline-model.js",
  "sales-platform.js",
  "lead-priority.js",
  "measurement-import.js",
  "quote-workspace.js",
  "quote-workspace.css",
  "conversations.js",
  "conversations-bridge.js",
  "conversations.css",
  "servicem8-import.js",
  "marketing-analytics.js",
  "marketing-analytics.css",
  "sales-platform.css",
  "format-utils.js",
  "map-snapshot.js",
  "sw.js",
  "OneSignalSDKWorker.js",
  "manifest.webmanifest",
  "favicon.ico",
  "favicon-16.png",
  "favicon-32.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
];
for (const name of assets)
  fs.copyFileSync(path.join(root, name), path.join(target, name));
fs.mkdirSync(path.join(target, 'chrome-extension'), {recursive:true});
fs.copyFileSync(path.join(root, 'chrome-extension/measurement.js'), path.join(target, 'chrome-extension/measurement.js'));
// geometry.js is the single source of truth for area/length/perimeter math,
// shared between the extension's content bridge (extension/geometry.js,
// imported there via chrome.runtime.getURL) and this site's own
// measure.html workspace (imported here as a normal same-origin module —
// no remote-hosted-code concern, this is just a website loading its own
// JS). Copied rather than duplicated so both ever have exactly one
// implementation to keep correct.
fs.copyFileSync(path.join(root, 'extension/geometry.js'), path.join(target, 'geometry.js'));
if (fs.existsSync(path.join(root, "assets")))
  fs.cpSync(path.join(root, "assets"), path.join(target, "assets"), {
    recursive: true,
  });
console.log("Prepared " + assets.length + " public assets in .netlify-dist");
