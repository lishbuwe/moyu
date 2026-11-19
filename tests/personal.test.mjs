import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildContext, formatContract, inputBudgetChars } from '../js/prompt.js';
import { selectExtras } from '../js/prompt.js';
import { APP_VERSION } from '../js/util.js';

test('旧输入沿用旧约定，新输入原样发送，本局的选项数优先', () => {
  const rules = '旧设定：括号外是台词。每轮给两个参考选项。';
  const path = [
    { role: 'user', kind: 'play', text: '（收好信）我跟你走。' },
    { role: 'assistant', kind: 'play', text: '# 出门\n她撑开伞。' },
    { role: 'user', kind: 'play', inputFormat: 'quoted', text: '收好伞。“一起走吧。”' },
  ];
  const ctx = buildContext({ rules, danmu: false }, path);
  assert.ok(ctx.system.includes(rules));
  assert.match(ctx.system, /只有双引号/);
  assert.match(ctx.messages[0].content, /^【旧版输入】\n（收好信）我跟你走。/);
  assert.match(ctx.messages.at(-1).content, /^收好伞。“一起走吧。”/);
  assert.match(ctx.system, /按本局对参考选项数量的约定/);
  assert.doesNotMatch(ctx.system + ctx.messages.at(-1).content, /A\/B\/C\/D|四行|4个方向/);
  assert.ok(!formatContract({ options: false }).includes('【选项】'));
});

test('旧连接使用默认输入预算；长档案与最近剧情不会被静默裁掉', () => {
  assert.equal(inputBudgetChars({}), 30000);
  assert.equal(inputBudgetChars({ inputBudgetChars: 12000 }), 12000);
  assert.equal(inputBudgetChars({ inputBudgetChars: -1 }), 30000);
  const story = { rules: '规则', world: '背景', danmu: false, options: false };
  const path = Array.from({ length: 10 }, (_, i) => ({
    id: String(i), role: i % 2 ? 'assistant' : 'user', kind: 'play', text: '剧情'.repeat(800),
  }));
  const ctx = buildContext(story, path, { budgetChars: 6000 });
  assert.equal(ctx.info.budgetChars, 6000);
  assert.deepEqual(ctx.info.continuity.omitted, [1, 2, 3]);
  assert.ok(ctx.messages.length >= 4);
  assert.ok(ctx.info.totalChars > 6000, '最后几轮太长时保留原文并交给发送前检查');
  const longMemory = buildContext({ ...story, world: '设定'.repeat(4000) }, [], { budgetChars: 6000 });
  assert.ok(longMemory.info.systemChars > 6000, '固定资料过长时不得悄悄删掉设定');
});

test('弹幕、未选选项和出戏回复不触发角色卡和关键词，选中的行动正常触发', () => {
  const story = { cards: ['甲方','乙方','丙方'].map(name=>({name})), modules: {m:true} };
  const modules = [{id:'m', mode:'keyword', keywords:'阁楼', text:'阁楼规则'}];
  const path = [
    {role:'assistant',kind:'play',text:'# 门口\n甲方站在门口。\n【弹幕】\n读者：丙方来了？\n【选项】\nA. 留下\nB. 去阁楼找乙方'},
    {role:'assistant',kind:'ooc',text:'下次再聊阁楼和丙方。'},
    {role:'user',kind:'play',text:'留下。'},
  ];
  assert.deepEqual(selectExtras(story,path,modules).present.map(c=>c.name), ['甲方']);
  assert.equal(selectExtras(story,path,modules).sentModules.length, 0);
  path.at(-1).text = '去阁楼找乙方。';
  assert.deepEqual(selectExtras(story,path,modules).present.map(c=>c.name), ['甲方','乙方']);
  assert.equal(selectExtras(story,path,modules).sentModules.length, 1);
});

test('主网页升级只清理自己的旧缓存，离线查找不读取其他应用缓存', async () => {
  const handlers = {}, deleted = [], opened = [];
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    self: { addEventListener: (type, fn) => handlers[type] = fn, clients: { claim: async () => {} }, location: { origin: 'https://yl2c.github.io' } },
    caches: {
      keys: async () => ['moyu-v0.6.14', 'yl2c-cache', 'moyu-yl2c-personal-old', 'moyu-vold', 'moyu-v' + APP_VERSION],
      delete: async key => deleted.push(key),
      open: async key => { opened.push(key); return { match: async req => req === './index.html' ? 'personal-index' : undefined }; },
    },
    URL, fetch: async () => { throw new Error('offline'); }, setTimeout: () => {},
  });
  let finished;
  handlers.activate({ waitUntil: p => finished = p }); await finished;
  assert.deepEqual(deleted, ['moyu-v0.6.14', 'moyu-vold']);
  handlers.fetch({ request: { method: 'GET', url: 'https://yl2c.github.io/moyu/' }, respondWith: p => finished = p });
  assert.equal(await finished, 'personal-index');
  assert.deepEqual(opened, ['moyu-v' + APP_VERSION]);
});

test('安装新版逐个绕过 HTTP 缓存，资源全部就绪后才启用', async () => {
  const handlers = {}, requests = [];
  let activate = false;
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    self: {
      addEventListener: (type, fn) => handlers[type] = fn,
      location: { origin: 'https://yl2c.github.io', href: 'https://yl2c.github.io/moyu/sw.js' },
      skipWaiting: async () => { activate = true; },
    },
    caches: { open: async () => ({ addAll: async (assets) => {
      assert.equal(activate, false);
      requests.push(...assets);
    } }) },
    URL, Request,
  });
  let finished;
  handlers.install({ waitUntil: p => finished = p }); await finished;
  assert.ok(activate);
  assert.ok(requests.some(r => r.url === 'https://yl2c.github.io/moyu/css/app.css'));
  assert.ok(requests.some(r => r.url === 'https://yl2c.github.io/moyu/js/views/play.js'));
  assert.ok(requests.every(r => r.cache === 'reload'));
});

test('在线取文件必须重新核验服务器，离线可回退，第三方 API 不拦截', async () => {
  const handlers = {}, fetched = [], saved = [];
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    self: { addEventListener: (type, fn) => handlers[type] = fn, location: { origin: 'https://yl2c.github.io' } },
    caches: { open: async () => ({ put: async (req, res) => saved.push(await res.text()) }) },
    fetch: async (req, init) => { fetched.push({ url: req.url, cache: init.cache }); return new Response('新版右侧按钮'); },
    URL, setTimeout: () => {},
  });
  let finished;
  handlers.fetch({ request: { method: 'GET', url: 'https://yl2c.github.io/moyu/js/views/play.js' }, respondWith: p => finished = p });
  assert.equal(await (await finished).text(), '新版右侧按钮');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetched[0].cache, 'no-cache');
  assert.deepEqual(saved, ['新版右侧按钮']);
  handlers.fetch({ request: { method: 'GET', url: 'https://api.example/v1/models' }, respondWith: () => assert.fail('不能拦截第三方 API') });
  assert.equal(fetched.length, 1);
});
