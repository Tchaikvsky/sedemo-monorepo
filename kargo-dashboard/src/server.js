import express from 'express';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createKargoClient } from './kargo-client.js';
import { summarizeAll } from './summarize.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

// Builds the express app around a refresh function so it can be started or tested separately.
export function createApp({ config, summarize }) {
  let latest = null; // last good summary
  let refreshError = null;

  const payload = () => ({
    ...latest,
    refreshIntervalSeconds: config.refreshIntervalSeconds,
    thresholds: config.decay.thresholds,
    refreshError,
  });

  async function refresh() {
    const started = Date.now();
    try {
      latest = await summarize();
      refreshError = null;
      const failed = latest.rows.filter((r) => r.error).length;
      console.log(`refresh ok: ${latest.rows.length} projects, ${failed} with errors, ${Date.now() - started}ms`);
    } catch (err) {
      refreshError = err.message;
      console.error(`refresh failed after ${Date.now() - started}ms: ${err.message}`);
    }
  }

  const app = express();
  app.get('/api/summary', (_req, res) => {
    if (!latest) return res.status(503).json({ error: 'first refresh has not completed' });
    res.json(payload());
  });
  app.get('/healthz', (_req, res) => res.status(latest ? 200 : 503).send(latest ? 'ok' : 'starting'));
  app.use(express.static(PUBLIC_DIR));

  return { app, refresh };
}

// Chained timeouts rather than setInterval so slow refreshes never overlap.
function startLoop(refresh, seconds) {
  const tick = async () => {
    await refresh();
    setTimeout(tick, seconds * 1000).unref?.();
  };
  return tick();
}

async function main() {
  const config = loadConfig();
  const client = createKargoClient({ url: config.kargo.url });
  const warn = (m) => console.warn(`warn: ${m}`);
  const { app, refresh } = createApp({ config, summarize: () => summarizeAll({ client, config, warn }) });

  const port = Number(process.env.PORT) || 8080;
  app.listen(port, () => console.log(`kargo-dashboard listening on :${port} (${config.kargo.url})`));
  await startLoop(refresh, config.refreshIntervalSeconds);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
