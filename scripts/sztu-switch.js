#!/usr/bin/env node
const { runCommand } = require("../switchboard/cli");

runCommand(process.argv.slice(2)).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
