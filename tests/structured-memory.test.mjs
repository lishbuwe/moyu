import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyMemory } from '../js/memory.js';
import { memoryText } from '../js/prompt.js';
import { buildContext } from '../js/prompt.js';
import { ensureStructured, projectColumns, syncStructured, addEvents, activeRecords, migrateCheckpoints } from '../js/structured-memory.js';

test('旧档案原文、栏目和章段范围无损迁移，重复打开不改动', () => {
  const old = { ...emptyMemory(), upTo: 12, early: '第1至7章概要', earlyUpTo: 7,
    summaries: [{ from: 8, to: 12, text: '第八至十二章的停电。' }], irreversible: ['她答应保管B5速写本'],
    threads: ['尚未解释大二停电'], knowledge: ['只有甲知道原因'], cards: { 甲: { now: '等待', relation: '朋友' } } };
  const before = memoryText(old);
  assert.equal(ensureStructured(old, 'node12'), true);
  assert.equal(ensureStructured(old, 'node12'), false);
  assert.equal(memoryText(old), before);
  assert.deepEqual(projectColumns(old).summaries, [{ from: 8, to: 12, text: '第八至十二章的停电。' }]);
  assert.deepEqual(old.legacy.cards.甲, { now: '等待', relation: '朋友' });
  assert.equal(old.records.find(r => r.column === 'summaries').sourceChapter, null);
  assert.deepEqual(old.records.find(r => r.column === 'knowledge').knowers, []);
});

test('手改和覆盖留有旧版本，历史时间点仍能找到当时事实', () => {
  const m = { ...emptyMemory(), upTo: 10, items: ['B5速写本在甲手里'] };
  ensureStructured(m, 'cp10');
  const first = m.records[0].id;
  m.upTo = 11;
  syncStructured(m, { ...m, items: ['B5速写本交给顾律'] }, { from: 11, to: 11, branchId: 'cp11' });
  assert.deepEqual(projectColumns(m).items, ['B5速写本交给顾律']);
  assert.ok(activeRecords(m, 10).some(r => r.id === first));
  assert.ok(!activeRecords(m, 11).some(r => r.id === first));
  assert.equal(m.legacy.items[0], 'B5速写本在甲手里');
  addEvents(m, [{ event: '大二停电时甲找到了速写本', sourceChapter: 11, importance: 8, knowers: ['甲'], tags: ['本子'] }], 11, 11, 'cp11');
  assert.ok(activeRecords(m).some(r => r.tags.includes('本子') && r.sourceChapter === 11));
});

test('手动调整栏目顺序仍按用户界面顺序显示', () => {
  const m = { ...emptyMemory(), upTo: 5, items: ['旧钥匙', '速写本'] };
  ensureStructured(m, 'cp5');
  syncStructured(m, { ...m, items: ['速写本', '新纸条', '旧钥匙'] }, { from: 5, to: 5, branchId: 'cp5' });
  assert.deepEqual(projectColumns(m).items, ['速写本', '新纸条', '旧钥匙']);
});

test('自动迁移存回节点，第二次加载不重复写入', async () => {
  const node = { id: 'a', checkpoint: { ...emptyMemory(), upTo: 1, summaries: [{ from: 1, to: 1, text: '开场' }] } };
  const saved = [];
  const db = { put: async (_store, value) => saved.push(structuredClone(value)) };
  await migrateCheckpoints(new Map([['a', node]]), db);
  await migrateCheckpoints(new Map([['a', node]]), db);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].checkpoint.records[0].sourceChapter, 1);
});

test('设备空间不足时迁移失败保留原节点，仍可用旧档案', async () => {
  const node = { id: 'old', checkpoint: { ...emptyMemory(), upTo: 4, threads: ['原文保留'] } };
  const result = await migrateCheckpoints([node], { put: async () => { throw new Error('quota'); } });
  assert.deepEqual(result, { migrated: 0, failed: 1 });
  assert.equal(node.checkpoint.records, undefined);
  assert.ok(memoryText(node.checkpoint).includes('原文保留'));
});

test('百章档案只带两章原文，提到旧停电与本子时能召回并减少输入', () => {
  const mem = { ...emptyMemory(), upTo: 90,
    summaries: Array.from({ length: 90 }, (_, i) => ({ from: i + 1, to: i + 1, text: `第${i + 1}章发生的普通小事。` + '情景'.repeat(70) })),
    irreversible: ['顾律留下B5速写本'], threads: ['大二那次停电的原因还没解开'] };
  ensureStructured(mem, 'cp90');
  const path = [];
  for (let i = 1; i <= 100; i++) {
    path.push({ id: 'u' + i, role: 'user', kind: 'play', text: i === 100 ? '那个本子是不是跟大二那次停电有关？' : `第${i}次行动` });
    path.push({ id: 'a' + i, role: 'assistant', kind: 'play', text: `# 第${i}章\n` + '本章剧情。'.repeat(200), ...(i === 90 ? { checkpoint: mem } : {}) });
  }
  const story = { rules: '规则', world: '世界设定', cards: [], options: false, danmu: false };
  const old = buildContext({ ...story, memoryMode: 'full' }, path, { budgetChars: 60000 });
  const compact = buildContext(story, path, { budgetChars: 60000 });
  assert.equal(compact.info.memoryMode, 'layered');
  assert.ok(compact.info.totalChars < old.info.totalChars / 2);
  assert.ok(compact.system.includes('停电') && compact.system.includes('速写本'));
  assert.equal(compact.messages.filter(m => m.role === 'assistant').length, 2);
  assert.ok(compact.info.retrievalHits.length > 0);
});
