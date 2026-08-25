#!/usr/bin/env node
import { runJamCommand } from "./cli-entry.js";
import { toJamError } from "./domain/errors.js";

runJamCommand(process.argv.slice(2))
  .then((code) => {
    // Setting exitCode and letting Node exit naturally (rather than forcing
    // process.exit()) avoids a libuv assertion crash observed on Windows when
    // this process has mixed spawnSync (reg.exe/where) with async fetch calls -
    // a forced exit can race a handle that is still closing.
    if (code >= 0) process.exitCode = code;
  })
  .catch((err) => {
    const jamError = toJamError(err);
    process.stderr.write(`[jam] ${jamError.code}: ${jamError.message}\n`);
    process.exitCode = 1;
  });
