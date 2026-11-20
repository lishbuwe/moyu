import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExtraContext } from '../js/fanwai.js';
import { ensureStructured, addEvents, recordsAt } from '../js/structured-memory.js';
import { emptyMemory } from '../js/memory.js';

function fixture() {
  const cp10 = { ...emptyMemory(), upTo: 10, cards: { 甲: { now: '朋友', relation: '互相试探' } } };
  ensureStructured(cp10, 'a10');
  const cp12 = { ...cp10, records: structuredClone(cp10.records), upTo: 12,
    summaries: [{ from: 8, to: 12, text: '第十一章才知道的秘密，混在横跨时间的旧摘要。' }] };
  addEvents(cp12, [
    { event: '第九章甲知道停电原因', sourceChapter: 9, knowers: ['甲'], importance: 8 },
    { event: '第九章大家公开看到速写本', sourceChapter: 9, knowers: ['公开'], importance: 7 },
    { event: '第九章乙独自知道戒指秘密', sourceChapter: 9, knowers: ['乙'], importance: 7 },
    { event: '第九章知情者未知的房间密码', sourceChapter: 9, importance: 6 },
    { event: '第十一章才开始交往', sourceChapter: 11, knowers: ['甲'], importance: 10 },
  ], 9, 11, 'a12');
  // 旧摘要只有 8～12 范围，作为旧版数据迁移后应被安全排除。
  const old = { ...emptyMemory(), upTo: 12, summaries: [{ from: 8, to: 12, text: '旧摘要：第十一章的独有事实' }] };
  ensureStructured(old, 'a12'); cp12.records.push(...old.records);
  const chapters = Array.from({ length: 12 }, (_, i) => ({ no: i + 1, id: 'a' + (i + 1), title: `章${i + 1}`,
    said: '行动', text: i >= 10 ? '第十一章才形成恋人关系' : '日常相处' }));
  const path = chapters.slice(0, 10).map((c) => ({ id: c.id, role: 'assistant', text: c.text, ...(c.no === 10 ? { checkpoint: cp10 } : {}) }));
  const historyPath = [...path, { id: 'a11', role: 'assistant', text: '未来' }, { id: 'a12', role: 'assistant', text: '未来', checkpoint: cp12 }];
  const story = { world: '普通城市', protagonist: { name: '顾律' }, cards: [
    { name: '甲', core: true, base: '谨慎', now: '第十一章才交往', relation: '恋人' },
    { name: '未来新角色', auto: { from: 11 }, core: true, initial: '第十一章才出现' },
  ] };
  const opts = { chapters: chapters.slice(0, 10), anchorNo: 10, recentN: 2, pinned: [2, 11],
    template: { name: '小说体', text: '写场景', scope: 'all' }, request: '回想停电', pov: '甲', path, historyPath };
  return { story, opts };
}

test('第十章番外取此前完整合格记忆，排除第十一章事实、跨界旧摘要和未来角色卡', () => {
  const { story, opts } = fixture();
  const ctx = buildExtraContext(story, opts);
  assert.ok(ctx.system.includes('第九章甲知道停电原因'));
  assert.ok(ctx.system.includes('朋友'));
  assert.ok(ctx.info.chapters.includes(2));
  assert.ok(!ctx.info.chapters.includes(11));
  assert.ok(!ctx.system.includes('第十一章'));
  assert.ok(!ctx.system.includes('恋人关系'));
  assert.ok(!ctx.system.includes('未来新角色'));
});

test('角色视角只用确认知情的记忆；不把未知知情者或原文里的私密场景塞给角色', () => {
  const { story, opts } = fixture();
  const ctx = buildExtraContext(story, { ...opts, scope: 'char' });
  assert.ok(ctx.system.includes('甲知道停电原因'));
  assert.ok(ctx.system.includes('公开看到速写本'));
  assert.ok(!ctx.system.includes('乙独自知道戒指'));
  assert.ok(!ctx.system.includes('房间密码'));
  assert.ok(!ctx.system.includes('【时间点前最近原文】'));
  assert.deepEqual(ctx.info.chapters, []);
});

test('按时间点快照取旧累计栏目，删除的旧事项不会从更早档案复活', () => {
  const old = { ...emptyMemory(), upTo: 8, threads: ['已解决的旧事项'] };
  const current = { ...emptyMemory(), upTo: 10, threads: ['仍未解决的新事项'] };
  ensureStructured(old, 'a8'); ensureStructured(current, 'a10');
  const path = [{ checkpoint: old }, { checkpoint: current }];
  assert.deepEqual(recordsAt(path, 10).map((r) => r.event), ['仍未解决的新事项']);
  assert.deepEqual(recordsAt(path, 8).map((r) => r.event), ['已解决的旧事项']);
});

test('公开和角色视角隔离混写的卡片，全知在同一时间点保留秘密', () => {
  const {story,opts}=fixture();
  story.cards[0].base='私密底稿：红章藏在阁楼。';
  story.cards[0].publicProfile='常穿蓝外套，说话很慢。';
  story.protagonist.note='她独自藏起第二把钥匙。';
  story.protagonist.publicProfile='留齐肩短发。';
  story.world='幕后设定：有人伪造了账册。';
  for (const scope of ['public','char','all']) {
    const {system}=buildExtraContext(story,{...opts,scope});
    assert.match(system,/常穿蓝外套/); assert.match(system,/齐肩短发/);
    for (const detail of ['红章藏在阁楼','第二把钥匙','伪造了账册']) assert.equal(system.includes(detail),scope==='all');
    assert.equal(system.includes('甲知道停电原因'),scope!=='public');
    assert.equal(system.includes('乙独自知道戒指秘密'),scope==='all');
    assert.ok(!system.includes('第十一章才交往'));
  }
});

test('旧档无知情标记时从同一分支按出处取材，修改原文后丢弃旧缓存', () => {
  const {story, opts} = fixture();
  const cp = { upTo: 2, summaries: [{from: 1, to: 2, text: '晚会上公开宣布画展开幕。'}] };
  ensureStructured(cp, 'a2');
  const chapters = [
    {id:'a1', no:1, text:'甲对顾律说：“暗号是栀子。”\n乙亲耳听到真实底价。'},
    {id:'a2', no:2, text:'主持人当众宣布明日闭馆。\n甲想：“明天再说。晚会上公开宣布假消息。”'},
    {id:'a3', no:3, text:'主持人公开宣布未来结果。'},
  ];
  const cache = {};
  const build = scope => buildExtraContext(story, {...opts, chapters, path:[], historyPath:[{checkpoint:cp}],
    anchorNo:2, scope, pov:'顾律', evidenceCache:cache});
  const pub = build('public');
  assert.match(pub.system,/公开可见】晚会上公开宣布画展开幕/);
  assert.match(pub.system,/明日闭馆/);
  assert.doesNotMatch(pub.system,/栀子|真实底价|假消息|未来结果/);
  assert.equal(pub.info.hasCanon,true);
  const personal = build('char');
  assert.match(personal.system,/仅顾律可用】甲对顾律说/);
  assert.doesNotMatch(personal.system,/真实底价|假消息|未来结果/);
  chapters[1].text = '主持人当众宣布推迟闭馆。';
  assert.doesNotMatch(build('public').system,/明日闭馆/);
});

test('全知番外能够按要求从尚未整理的早期原文找回事件', () => {
  const {story,opts} = fixture();
  const chapters = opts.chapters.map(c => ({...c,text:c.no===3 ? '那天河边的玻璃风铃碎了。' : '走过车站。'}));
  const ctx=buildExtraContext(story,{...opts,chapters,path:[],historyPath:[],scope:'all',request:'玻璃风铃',recentN:2});
  assert.deepEqual(ctx.info.excerptChapters,[3]);
  assert.match(ctx.system,/那天河边的玻璃风铃碎了/);
});

test('相邻进场和私聊可在角色视角复用，切场与公开视角不接收', () => {
  const {story,opts}=fixture();
  const cache={};
  const build=(scope,sep='')=>buildExtraContext(story,{...opts,scope,pov:'顾律',path:[],historyPath:[],evidenceCache:cache,chapters:[{no:1,id:'x',text:'顾律推门进来。\n'+sep+'甲对她说：“钥匙在花盆里。”'}]});
  assert.match(build('char').system,/钥匙在花盆里/);
  assert.match(build('char').system,/钥匙在花盆里/);
  assert.doesNotMatch(build('public').system,/钥匙在花盆里/);
  assert.doesNotMatch(build('char','第二天。\n').system,/钥匙在花盆里/);
});
