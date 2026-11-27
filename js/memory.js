// 墨游 · 存档员：把新发生的剧情整理进前情档案
// 档案挂在某一章的回复节点上（node.checkpoint）。回退、开分支时，自动用当前这条线上最近的那份。

import { PROTAGONIST_FIELDS } from './protagonist.js';
import { db } from './db.js';
import { memoryRequest } from './memory-request.js';
import { latestCheckpoint, inputBudgetChars, memoryText, applyCardState, splitNames, protagonistText } from './prompt.js';
import { chaptersOf } from './fanwai.js';
import { normalizeUsage, computeCost, recordUsage } from './cost.js';
import { ensureStructured, syncStructured, addEvents } from './structured-memory.js';
import { continuityArchivePrompt, updateContinuity } from './continuity.js';

export const BATCH = 10;          // 多章积压时恢复原有批量整理；逐章模式仍一次整理一章
const SUMMARY_LIMIT = 8000;       // 各段摘要超过这么多字，就把最早的一半压缩成“早期概要”

export function emptyMemory() {
  return { upTo: 0, early: '', earlyUpTo: 0, summaries: [], irreversible: [], corrections: [], items: [], threads: [], knowledge: [], offscreen: [], repeats: [], conflicts: [], unsure: [], cards: {}, runs: 0 };
}

/** 当前这条线：最近一次存档整理到第几章、后面还有哪些章没整理 */
export function pendingChapters(path) {
  const cp = latestCheckpoint(path);
  const all = chaptersOf(path);
  let upTo = 0;
  if (cp) {
    const hit = all.find((c) => c.id === cp.node.id);
    upTo = hit ? hit.no : (cp.mem.upTo || 0);
  }
  return { cp, upTo, all, pending: all.filter((c) => c.no > upTo) };
}

function arr(v) { return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).map((x) => x.trim()).filter(Boolean) : []; }
function dedupeAppend(a, b) {
  const seen = new Set(a.map((x) => x.trim()));
  for (const x of b) seen.add(x.trim());
  return [...seen];
}

function parseJson(raw) {
  const t = String(raw || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  throw new Error('没有完整的 JSON 对象');
}

function chapterBlock(c) {
  return `【第${c.no}章${c.title ? ' · ' + c.title : ''}】\n${c.said ? '（主角：' + c.said.trim() + '）\n' : ''}${c.text}`;
}

// 只缩小这次整理要重读的副本。整表更新时，未展示给模型的条目原样保留。
function recentRows(rows, cap, textOf = String) {
  let chars = 0;
  return [...(rows || [])].reverse().filter(row => {
    const size = textOf(row).length + 2;
    if (size + chars > cap) return false;
    chars += size;
    return true;
  }).reverse();
}

const mutableFields = ['items','threads','knowledge','offscreen','repeats'];

function arcParts(arc) {
  const rows = (arc || '').trim().split(/\n+/);
  if (rows.join('\n').length <= 1200 || rows.length < 2) return null;
  const split = Math.ceil(rows.length/2);
  return {early:rows.slice(0,split).join('\n'),recent:rows.slice(split).join('\n')};
}

export function archivistPrompt(story, prev, batch, path = [], syncProtagonist = true) {
  const cards = (story.cards || []).filter((c) => c.name?.trim()).map((c) => {
    const s = applyCardState(c, prev);
    const arc = arcParts(s.arc);
    return [`· ${c.name}${c.aliases?.trim() ? '（' + c.aliases.trim() + '）' : ''}`,
      c.initial?.trim() ? '  初始设定：' + c.initial.trim().slice(0, 300) : '',
      s.now?.trim() ? '  当前状态：' + s.now.trim() : '',
      s.arc?.trim() ? '  变化轨迹：' + (arc ? '【可压缩的早期轨迹】'+arc.early+'\n【近期轨迹】'+arc.recent.split('\n').slice(-8).join('\n') : s.arc.trim()) : '',
      s.relation?.trim() ? '  关系档案：' + s.relation.trim() : ''].filter(Boolean).join('\n');
  }).join('\n');
  const from = batch[0].no;
  const to = batch[batch.length - 1].no;
  const visible = { ...prev, records: undefined, early: (prev.early || '').slice(0, 1800),
    summaries: recentRows(prev.summaries, 1600, row => row.text) };
  for (const field of ['irreversible','corrections','items','threads','knowledge','offscreen','repeats','unsure']) {
    visible[field] = mutableFields.includes(field) ? (prev[field] || []).slice(-30) : recentRows(prev[field], 700);
  }
  const briefCandidates = (prev.records || []).filter(r => r.invalidatedAt == null &&
    (r.irreversible || r.type === 'correction' || r.type === 'knowledge') &&
    typeof r.event === 'string' && r.event.length > 40 && !r.brief && !r.briefChecked);
  const briefTargets = [];
  let remaining = 1200;
  for (const r of briefCandidates) {
    if (r.event.length > remaining) continue;
    briefTargets.push({id:r.id,event:r.event});
    remaining -= r.event.length;
    if (briefTargets.length === 4) break;
  }
  const prevText = prev.upTo ? memoryText(visible) + (visible.unsure.length ? '\n〔待确认〕\n' + visible.unsure.join('\n') : '') : '（还没有，这是第一次整理）';
  return {
    visible, briefTargets,
    omitted: ['summaries','irreversible','corrections','unsure',...mutableFields].reduce((n,k)=>n+(prev[k]?.length || 0)-(visible[k]?.length || 0),0),
    system: '你是这部文字互动小说的存档员。把新发生的剧情整理进前情档案：只记正文里确实发生的事，不脑补、不美化、不写感想；拿不准的放进“unsure”。只输出一个 JSON 对象，不要任何说明，也不要代码块标记。',
    user: [
      story.world?.trim() ? '【世界设定】\n' + story.world.trim().slice(0, 4000) : '',
      protagonistText(story, syncProtagonist ? path : []),
      cards ? '【角色卡（初始设定、原话、性格与底线、玩家填写的绝不这些不归你改；你只负责“当前状态”“变化轨迹”“关系档案”）】\n' + cards : '【角色卡】\n（还没有任何角色卡）',
      briefTargets.length ? '【补写旧核心事实简版】只处理下列 ID。保留否定、归属、时序与知情边界，40字内不能准确表达就留空。\n'+JSON.stringify(briefTargets) : '',
      '【已有的前情档案】\n' + prevText,
      prev.records?.length ? '【近期可覆盖的结构化记忆 ID】\n' + prev.records.filter((x) => x.column === 'event' && !x.irreversible && x.invalidatedAt == null).slice(-80)
        .map((x) => `${x.id}｜第${x.sourceFrom}${x.sourceTo !== x.sourceFrom ? '–' + x.sourceTo : ''}章｜${x.event.slice(0, 130)}`).join('\n') : '',
      story.memoryMode !== 'full' ? continuityArchivePrompt(prev.continuity) : '',
      `【新的剧情：第${from}–${to}章】\n` + batch.map(chapterBlock).join('\n\n'),
      '【请输出这个 JSON】\n' + JSON.stringify({
        summary: `第${from}–${to}章的剧情摘要，详略随实际变化。影响后续的选择、代价、信息差与关系转折写出前因和后果，必要时留一句原话；仅交代过渡的日常合成一句，平静的一段允许很短。无需逐章复述或凑字数`,
        irreversible: ['这一段新增的不可逆的事：受伤、失去、承诺、人情、关系越线、身份暴露……一条一件；没有就空数组'],
        ...(briefTargets.length ? {briefUpdates:[{id:'上述旧事实 ID',brief:'准确简版或空字符串'}]} : {}),
        changes: [{field:'items/threads/knowledge/offscreen/repeats', old:'需要结束的旧条目，逐字复制', chapter:from, quote:'证明已解决或被替换的本批正文连续原句', next:'替代条目，已解决则空字符串'}],
        items: ['新增或变化的物品、信物、特殊标记：谁给了谁什么、现在在谁手里'],
        threads: ['仅新增的条目，修改或结束已有条目用 changes：未决事项、承诺、暗线、已选但未演绎完的行动，以及玩家明确保留的后续提案。标明发生状态与具体内容，不只记选项字母；未选且未保留的提案不列为待办，已经解决的删掉。资料没有对应内容时放 unsure，不脑补'],
        knowledge: ['仅新增的条目，修改或结束已有条目用 changes：重要的信息差，写成“某事：谁知道／谁不知道（从什么渠道知道）”，每条同时在 memories 中按完全相同的 event 原文给出 type=knowledge，必须填写 knowers，列明确知情者，只有无法确定时才留空数组。尤其写清主角自己知道什么'],
        memories: [{ event: '本章具体事件或改变的事实，一条一件；无法确定归属章节就留空', sourceChapter: from,
          brief:'不可逆事实可给40字内准确简版，保留限定条件；否则留空', people: ['涉及的人物，用角色卡名'], location: '地点，不确定则空字符串', items: ['物品和别名'], type: '关系/事实/承诺/物品/暗线',
          importance: 7, irreversible: false, knowers: ['逐条列出明确亲历或被告知此事的人名；公开发布且公众能获知的事实加入“公开”。公开场合的私语、内心和幕后动机单独记。无法确定就空数组'], tags: ['称呼、别名和可检索的关键词'], replaces: ['被覆盖的旧记忆 ID；无法确定就空数组'] }],
        offscreen: ['仅新增的条目，修改或结束已有条目用 changes：主角看不见的地方，各角色接下来想做什么、正在做什么（只写正文里有迹可循的）'],
        repeats: ['最近这一段里反复出现、开始变成套路的互动或写法，接下来该避开的；没有就空数组'],
        newCharacters: [{
          name: '这一段新登场、之后还会反复出现的重要角色（尤其是和主角有感情线、或者有明确目的还会再找上门的），而且【角色卡】里还没有；路人、一次性角色不要写；没有就空数组',
          aliases: '别名、别人对他的称呼，用顿号分开',
          core: '是不是主要角色：true 或 false',
          initial: '身份、外貌、怎么登场的、和主角的关系、对主角的初始态度',
          base: '从正文看出来的性格底色：遇事怎么反应、怎么说话',
          voice: '正文里他说过的有代表性的原话，原样摘，一行一句',
          forbid: '根据剧情写角色通常怎么做、在意什么，底线可以随经历变化；不要写成“绝不”或推断永久禁令；没有依据就留空',
          now: '现在走到哪一步、对主角的立场、彼此怎么称呼',
          relation: '和主角的关系：相处梗、称呼、约定',
        }],
        ...(syncProtagonist ? {protagonistChanges: Object.fromEntries(Object.entries(PROTAGONIST_FIELDS).map(([field,label]) =>
          [field, label+'：仅本批剧情确有变化时填写更新后的完整内容，否则省略此项。保留仍有效的资料。']))} : {}),
        cards: { 角色名: { now:'当前称呼和对主角的立场。', brief:'当前关系与称呼的一句话，最多40字', arcAdd:'默认留空。称呼、立场、关系、身份或能力确实变化时才写：第N章，从X变成Y。', arcSummary:'仅对标为可压缩的早期轨迹写一句整体走向，最多200字；不能准确概括则空。', relation:'按人物分行，400字内写当前态度、动机与分寸。变化用已不再……表述。旧事件、道具和原话记录为事实。' } },
        conflicts: ['新剧情和已有设定或档案矛盾的地方（不要自己改，列出来给玩家裁决）'],
        unsure: ['拿不准的地方'],
        ...(story.memoryMode !== 'full' ? {
          sceneStarts: [{ chapter: from, quote: '换场所在章的连续正文原句，只标确实换场的章；否则空数组' }],
          openLines: [{ id: '更新已有互动时填旧 id；新增留空', chapter: from, people: ['直接参与者'],
            detail: '发生了什么、谁怎么回应、什么还没定', quote: '本批剧情中体现动作和回应的连续正文原句，6–720 字' }],
          closeLines: [{ id: '已经解决的旧互动 id', chapter: from, quote: '本批剧情中能证明此事已经说开或解决的连续正文原句' }],
        } : {}),
      }, null, 1),
      'cards 里只写这一段出场或有变化、而且已经有角色卡的角色，键用角色卡上的名字；还没有卡的重要新角色写进 newCharacters。普通日常已在摘要交代即可。memories 记录值得以后独立找回的变化，各条标实际来源章，能确认知情者才填写；旧事实被新事实取代时，在 replaces 里写旧条目的 ID，不能确认就不覆盖。',
    ].filter(Boolean).join('\n\n'),
  };
}

function merge(prev, j, from, to, story) {
  const m = { ...emptyMemory(), ...prev };
  if (Array.isArray(prev.records)) m.records = structuredClone(prev.records);
  m.upTo = to;
  m.summaries = [...(prev.summaries || []), { from, to, text: String(j.summary || '').trim() || '（这一段没有整理出摘要）' }];
  m.irreversible = dedupeAppend(prev.irreversible || [], arr(j.irreversible));
  m.items = dedupeAppend(prev.items || [], arr(j.items));
  if (Array.isArray(j.threads)) m.threads = arr(j.threads);
  if (Array.isArray(j.knowledge)) m.knowledge = arr(j.knowledge);
  if (Array.isArray(j.offscreen)) m.offscreen = arr(j.offscreen);
  if (Array.isArray(j.repeats)) m.repeats = arr(j.repeats);
  m.conflicts = dedupeAppend(prev.conflicts || [], arr(j.conflicts).map((x) => `（第${from}–${to}章）${x}`));
  m.unsure = dedupeAppend(prev.unsure || [], arr(j.unsure).map((x) => `（第${from}–${to}章）${x}`));
  m.cards = { ...(prev.cards || {}) };
  const names = new Set((story.cards || []).map((c) => c.name));
  if (j.cards && typeof j.cards === 'object') {
    for (const [name, v] of Object.entries(j.cards)) {
      if (!v || typeof v !== 'object' || !names.has(name)) continue;
      const card = (story.cards || []).find((c) => c.name === name);
      const old = applyCardState(card, prev);
      const arcAdd = String(v.arcAdd || '').trim();
      const arc = arcParts(old.arc);
      const summary = typeof v.arcSummary === 'string' ? v.arcSummary.trim() : '';
      const history = arc && summary && summary.length <= 200 ? '【整体走向】'+summary+'\n'+arc.recent : old.arc?.trim();
      const brief = typeof v.brief === 'string' ? v.brief.trim() : '';
      m.cards[name] = {
        brief:brief && brief.length <= 40 ? brief : (v.now || v.relation ? '' : old.brief || ''),
        now: String(v.now || '').trim() || old.now || '',
        arc: [history, arcAdd && !history?.split('\n').includes(arcAdd) ? arcAdd : ''].filter(Boolean).join('\n'),
        relation: String(v.relation || '').trim() || old.relation || '',
      };
    }
  }
  m.runs = (prev.runs || 0) + 1;
  m.at = Date.now();
  return m;
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const txt = (v) => (Array.isArray(v) ? v.join('\n') : String(v ?? '')).trim();

/** 存档员发现的新角色：自动建卡（不常驻、标“AI 新加”），存进故事，并通知打开着的页面 */
async function addNewCharacters(story, j, from, to) {
  const list = Array.isArray(j.newCharacters) ? j.newCharacters : [];
  if (!list.length) return [];
  let base = null;
  try { base = await db.get('stories', story.id); } catch {}
  base = base || story;
  base.cards = base.cards || [];
  const known = new Set();
  for (const c of base.cards) splitNames(c).forEach((a) => known.add(a));
  const added = [];
  for (const x of list) {
    const name = String(x?.name || '').trim();
    if (!name || name.length > 20 || known.has(name)) continue;
    const aliases = txt(x.aliases);
    if (splitNames({ name, aliases }).some((a) => known.has(a))) continue;
    const card = {
      id: newId(), name, aliases, core: x.core === true || x.core === 'true',
      initial: txt(x.initial), base: txt(x.base), voice: txt(x.voice), forbid: txt(x.forbid),
      arc: `第${from}–${to}章登场`, now: txt(x.now), relation: txt(x.relation),
      auto: { from, to, at: Date.now() },
    };
    base.cards.push(card);
    splitNames(card).forEach((a) => known.add(a));
    added.push(card);
  }
  if (!added.length) return [];
  base.updatedAt = Date.now();
  await db.put('stories', base);
  story.cards = base.cards;
  try { window.dispatchEvent(new CustomEvent('moyu:cards', { detail: { storyId: story.id, cards: base.cards, added: added.map((c) => c.name) } })); } catch {}
  return added;
}

async function compressIfLong(m, conn, signal, track, key) {
  const total = (m.summaries || []).reduce((a, x) => a + x.text.length, 0);
  if (total <= SUMMARY_LIMIT || m.summaries.length < 3) return m;
  const half = Math.ceil(m.summaries.length / 2);
  const old = m.summaries.slice(0, half);
  const user = (m.early?.trim() ? `【已有的早期概要（第1–${m.earlyUpTo}章）】\n${m.early.trim()}\n\n` : '') +
    '【要并进去的摘要】\n' + old.map((x) => `第${x.from}–${x.to}章：${x.text}`).join('\n') +
    `\n\n把上面的内容合并压缩成一段“早期概要”（第1–${old[old.length - 1].to}章），最多1800字：优先保留仍影响现在的决定、缘由和后果、关系转折及尚未兑现的约定。已解决的支线一句交代，过场可省略，不要求各章等长。只输出概要正文。`;
  const r = await memoryRequest(key, conn, { system: '你是这部文字互动小说的存档员，只输出概要正文。', messages: [{ role: 'user', content: user }], maxTokens: 4000, signal });
  track(r, user.length, '压缩前情');
  if (r.truncated || r.interrupted || r.flagged || !r.text.trim()) return m;
  return { ...m, early: r.text.trim(), earlyUpTo: old[old.length - 1].to, summaries: m.summaries.slice(half) };
}

/**
 * 整理当前这条线上还没整理的章节。
 * nodes：Map；path：当前这条线；返回 { written: [节点], cost, from, to }
 * onProgress(text) 报进度
 */
// 同一个故事同时只跑一个整理（游玩页后台整理时打开记忆页，不会重复跑）
const active = new Map();
export function archivingNow(storyId) { return active.get(storyId) || null; }

const pauseKey = (storyId, nodeId) => JSON.stringify(["archivePause", storyId, nodeId]);
export async function archivePause(storyId, nodeId) {
  const reason = await db.kvGet(pauseKey(storyId,nodeId),null);
  if (reason) return reason;
  const task = await db.kvGet(taskKey(storyId,nodeId),null);
  const phase = task?.result ? await db.kvGet(taskKey(storyId,nodeId) + '.compress',null) : task;
  return phase && !phase.job && !phase.result ? '上一批请求中断，尚未保存。可手动重试。' : null;
}

const taskKey = (storyId, nodeId) => JSON.stringify(['archiveTask', storyId, nodeId]);
export async function archiveRecovery(storyId, firstId) {
  if (!firstId) return false;
  const key = taskKey(storyId, firstId);
  const task = await db.kvGet(key, null);
  if (!task) return false;
  const phase = await db.kvGet(key + '.compress', null);
  if (phase) return !!phase.job || !!phase.result;
  return task.result ? !(await archivePause(storyId, firstId)) : !!task.job;
}

export async function runArchivist(story, nodes, path, conn, opts = {}) {
  const locks = globalThis.navigator?.locks;
  if (locks?.request) return locks.request('moyu-archive-'+story.id,{ifAvailable:true}, lock=>{
    if (!lock) throw Object.assign(new Error('这个故事正在另一个页面整理'),{kind:'busy'});
    return runLocalArchivist(story,nodes,path,conn,opts);
  });
  return runLocalArchivist(story,nodes,path,conn,opts);
}

async function runLocalArchivist(story,nodes,path,conn,opts) {
  if (active.has(story.id)) { const e = new Error('这个故事正在整理前情，等它完成再试'); e.kind = 'busy'; throw e; }
  const info = { text: '正在整理前情', ctrl: opts.ctrl || null };
  active.set(story.id, info);
  const onProgress = opts.onProgress || (() => {});
  let pendingId;
  try {
    const chapters = {...pendingChapters(path), path};
    const first = chapters.pending[0];
    pendingId = first?.id;
    if (first && opts.automatic && !(await archiveRecovery(story.id, first.id))) {
      const paused = await archivePause(story.id, first.id);
      if (paused) return { written: [], paused };
    }
    return await runInner(story, nodes, chapters, conn, { ...opts, onBatchStart: id => { pendingId = id; }, onProgress: (t) => { info.text = t; onProgress(t); } });
  } catch (e) {
    if (pendingId) await db.kvSet(pauseKey(story.id, pendingId), opts.signal?.aborted ? '已手动停止' : e.message || '整理失败');
    throw e;
  } finally {
    active.delete(story.id);
  }
}

async function runInner(story, nodes, { cp, upTo, pending, path }, conn, { signal, onBatchStart, onProgress = () => {}, minChapters = 1 } = {}) {
  if (pending.length < minChapters) return { written: [], from: 0, to: 0 };
  let prev = cp ? cp.mem : emptyMemory();
  ensureStructured(prev, cp?.node.id || '');
  const written = [];
  const newCards = [];
  let costSum = null;
  const track = (r, inChars, kind = '整理前情') => {
    const u = normalizeUsage(r.usage, { inChars, outChars: r.text.length });
    const c = computeCost(u, conn);
    if (c) costSum = costSum && costSum.currency === c.currency ? { ...c, amount: costSum.amount + c.amount, est: costSum.est || c.est } : c;
    recordUsage({ kind, storyId: story.id, model: conn?.model || '', usage: u, cost: c });
  };
  const batchSize = Number(story.memEvery) === 1 ? 1 : BATCH;
  const budget = inputBudgetChars(conn);
  for (let i = 0; i < pending.length;) {
    const key = taskKey(story.id, pending[i].id);
    const saved = await db.kvGet(key, null);
    const batch = pending.slice(i, i + (saved?.ids?.length || batchSize));
    if (saved?.ids && saved.ids.some((id,index) => id !== batch[index]?.id)) {
      throw Error('该批次属于另一条剧情分支，请回到原分支接回');
    }
    onBatchStart(batch[0].id);
    const priorPath = path.slice(0, path.findIndex(node => node.id === batch[0].id)).map(node => nodes.get(node.id) || node);
    const source = {...story, protagonist:(await db.get('stories',story.id))?.protagonist || story.protagonist};
    const makePrompt = () => archivistPrompt(source, prev, batch, priorPath, !saved || saved.protagonistSync === true);
    let p = makePrompt();
    while (!saved && p.system.length + p.user.length > budget && batch.length > 1) {
      batch.pop();
      p = makePrompt();
    }
    const from = batch[0].no;
    const to = batch[batch.length - 1].no;
    if (!saved && p.system.length + p.user.length > budget) throw new Error(`第 ${from} 章连同档案超过连接的输入预算（${budget} 字），请调高预算后继续整理`);
    onProgress(`正在整理第 ${from}–${to} 章`);
    const r = await memoryRequest(key, conn, {
      system: p.system, messages: [{ role: 'user', content: p.user }], maxTokens: 16000, signal,
      onText: (_d, full) => onProgress(`正在整理第 ${from}–${to} 章（已写 ${full.length} 字）`),
    }, { ids: batch.map(c => c.id), protagonistSync:true });
    const raw = r.text;
    if (!saved?.result) track(r, p.system.length + p.user.length);
    let j;
    try { j = parseJson(raw); } catch { j = null; }
    if (!j || r.truncated || typeof j.summary !== 'string' || !j.summary.trim()) {
      const reason = r.truncated ? '回复达到输出上限' : '回复未包含完整有效的剧情摘要';
      const e = new Error(`第 ${from}–${to} 章整理已暂停：${reason}`);
      e.detail = (raw.length > 1500 ? raw.slice(0, 700) + '\n……\n' + raw.slice(-700) : raw);
      e.hint = r.truncated ? '回复写到输出上限被截断了。可以在连接里把“输出上限”调大，或者换个不开思考的模型来整理。' : '';
      await db.del('kv', key);
      throw e;
    }
    signal?.throwIfAborted();
    const closed = new Map();
    const review = [];
    for (const change of Array.isArray(j.changes) ? j.changes : []) {
      if (!change || !mutableFields.includes(change.field) || !p.visible[change.field].includes(change.old)) continue;
      const chapter = batch.find(c=>c.no === change.chapter);
      const quote = String(change.quote || '').trim();
      if (quote.length < 4 || !chapter?.text.includes(quote)) {
        review.push('待核实的变更：'+change.old);
        continue;
      }
      closed.set(change.field+'\n'+change.old,change);
    }
    let m = merge(prev, j, from, to, story);
    for (const field of mutableFields) {
      const retiring = [...closed.values()].filter(c=>c.field === field);
      if (retiring.length > (prev[field]?.length || 0)*0.3) review.push(...retiring.map(c=>'本批集中更新，请核对：'+c.old+'（依据：'+c.quote+'）'));
    }
    m.unsure = dedupeAppend(m.unsure,review);
    for (const field of mutableFields) {
      const old = (prev[field] || []).filter(row=>!closed.has(field+'\n'+row));
      const additions = arr(j[field]).filter(row=>!closed.has(field+'\n'+row));
      for (const change of closed.values()) if (change.field === field && typeof change.next === 'string' && change.next.trim()) additions.push(change.next.trim());
      m[field] = dedupeAppend(old,additions);
    }
    if (story.memoryMode !== 'full') m.continuity = updateContinuity(prev.continuity, j, batch, nodes);
    m = await compressIfLong(m, conn, signal, track, key + '.compress');
    syncStructured(m, m, { from, to, branchId: batch[batch.length - 1].id, metadata: j.memories });
    for (const field of mutableFields) {
      const dormant = new Set(m[field].slice(0,-30));
      for (const r of m.records) {
        if (r.column !== field) continue;
        const change = closed.get(field+'\n'+r.event);
        if (change && r.invalidatedAt === to) r.invalidatedAt = change.chapter;
        if (r.sourceFrom === from && r.sourceTo === to && r.invalidatedAt == null) {
          const update = [...closed.values()].find(c=>c.field === field && c.next === r.event);
          if (update) r.sourceFrom = r.sourceTo = r.sourceChapter = update.chapter;
        }
        if (r.invalidatedAt == null && dormant.has(r.event)) r.dormant = true;
      }
      m[field] = m[field].slice(-30);
    }
    for (const update of Array.isArray(j.briefUpdates) ? j.briefUpdates : []) {
      const target = p.briefTargets.find(t=>t.id === update?.id);
      if (!target || typeof update.brief !== 'string' || update.brief.length > 40) continue;
      const record = m.records.find(r=>r.id === target.id && r.event === target.event && r.invalidatedAt == null);
      if (record) { record.brief = update.brief.trim(); record.briefChecked = true; }
    }
    addEvents(m, j.memories, from, to, batch[batch.length - 1].id);
    m.protagonistChanges = Object.fromEntries(Object.keys(PROTAGONIST_FIELDS).filter(field => typeof j.protagonistChanges?.[field] === 'string' && j.protagonistChanges[field].trim()).map(field => [field,j.protagonistChanges[field].trim()]));
    m.lastRun = { at: Date.now(), from, to, omitted:p.omitted, model: conn?.model || '', cost: costSum };
    const node = nodes.get(batch[batch.length - 1].id);
    if (!node) throw new Error(`无法保存第 ${to} 章，找不到章节节点`);
    signal?.throwIfAborted();
    await db.put('nodes', { ...node, checkpoint: m });
    node.checkpoint = m;
    await db.del('kv', key);
    await db.del('kv', key + '.compress');
    newCards.push(...(await addNewCharacters(story, j, from, to)).map((c) => c.name));

    if (await archivePause(story.id, batch[0].id)) await db.del('kv', pauseKey(story.id, batch[0].id));
    i += batch.length;
    // 通知当前打开的页面：它手里的同一节点对象要补上这份档案，免得之后保存时把档案覆盖掉
    try { window.dispatchEvent(new CustomEvent('moyu:checkpoint', { detail: { storyId: story.id, nodeId: node.id, mem: m } })); } catch {}
    written.push(node);
    prev = m;
  }
  return { written, from: pending[0].no, to: prev.upTo || 0, cost: costSum, prevUpTo: upTo, newCards };
}
