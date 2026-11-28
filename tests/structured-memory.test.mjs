import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyMemory } from '../js/memory.js';
import { memoryText } from '../js/prompt.js';
import { buildContext } from '../js/prompt.js';
import { updateContinuity } from '../js/continuity.js';
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

test('百章档案按预算保留未整理原文，提到停电与本子时仍能召回旧记忆', () => {
  const mem = { ...emptyMemory(), upTo: 90,
    summaries: Array.from({ length: 90 }, (_, i) => ({ from: i + 1, to: i + 1, text: `第${i + 1}章发生的普通小事。` + '情景'.repeat(70) })),
    irreversible: ['顾律留下B5速写本'], threads: ['大二那次停电的原因还没解开'] };
  mem.summaries[8].text = '停电后借着手电筒画完了最后一页。';
  ensureStructured(mem, 'cp90');
  const path = [];
  for (let i = 1; i <= 100; i++) {
    path.push({ id: 'u' + i, role: 'user', kind: 'play', text: i === 100 ? '那个本子是不是跟大二那次停电有关？' : `第${i}次行动` });
    path.push({ id: 'a' + i, role: 'assistant', kind: 'play', text: `# 第${i}章\n` + (i === 95 ? '第二天，' : '') + '本章剧情。'.repeat(200), ...(i === 90 ? { checkpoint: mem } : {}) });
  }
  const story = { rules: '规则', world: '世界设定', cards: [], options: false, danmu: false };
  const compact = buildContext(story, path, { budgetChars: 15000 });
  assert.equal(compact.info.memoryMode, 'layered');
  assert.ok(compact.info.totalChars <= 15000);
  assert.ok(compact.system.includes('停电') && compact.system.includes('速写本'));
  assert.deepEqual(compact.info.continuity.kept, [98,99,100]);
  assert.equal(compact.messages.filter(m => m.role === 'assistant').length, 3);
  assert.ok(compact.system.includes('借着手电筒画完了最后一页'));
  assert.ok(compact.info.retrievalHits.some(hit => hit.from === 9));
});

test('跨十二章接回试探原句，沿用当前场景，回退和改写后不引用错误版本', () => {
  const line = '商衍说：“那天我其实……”他把后半句咽了回去。';
  const reply = '顾律收了伞，没有追问。';
  const path = [];
  const batch = [];
  for (let no = 1; no <= 14; no++) {
    path.push({ id: 'u' + no, role: 'user', kind: 'play', text: no === 12 ? '次日，我去见商衍。' : '我等了一会儿。' });
    const body = no === 2 ? line + '\n\n' + reply : no < 12 ? '第二天，别的场景。' : '他们沿河慢慢走了几步。';
    path.push({ id: 'a' + no, role: 'assistant', kind: 'play', text: '# 标题\n\n' + body });
    batch.push({ id: 'a' + no, no });
  }
  const nodes = new Map(path.map((node) => [node.id, node]));
  const mem = { ...emptyMemory(), upTo: 11 };
  ensureStructured(mem, 'a11');
  mem.continuity = updateContinuity(null, { openLines: [
    { chapter: 2, quote: line + '\n\n' + reply, people: ['商衍','顾律'], detail: '他起了话头，她还没问。' },
    { chapter: 3, quote: '模型补写的原句不在正文。', people: ['商衍'], detail: '不应保存' },
  ] }, batch.slice(0, 11), nodes);
  assert.equal(mem.continuity.lines.length, 1);
  nodes.get('a11').checkpoint = mem;
  const story = { protagonist: { name: '顾律' }, cards: [{ name: '商衍', core: true }], danmu: false, options: false };
  const next = { id: 'u15', role: 'user', kind: 'play', inputFormat: 'quoted', text: '我问商衍上次没说完的是什么。' };
  const result = buildContext(story, [...path, next], { budgetChars: 6000 });
  assert.ok(result.system.includes(line));
  assert.ok(result.system.includes(reply));
  assert.deepEqual(result.info.continuity.kept, [12,13,14]);
  assert.deepEqual(result.info.continuity.excerpts, [2]);
  assert.equal(result.messages.at(-1).content, next.text);
  assert.ok(result.info.totalChars <= 6000);
  assert.ok(!buildContext(story, path.slice(0, 2)).system.includes(line));
  assert.ok(!buildContext(story, [...path.map(n => n.id === 'a2' ? { ...n, text: '改写后的章节。' } : n), next]).system.includes(line));
  const moved = { ...next, text: '次日，我回到自己的办公室。' };
  assert.ok(!buildContext(story, [...path, moved]).system.includes(line));
  const closed = updateContinuity(mem.continuity, {
    closeLines: [{ id: mem.continuity.lines[0].id, chapter: 14, quote: '他们沿河慢慢走了几步。' }],
  }, batch.slice(-1), nodes);
  assert.deepEqual(closed.lines, []);
});

test('四百章后日常输入可零召回，提起旧物时找回一次，核心仍保留', async () => {
  const { layeredMemory } = await import('../js/structured-memory.js');
  const m={upTo:400,records:[]};
  for(let i=1;i<=400;i++) m.records.push({id:String(i),sourceFrom:i,sourceTo:i,event:'街角旧闻'+i,type:'event'});
  m.records[4].event='她留下玻璃风铃。';
  m.records.push({...m.records[4],id:'repeat',event:'她留下玻璃风铃'});
  m.records[9].irreversible=true;
  const recall=q=>layeredMemory(m,q,{requireMatch:true});
  assert.equal(recall('午饭吃面').recalled,'');
  assert.match(recall('午饭吃面').core,/街角旧闻10/);
  assert.equal(recall('玻璃风铃').hits.length,1);
});

test('四百段旧摘要不会随档案整包重发，历史数据保留', async () => {
  const { archivistPrompt, emptyMemory }=await import('../js/memory.js');
  const prev={...emptyMemory(),upTo:400,summaries:Array.from({length:400},(_,i)=>({from:i+1,to:i+1,text:'旧摘要'+i+'。'+'平淡日常'.repeat(40)}))};
  const result=archivistPrompt({},prev,[{no:401,text:'新的剧情。'}]);
  assert.ok(result.visible.summaries.reduce((sum,x)=>sum+x.text.length,0)<=1600);
  assert.ok(result.user.includes('旧摘要399。'));
  assert.ok(!result.user.includes('旧摘要0。'));
  assert.equal(prev.summaries.length,400);
});
