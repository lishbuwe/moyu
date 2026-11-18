// Vertex 显式上下文缓存。资源只放在当前页面内存里；刷新后可重新建立。
// 只有用户为 Vertex 连接打开缓存，且型号支持显式缓存时才创建收费资源。
import { parseServiceAccount } from './vertex.js';

const entries = new Map();
const TTL_SECONDS = 600;

export function vertexExplicitCacheSupported(model) {
  const m = String(model || '').replace(/^.*\//, '');
  return /^gemini-(2\.|3\.(?!1-pro-preview|7-flash|8-flash))/.test(m);
}

export async function prepareVertexCache(conn, system, token, request, signal, onCreated = () => {}) {
  if (conn?.format !== 'vertex' || conn.promptCache !== true || !system || !vertexExplicitCacheSupported(conn.model)) return '';
  // 模型的下限至少 2048/4096 token。字数仅用于避开明显过短的创建请求，最终由接口决定。
  if (system.length < (/^gemini-2\./.test(conn.model) ? 2048 : 4096)) return '';
  const sa = parseServiceAccount(conn.apiKey);
  const loc = conn.region || 'global';
  const model = String(conn.model).replace(/^google\//, '');
  const key = JSON.stringify([conn.id, sa.project_id, loc, model, system]);
  const now = Date.now();
  const old = entries.get(key);
  if (old && old.until > now) return old.name || '';
  if (old?.pending) return old.pending;
  const host = sa.api_base ? String(sa.api_base).replace(/\/+$/, '') : (loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`);
  const path = `/v1/projects/${encodeURIComponent(sa.project_id)}/locations/${encodeURIComponent(loc)}`;
  const body = { model: `projects/${sa.project_id}/locations/${loc}/publishers/google/models/${model}`,
    systemInstruction: { parts: [{ text: system }] }, ttl: `${TTL_SECONDS}s` };
  const pending = (async () => {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => ctrl.abort('cache-timeout'), 15000);
    try {
      const res = await request(host + path + '/cachedContents', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body), signal: ctrl.signal,
      });
      if (!res.ok) return '';
      const data = await res.json();
      if (!/^projects\/[^/]+\/locations\/[^/]+\/cachedContents\/[^/]+$/.test(data.name || '')) return '';
      try { await onCreated(data); } catch {} // 记账失败不能阻止已经建好的缓存用于请求。
      const expires = Date.parse(data.expireTime || '');
      entries.set(key, { name: data.name, until: Number.isFinite(expires) ? expires - 30000 : Date.now() + (TTL_SECONDS - 30) * 1000 });
      while (entries.size > 8) entries.delete(entries.keys().next().value);
      return data.name;
    } catch { return ''; }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  })();
  entries.set(key, { pending });
  const name = await pending;
  if (!name) entries.set(key, { name: '', until: Date.now() + 60000 });
  return name;
}
