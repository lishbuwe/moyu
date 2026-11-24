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

test('按时间点快照取旧累计栏目，删除的旧事项不会从更早档案复活', () => {
  const old = { ...emptyMemory(), upTo: 8, threads: ['已解决的旧事项'] };
  const current = { ...emptyMemory(), upTo: 10, threads: ['仍未解决的新事项'] };
  ensureStructured(old, 'a8'); ensureStructured(current, 'a10');
  const path = [{ checkpoint: old }, { checkpoint: current }];
  assert.deepEqual(recordsAt(path, 10).map((r) => r.event), ['仍未解决的新事项']);
  assert.deepEqual(recordsAt(path, 8).map((r) => r.event), ['已解决的旧事项']);
});

test('论坛和角色视角都能参考普通正文和旧记忆，同时遵守所选章节', () => {
  const {story,opts} = fixture();
  for (const scope of ['public','char','all']) {
    const ctx = buildExtraContext(story,{...opts,scope});
    assert.match(ctx.system,/日常相处/);
    assert.match(ctx.system,/房间密码/);
    assert.match(ctx.system,/朋友/);
    assert.ok(ctx.info.chapters.includes(2));
    assert.doesNotMatch(ctx.system,/第十一章才|未来新角色/);
    const guide = ctx.info.parts.find(p=>p.label==='知情范围').text;
    if (scope==='public') assert.match(guide,/旁人能看到或听说/);
    if (scope==='char') assert.match(guide,/以甲的视角写/);
  }
});

test('全知番外能够按要求从尚未整理的早期原文找回事件', () => {
  const {story,opts} = fixture();
  const chapters = opts.chapters.map(c => ({...c,text:c.no===3 ? '那天河边的玻璃风铃碎了。' : '走过车站。'}));
  const ctx=buildExtraContext(story,{...opts,chapters,path:[],historyPath:[],scope:'all',request:'玻璃风铃',recentN:2});
  assert.deepEqual(ctx.info.excerptChapters,[3]);
  assert.match(ctx.system,/那天河边的玻璃风铃碎了/);
});
