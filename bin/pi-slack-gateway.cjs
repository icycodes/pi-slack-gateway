#!/usr/bin/env node
// Launcher for the published package (the `bin` entry). Deliberately plain,
// hand-written CommonJS in old-syntax JavaScript: it must parse on Node versions
// far older than the compiled gateway so the engine check below can run first.
// (".cjs" because package.json has "type": "module" and this file must not be ESM.)
"use strict";

var REQUIRED_NODE = [22, 18, 0]; // keep in sync with "engines.node" in package.json

var detected = process.versions.node;
var parts = detected.split(".");
var tooOld = false;
for (var i = 0; i < REQUIRED_NODE.length; i++) {
  var have = parseInt(parts[i], 10) || 0;
  if (have !== REQUIRED_NODE[i]) {
    tooOld = have < REQUIRED_NODE[i];
    break;
  }
}

if (tooOld) {
  process.stderr.write(
    "pi-slack-gateway requires Node.js >= " + REQUIRED_NODE.join(".") +
      ", but this is Node.js " + detected + ".\n" +
      "Install a newer Node.js (https://nodejs.org) and make sure it is first on PATH.\n"
  );
  process.exit(1);
}

var path = require("node:path");
var url = require("node:url");
var entry = url.pathToFileURL(path.join(__dirname, "..", "dist", "main.js")).href;

import(entry).catch(function (error) {
  process.stderr.write("pi-slack-gateway failed to start: " + (error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
