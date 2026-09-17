import { fork } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));
let child;
let childExit;
let stopping = false;
let restarting = false;
let restartPending = false;
let restartTimer;

function start() {
  child = fork(serverPath, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  const running = child;
  childExit = new Promise(resolve => {
    running.once('error', error => {
      console.error('Failed to start development server:', error.message);
    });
    running.once('exit', (code) => {
      if (child === running) child = null;
      if (!stopping && !restarting) {
        console.log('Server exited. Waiting for file changes before restarting...');
      }
      resolve(code ?? 1);
    });
  });
}

async function stopChild() {
  if (!child) return 0;
  if (child.connected) {
    child.send({ type: 'shutdown' }, error => {
      if (error && child?.connected) child.disconnect();
    });
  }
  return childExit;
}

async function restart() {
  if (stopping) return;
  if (restarting) {
    restartPending = true;
    return;
  }
  restarting = true;
  do {
    restartPending = false;
    console.log('Restarting development server...');
    await stopChild();
    if (stopping) break;
    start();
  } while (restartPending);
  restarting = false;
}

const watcher = watch(new URL('./', import.meta.url), { recursive: true }, (_event, filename) => {
  if (!filename?.endsWith('.js') || stopping) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restart, 200);
});

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  watcher.close();
  const code = await stopChild();
  process.exit(exitCode || code);
}

watcher.on('error', error => {
  console.error('Development watcher failed:', error.message);
  shutdown(1);
});
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
if (process.send) {
  process.on('message', message => {
    if (message?.type === 'shutdown') shutdown();
  });
  process.on('disconnect', () => shutdown());
}
start();
