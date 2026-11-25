#!/usr/bin/env node
// TEST DOUBLE. This is not kane-cli. It stands in for `kane-cli run --agent` so the adapter's
// process handling can be tested without a browser or credits. Behavior is driven by env vars:
//   FAKE_KANE_STDOUT            file replayed to stdout, line by line
//   FAKE_KANE_STDERR            file copied to stderr after the replay
//   FAKE_KANE_EXIT              exit code (default 0)
//   FAKE_KANE_LINE_DELAY_MS     pause before each stdout line (default 0)
//   FAKE_KANE_CHUNK_BYTES       split every line into writes of this many bytes
//   FAKE_KANE_HANG              "1": never exit after the replay
//   FAKE_KANE_IGNORE_SIGTERM    "1": ignore SIGTERM so only SIGKILL stops it
//   FAKE_KANE_GRANDCHILD_PID    path: start a long-lived child in our process group, write its pid
//   FAKE_KANE_INVOCATION        path: write {argv, env} as JSON before doing anything else
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const env = process.env;

if (env.FAKE_KANE_INVOCATION) {
  writeFileSync(env.FAKE_KANE_INVOCATION, JSON.stringify({ argv: process.argv.slice(2), env }));
}
if (env.FAKE_KANE_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => undefined);
}
if (env.FAKE_KANE_GRANDCHILD_PID) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
    stdio: 'ignore',
  });
  writeFileSync(env.FAKE_KANE_GRANDCHILD_PID, String(grandchild.pid));
}

const delayMs = Number(env.FAKE_KANE_LINE_DELAY_MS ?? '0');
const chunkBytes = Number(env.FAKE_KANE_CHUNK_BYTES ?? '0');

function write(stream, bytes) {
  return new Promise((resolve) => {
    if (stream.write(bytes)) resolve();
    else stream.once('drain', resolve);
  });
}

if (env.FAKE_KANE_STDOUT) {
  const content = readFileSync(env.FAKE_KANE_STDOUT);
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf(0x0a, start);
    const end = newline === -1 ? content.length : newline + 1;
    if (delayMs > 0) await sleep(delayMs);
    const line = content.subarray(start, end);
    const step = chunkBytes > 0 ? chunkBytes : line.length;
    for (let offset = 0; offset < line.length; offset += step) {
      await write(process.stdout, line.subarray(offset, offset + step));
    }
    start = end;
  }
}
if (env.FAKE_KANE_STDERR) {
  await write(process.stderr, readFileSync(env.FAKE_KANE_STDERR));
}
if (env.FAKE_KANE_HANG === '1') {
  setInterval(() => undefined, 1000);
} else {
  process.exitCode = Number(env.FAKE_KANE_EXIT ?? '0');
}
