#!/usr/bin/env node
import { runCli } from "./index.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort(new Error("Interrupted")));
const code = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  cwd: process.cwd(),
  env: process.env,
  signal: controller.signal,
});
process.exitCode = code;
