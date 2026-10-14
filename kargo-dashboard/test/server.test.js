import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { DEFAULT_THRESHOLDS } from '../src/config.js';

const config = { refreshIntervalSeconds: 5, decay: { thresholds: DEFAULT_THRESHOLDS } };

async function withServer(summarize, fn) {
  const { app, refresh } = createApp({ config, summarize });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, refresh); } finally { server.close(); }
}

test('healthz and summary are 503 until the first refresh, then 200', async () => {
  await withServer(async () => ({ generatedAt: 'now', rows: [] }), async (base, refresh) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 503);
    assert.equal((await fetch(`${base}/api/summary`)).status, 503);
    await refresh();
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const body = await (await fetch(`${base}/api/summary`)).json();
    assert.deepEqual([body.rows, body.refreshIntervalSeconds, body.thresholds.length, body.refreshError], [[], 5, 4, null]);
  });
});

test('a failed refresh keeps the previous rows and reports the error', async () => {
  let n = 0;
  const summarize = async () => {
    if (++n === 2) throw new Error('kaboom');
    return { generatedAt: 'now', rows: [{ project: 'p' }] };
  };
  await withServer(summarize, async (base, refresh) => {
    await refresh();
    await refresh();
    const body = await (await fetch(`${base}/api/summary`)).json();
    assert.equal(body.rows[0].project, 'p');
    assert.equal(body.refreshError, 'kaboom');
    await refresh();
    assert.equal((await (await fetch(`${base}/api/summary`)).json()).refreshError, null);
  });
});
