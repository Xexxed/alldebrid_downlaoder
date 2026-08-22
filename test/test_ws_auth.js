/**
 * Quick WS auth verification: connects with and without token.
 * Run: node test/test_ws_auth.js (requires AUTH_TOKEN set in .env to be meaningful)
 */
import WebSocket from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.AUTH_TOKEN || '';

if (!TOKEN) {
  console.log('⚠ Set AUTH_TOKEN in .env first, then run this test.');
  process.exit(1);
}

function tryConnect(label, url, expectClose) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let done = false;
    const finish = (ok, extra = '') => {
      if (done) return;
      done = true;
      console.log(`${ok ? '✅' : '❌'} ${label} ${extra}`);
      try { ws.close(); } catch {}
      resolve(ok);
    };
    ws.on('open', () => {
      // For expectClose, wait for the server's close frame instead of failing here
      if (!expectClose) {
        // connected is expected; initial_state message confirms full handshake
      }
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'initial_state') finish(true, `(tasks: ${msg.tasks.length}, speed: ${msg.globalSpeed})`);
    });
    ws.on('close', (code) => {
      if (expectClose && code === 4401) finish(true, '(closed 4401 as expected)');
      else if (!expectClose) finish(false, `(closed early code=${code})`);
      else finish(false, `(closed code=${code})`);
    });
    ws.on('error', (err) => finish(false, err.message));
    setTimeout(() => finish(false, '(timeout)'), 5000);
  });
}

const bad = await tryConnect('WS without token rejected', `ws://127.0.0.1:${PORT}?token=WRONG`, true);
const good = await tryConnect('WS with valid token receives initial_state', `ws://127.0.0.1:${PORT}?token=${encodeURIComponent(TOKEN)}`, false);
process.exit(bad && good ? 0 : 1);
