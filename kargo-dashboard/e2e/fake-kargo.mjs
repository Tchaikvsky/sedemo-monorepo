// A fake Kargo REST API for browser tests. It serves the repo's scrubbed fixtures, and lets a test put a
// stage into a running promotion with POST /__set { project, stage, promotion: null | { name, origin, repoURL, tag, currentStep } }.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const FIXTURES = new URL('../test/fixtures/', import.meta.url);
const load = (project, file) => JSON.parse(readFileSync(new URL(`${project}/${file}.json`, FIXTURES)));
export const FAKE_TOKEN = 'fake-token';

// 7 expanded steps; the last one waits for a person.
const STEPS = ['git-clone', 'git-clone', 'git-clear', 'helm-template', 'helm-template', 'git-commit', 'wait-for-approval']
  .map((uses, i) => ({ uses, as: `step-${i + 1}` }));

export function startFakeKargo(port) {
  const running = {}; // `${project}/${stage}` -> promotion
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (url.pathname === '/__set') {
        const b = JSON.parse(body);
        running[`${b.project}/${b.stage}`] = b.promotion;
        return send(200, { ok: true });
      }
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) return send(401, { error: 'unauthorized' });
      const m = /^\/v1beta1\/projects\/([^/]+)\/(warehouses|stages|freight|promotions\/(.+))$/.exec(url.pathname);
      if (!m) return send(404, { error: 'not found' });
      const [, project, kind, promotionName] = m;
      try {
        if (kind === 'warehouses' || kind === 'freight') return send(200, load(project, kind));
        if (kind === 'stages') {
          const stages = load(project, 'stages');
          for (const s of stages.items) {
            const p = running[`${project}/${s.metadata.name}`];
            if (!p) continue;
            s.status.currentPromotion = {
              name: p.name,
              freight: { name: 'incoming-freight', origin: { kind: 'Warehouse', name: p.origin }, images: [{ repoURL: p.repoURL, tag: p.tag }] },
              status: { phase: 'Running', currentStep: p.currentStep, startedAt: '2026-10-15T10:00:00Z' },
            };
          }
          return send(200, stages);
        }
        return send(200, { metadata: { name: promotionName }, spec: { steps: STEPS }, status: { phase: 'Running' } });
      } catch (err) {
        return send(500, { error: err.message });
      }
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({
    url: `http://127.0.0.1:${port}`,
    set: (project, stage, promotion) => fetch(`http://127.0.0.1:${port}/__set`, { method: 'POST', body: JSON.stringify({ project, stage, promotion }) }),
    close: () => new Promise((r) => server.close(r)),
  })));
}
