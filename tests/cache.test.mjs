import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../js/prompt.js';
import { streamChat, streamWithRetry } from '../js/api.js';
import { prepareVertexCache, vertexExplicitCacheSupported } from '../js/cache.js';
import { normalizeUsage } from '../js/cost.js';
import { webcrypto } from 'node:crypto';

const answer = (usage = {}) => new Response(JSON.stringify({ content: [{ type: 'text', text: '下一章。' }], usage }), { headers: { 'content-type': 'application/json' } });

test('核心规则、常驻角色和前情稳定；动态模块与被提及角色不污染缓存前缀', () => {
  const story = { rules: '规则', world: '世界', protagonist: { name: '顾律' }, cards: [
    { name: '甲', core: true, base: '底色' }, { name: '乙', base: '可召回' },
  ], modules: { m: true }, options: false, danmu: false };
  const cp = { id: 'cp', role: 'assistant', text: '前章', checkpoint: { upTo: 10, early: '旧事' } };
  const modules = [{ id: 'm', name: '乙的规则', text: '触发时生效', mode: 'keyword', keywords: '乙' }];
  const a = buildContext(story, [cp, { id: 'a', role: 'user', text: '看看' }], { modules });
  const b = buildContext(story, [cp, { id: 'b', role: 'user', text: '乙来了' }], { modules });
  assert.equal(a.cachePrefix, b.cachePrefix);
  assert.ok(a.cachePrefix.includes('常驻') || a.cachePrefix.includes('【角色卡·甲】'));
  assert.ok(a.cachePrefix.includes('旧事'));
  assert.ok(!a.cachePrefix.includes('乙的规则'));
  assert.ok(b.system.includes('乙的规则'));
});

test('Claude 原生只标记稳定前缀；接口拒绝缓存标记则重试原请求', async (t) => {
  const old = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const b = JSON.parse(init.body); bodies.push(b);
    if (b.system?.[0]?.cache_control && bodies.length === 1) return new Response('{"error":{"message":"cache_control unsupported"}}', { status: 400 });
    return answer({ input_tokens: 10, cache_read_input_tokens: 42, cache_creation_input_tokens: 5, output_tokens: 3 });
  };
  t.after(() => { globalThis.fetch = old; });
  const conn = { format: 'anthropic', model: 'claude-sonnet', baseUrl: 'https://api.anthropic.com', apiKey: 'unit', stream: false };
  const patched = [];
  const r = await streamWithRetry(conn, { system: '稳定\n\n动态', cachePrefix: '稳定', messages: [{ role: 'user', content: '继续' }] }, { onConnPatch: (p) => patched.push(p) });
  assert.equal(r.text, '下一章。');
  assert.deepEqual(bodies[0].system, [{ type: 'text', text: '稳定', cache_control: { type: 'ephemeral' } }, { type: 'text', text: '动态' }]);
  assert.equal(bodies[1].system, '稳定\n\n动态');
  assert.deepEqual(patched, [{ promptCache: false }]);
  assert.deepEqual(normalizeUsage(r.usage), { input: 57, cached: 42, cacheWrite: 5, uncached: 10, output: 3, est: false });
});

test('Vertex 显式缓存按模型与全文复用，并在不支持时跳过', async () => {
  const conn = { id: 'cache-test', format: 'vertex', promptCache: true, model: 'gemini-3.5-flash', region: 'global',
    apiKey: JSON.stringify({ type: 'service_account', project_id: 'p', client_email: 'e', private_key: 'x' }) };
  const calls = [];
  const request = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ name: `projects/p/locations/global/cachedContents/c${calls.length}` }), { headers: { 'content-type': 'application/json' } }); };
  const system = '规则'.repeat(2200);
  assert.equal(await prepareVertexCache(conn, system, 'token', request), 'projects/p/locations/global/cachedContents/c1');
  assert.equal(await prepareVertexCache(conn, system, 'token', request), 'projects/p/locations/global/cachedContents/c1');
  assert.equal(await prepareVertexCache(conn, system + '新版', 'token', request), 'projects/p/locations/global/cachedContents/c2');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.systemInstruction.parts[0].text, system);
  assert.equal(calls[0].body.ttl, '600s');
  assert.equal(vertexExplicitCacheSupported('gemini-3.8-flash'), false);
  assert.equal(vertexExplicitCacheSupported('gemini-4-argon'), false);
  assert.equal(await prepareVertexCache({ ...conn, model: 'gemini-3.8-flash' }, system, 'token', request), '');
  assert.equal(calls.length, 2);
});

test('Vertex 缓存创建被拒绝时继续使用原请求，短期内不反复创建', async () => {
  const conn = { id: 'cache-failure-test', format: 'vertex', promptCache: true, model: 'gemini-3.5-flash',
    apiKey: JSON.stringify({ type: 'service_account', project_id: 'p', client_email: 'e', private_key: 'x' }) };
  let attempts = 0;
  const request = async () => { attempts++; return new Response('{}', { status: 400 }); };
  const system = '规则'.repeat(2200);
  assert.equal(await prepareVertexCache(conn, system, 'token', request), '');
  assert.equal(await prepareVertexCache(conn, system, 'token', request), '');
  assert.equal(attempts, 1);
});

test('Vertex 直连创建一次缓存，两轮引用同一资源，模型回复的命中数来自用量字段', async (t) => {
  const oldFetch = globalThis.fetch;
  const oldCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  t.after(() => { globalThis.fetch = oldFetch; Object.defineProperty(globalThis, 'crypto', { value: oldCrypto, configurable: true }); });
  const keys = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pem = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64').match(/.{1,64}/g).join('\n');
  const sa = JSON.stringify({ type: 'service_account', project_id: 'cache-test-project', client_email: 'cache@example.test', private_key: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`, token_uri: 'https://oauth.cache.test/token', api_base: 'https://vertex.cache.test' });
  const cacheCalls = [], modelCalls = [], created = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'mock-access', expires_in: 3600 }));
    if (String(url).endsWith('/cachedContents')) {
      cacheCalls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ name: 'projects/cache-test-project/locations/global/cachedContents/test-id', usageMetadata: { totalTokenCount: 4400 } }));
    }
    modelCalls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '下一章。' }, finish_reason: 'stop' }], usageMetadata: { promptTokenCount: 5000, cachedContentTokenCount: 4300, candidatesTokenCount: 100 } }), { headers: { 'content-type': 'application/json' } });
  };
  const conn = { id: 'integration-cache', format: 'vertex', model: 'gemini-3.5-flash', region: 'global', apiKey: sa, stream: false, promptCache: true };
  for (const msg of ['第一次', '第二次']) {
    const r = await streamChat(conn, { system: '稳定档案'.repeat(1300), messages: [{ role: 'user', content: msg }], onCacheCreate: (data) => created.push(data.usageMetadata.totalTokenCount) });
    assert.equal(normalizeUsage(r.usage).cached, 4300);
  }
  assert.equal(cacheCalls.length, 1);
  assert.deepEqual(created, [4400]);
  assert.equal(modelCalls.length, 2);
  assert.ok(modelCalls.every((b) => b.extra_body?.google?.cached_content === 'projects/cache-test-project/locations/global/cachedContents/test-id' && !b.messages.some((m) => m.role === 'system')));
});
