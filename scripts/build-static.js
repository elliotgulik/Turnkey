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
  "booking.html",
  "quote.html",
  "privacy.html",
  "404.html",
  "config.js",
  "pricing-engine.js",
  "cost-engine.js",
  "sales-engine.js",
  "sales-metrics.js",
  "sales-platform.js",
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
if (fs.existsSync(path.join(root, "assets")))
  fs.cpSync(path.join(root, "assets"), path.join(target, "assets"), {
    recursive: true,
  });
console.log("Prepared " + assets.length + " public assets in .netlify-dist");
