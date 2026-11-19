// 墨游 · Google Vertex AI：用“服务账号 JSON”换访问令牌，再走 Vertex 的 OpenAI 兼容接口
// 服务账号 JSON 存在连接的 apiKey 里（和其他密钥一样：只在本机，不进备份）

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const utf8 = (s) => new TextEncoder().encode(s);

class VertexError extends Error {
  constructor(message, hint = '', detail = '') { super(message); this.kind = 'vertex'; this.hint = hint; this.detail = detail; }
}

/** 解析粘贴进来的服务账号 JSON；不对就抛出中文说明 */
export function parseServiceAccount(text) {
  let j;
  try { j = JSON.parse(String(text || '').trim()); } catch {
    throw new VertexError('服务账号 JSON 格式不对', '要把下载的 .json 文件内容整段粘贴进来，包括最外层的 { 和 }。');
  }
  if (!j || j.type !== 'service_account' || !j.private_key || !j.client_email) {
    throw new VertexError('这不是服务账号的 JSON', '里面应该有 "type": "service_account"、"private_key"、"client_email"、"project_id" 这几项。');
  }
  if (!j.project_id) throw new VertexError('服务账号 JSON 里没有 project_id');
  return j;
}

export function isServiceAccountJson(text) {
  try { parseServiceAccount(text); return true; } catch { return false; }
}

async function importKey(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  if (!globalThis.crypto?.subtle) throw new VertexError('这个浏览器环境不能做签名', '需要用 https 打开墨游。');
  try {
    return await crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch { throw new VertexError('服务账号 JSON 里的私钥读不出来', '可能粘贴时少了内容，重新整段复制一次。'); }
}

const tokens = new Map(); // client_email|key id → { token, exp }

/** 拿访问令牌（有效期内复用，快过期时重新换） */
export async function getAccessToken(sa, signal) {
  const k = sa.client_email + '|' + (sa.private_key_id || '');
  const hit = tokens.get(k);
  const now = Math.floor(Date.now() / 1000);
  if (hit && hit.exp - 120 > now) return hit.token;
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64url(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })));
  const claims = b64url(utf8(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUri, iat: now, exp: now + 3600 })));
  const key = await importKey(sa.private_key);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(head + '.' + claims)));
  const assertion = head + '.' + claims + '.' + b64url(sig);
  let res;
  try {
    res = await fetch(tokenUri, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + assertion,
    });
  } catch (e) {
    throw new VertexError('连不上 Google 的登录服务', '检查网络（需要能访问 Google）。如果网络没问题还是这样，可能是浏览器不允许网页直接访问，告诉开发者。', tokenUri + '\n' + (e?.message || e));
  }
  const raw = await res.text().catch(() => '');
  let j = {};
  try { j = JSON.parse(raw); } catch {}
  if (!res.ok || !j.access_token) {
    const d = j.error_description || j.error || raw.slice(0, 300);
    const hint = /invalid_grant/i.test(raw) ? (/iat|exp|time|clock/i.test(raw) ? '手机的时间不准，校准系统时间再试。' : '这把密钥可能已经被删除或停用，去 Google Cloud 重新生成一份服务账号密钥。')
      : '服务账号可能被停用，或者 JSON 不完整。';
    throw new VertexError('Google 不认这份服务账号 JSON', hint, String(d));
  }
  tokens.set(k, { token: j.access_token, exp: now + (Number(j.expires_in) || 3600) });
  return j.access_token;
}

/** 地区 → 接口地址（global 用总域名，其余用 地区-aiplatform） */
export function vertexBaseUrl(sa, region) {
  const loc = String(region || 'global').trim() || 'global';
  const host = sa.api_base ? String(sa.api_base).replace(/\/+$/, '') : (loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`);
  return `${host}/v1/projects/${encodeURIComponent(sa.project_id)}/locations/${encodeURIComponent(loc)}/endpoints/openapi`;
}

/** 把 Vertex 连接换成一条可以直接用的 OpenAI 兼容连接 */
export async function resolveVertex(conn) {
  const sa = parseServiceAccount(conn.apiKey);
  const token = await getAccessToken(sa);
  const m = String(conn.model || '').trim();
  return { ...conn, format: 'openai', baseUrl: vertexBaseUrl(sa, conn.region), apiKey: token, model: m.includes('/') ? m : 'google/' + m };
}

export const VERTEX_MODELS = ['gemini-4-neon', 'gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'];

// Model Garden 是发布者目录；项目能否调用某个模型由「测试连接」验证。
export async function listVertexModels(conn) {
  const sa = parseServiceAccount(conn.apiKey);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const token = await getAccessToken(sa, ctrl.signal);
    const url = new URL('https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('listAllVersions', 'true');
    const ids = new Set();
    const pages = new Set();
    for (;;) {
      const response = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal,
      });
      if (!response.ok) throw new Error('Google 模型目录返回 HTTP ' + response.status);
      const data = await response.json();
      for (const entry of data.publisherModels || []) {
        const name = entry.name?.split('/').pop() || '';
        for (const id of [name, entry.versionId]) {
          if (/^gemini-[a-z0-9][a-z0-9.-]*$/i.test(id) &&
              !/(?:^|-)(?:embedding|image|live|audio|tts|robotics|nano-banana)(?:-|$)/i.test(id)) ids.add(id);
        }
      }
      if (!data.nextPageToken) break;
      if (pages.has(data.nextPageToken)) throw new Error('Google 模型目录分页重复');
      pages.add(data.nextPageToken);
      url.searchParams.set('pageToken', data.nextPageToken);
    }
    return [...ids].sort((a,b) => b.localeCompare(a, 'en', { numeric: true }));
  } finally { clearTimeout(timer); }
}
