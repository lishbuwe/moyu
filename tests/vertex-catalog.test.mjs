import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { listModels } from '../js/api.js';

test('Vertex 按页读取 Google 发布目录，发现新文本模型，忽略重复项和语音模型', async (t) => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const apiKey = JSON.stringify({ type: 'service_account', project_id: 'qa', client_email: 'catalog@example.test',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  let pages = 0;
  t.mock.method(globalThis, 'fetch', async (target, init) => {
    const url = new URL(target);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token:'test-access-token' });
    assert.equal(url.pathname, '/v1beta1/publishers/google/models');
    assert.equal(init.headers.Authorization, 'Bearer test-access-token');
    pages++;
    const model = name => ({name:'publishers/google/models/' + name});
    if (pages === 1) return Response.json({publisherModels:[model('gemini-qa-new'),model('gemini-live-audio')], nextPageToken:'page 2'});
    assert.equal(url.searchParams.get('pageToken'), 'page 2');
    return Response.json({publisherModels:[model('gemini-qa-new'),{...model('gemini'),versionId:'gemini-qa-other'},model('imagen-qa')]});
  });
  assert.deepEqual((await listModels({format:'vertex', apiKey})).sort(), ['gemini-qa-new','gemini-qa-other']);
  assert.equal(pages, 2);
});
