// Thin wrapper over the Kargo REST API (/v1beta1). The only module that does network I/O.
// Returns plain objects; no business logic. Tokens are passed per call and never logged.

const TIMEOUT_MS = 10_000;

export class KargoApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'KargoApiError';
    this.status = status;
  }
}

// `fetchImpl` is injectable for tests.
export function createKargoClient({ url, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  const base = url.replace(/\/+$/, '');

  async function get(path, token, project) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err.message;
      throw new KargoApiError(`request failed: ${reason}`, 0);
    }
    if (res.status === 401 || res.status === 403) {
      throw new KargoApiError(`token lacks access to project ${project}`, res.status);
    }
    if (!res.ok) {
      throw new KargoApiError(`Kargo API returned HTTP ${res.status} for project ${project}`, res.status);
    }
    return res.json();
  }

  const projectPath = (project) => `/v1beta1/projects/${encodeURIComponent(project)}`;

  return {
    async listWarehouses(project, token) {
      const body = await get(`${projectPath(project)}/warehouses`, token, project);
      return body.items || [];
    },

    async listStages(project, warehouse, token) {
      const q = `freightOrigins=${encodeURIComponent(warehouse)}`;
      const body = await get(`${projectPath(project)}/stages?${q}`, token, project);
      return body.items || [];
    },

    // Freight comes back grouped under keys that are undocumented without groupBy,
    // so flatten every group and de-duplicate by name.
    async listFreight(project, warehouse, token) {
      const q = `origins=${encodeURIComponent(warehouse)}`;
      const body = await get(`${projectPath(project)}/freight?${q}`, token, project);
      const seen = new Set();
      const out = [];
      for (const group of Object.values(body.groups || {})) {
        for (const f of group.items || []) {
          if (!seen.has(f.metadata.name)) {
            seen.add(f.metadata.name);
            out.push(f);
          }
        }
      }
      return out;
    },
  };
}
