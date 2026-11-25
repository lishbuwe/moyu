import { leanMemory, covered } from './lean-memory.js';
import { passageForFact, recallPassages } from './recall.js';
// 墨游 · 每轮重新拼装发给模型的内容
// 顺序：固定规则、设定、常驻角色卡、前情档案 → 动态模块和角色 → 对话原文。

import { forContext, parseReply } from './parse.js';
import { INPUT_CONVENTION, PERSONAL_RULES, OPTION_GUIDE } from './personal.js';
import { protagonistState, PROTAGONIST_FIELDS } from './protagonist.js';
import { EMPHASIS_GUIDE } from './inline.js';
import { stripReasoning, finalOutputGuide } from './reasoning.js';
import { projectColumns, coreFact, layeredMemory } from './structured-memory.js';
import { activeEdition, editionMemory } from './consolidation.js';
import { continuityPlan } from './continuity.js';

export const DEFAULT_RULES = PERSONAL_RULES;

export function formatContract({ danmu = true, options = true, showThought = false } = {}) {
  const parts = [
    finalOutputGuide(showThought),
    '每次回复严格按下面的格式，不要输出格式以外的说明：',
    '# 本章标题（第一行，四到十二个字，不写“第几章”）',
    '（空一行后写正文）',
    EMPHASIS_GUIDE,
  ];
  if (danmu) {
    parts.push(
      '【弹幕】',
      '网名：弹幕内容',
      '（3到8条，一行一条。弹幕是正在看这段剧情的读者实况：吐槽、嗑CP、站队、预测、尖叫，长短错落；不复述正文原句，不写分析文。剧中人物不知道弹幕存在。）'
    );
  }
  if (options) parts.push(OPTION_GUIDE);
  parts.push('', '玩家以“（出戏）”开头的话是场外交流：用场外身份简短直接地回答，不推进剧情，不用上面的格式。');
  return parts.join('\n');
}

export function userContent(node, { withDirector = false } = {}) {
  let c;
  if (node.kind === 'start') {
    c = '（开始游戏）\n' + (node.text?.trim()
      ? '开场：' + node.text.trim()
      : '请根据设定写开场：交代主角此刻所处的情境，停在第一个需要主角行动的地方。');
  } else if (node.kind === 'continue') {
    c = '（继续：让剧情自然往前走一步，不替我做选择）';
  } else if (node.kind === 'ooc') {
    c = '（出戏）' + (node.text || '');
  } else {
    c = node.text || '';
  }
  if (withDirector && node.director?.trim()) c += directorBlock(node.director);
  return c;
}

export function directorBlock(text) {
  return text?.trim() ? '\n\n【导演指令·仅本轮有效，来自玩家的场外要求：照做，但不要在正文里提到】\n' + text.trim() : '';
}

export const CONTINUE_MSG = '（系统：上一条回复中途断开了。请从断开的地方直接接着往下写完，不要重复已经写过的内容，不要加任何开场白；写完后照常附上格式要求里的其余部分。）';

/** 从某一段往后重写：前文保留，后面按要求重新写 */
export function rewriteMsg(note) {
  return '（系统：上一条回复只保留到这里，后面的内容作废。请从这里直接接着往下重新写' +
    (note?.trim() ? '，这次的要求：' + note.trim() : '') +
    '。不要重复已经写过的内容，不要加开场白；写完后照常附上格式要求里的其余部分。）';
}

// ───────────── 角色卡与规则模块 ─────────────

export function splitNames(card) {
  return [card.name, ...String(card.aliases || '').split(/[,，、;；\s]+/)].map((x) => (x || '').trim()).filter((x) => x.length >= 1);
}

const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
const asList = (t) => lines(t).map((l) => (/^[-*•·]/.test(l) ? l.replace(/^[-*•·]\s*/, '- ') : '- ' + l)).join('\n');

/** 主角（玩家扮演的“你”）：名字、性别、外貌身份等。番外换成第三人称时最容易写错性别，所以每处都带上 */
export function protagonistText(story, path = []) {
  const p = story?.protagonist || {};
  const lines = [
    p.name?.trim() ? `名字：${p.name.trim()}` : '',
    p.gender?.trim() ? `性别：${p.gender.trim()}${/女/.test(p.gender) ? '（用“她”）' : /男/.test(p.gender) ? '（用“他”）' : ''}` : '',
    p.publicProfile?.trim() || '',
    p.note?.trim() ? p.note.trim() : '',
    ...Object.entries(protagonistState(p, path)).map(([key, entry]) => `当前·${PROTAGONIST_FIELDS[key]}：${entry.value}`),
  ].filter(Boolean);
  if (!lines.length) return '';
  return '【主角（玩家扮演的“你”）】\n' + lines.join('\n') + '\n叙述中的姓名和人称按这里来；角色在对白中的称呼，随双方已发生的互动和当前场合自然变化。';
}

function arcForPrompt(arc, {keep=3, maxChars=700}={}) {
  const rows=(arc || '').split('\n').map(t=>t.trim()).filter(Boolean);
  const head=rows[0]?.startsWith('【整体走向】') ? rows.shift() : '';
  const tail=rows.slice(-keep);
  while (true) {
    const omitted=rows.length-tail.length;
    const note=omitted ? '（更早的变化已省略，共 '+omitted+' 条）' : '';
    const result=[head,note,...tail].filter(Boolean).join('\n');
    if (result.length<=maxChars || tail.length<=1) return result.slice(0,maxChars);
    tail.shift();
  }
}
export function cardText(c, {arcLimit, voiceLimit}={}) {
  if (arcLimit || voiceLimit) c={...c,arc:arcForPrompt(c.arc,{maxChars:arcLimit}),voice:(c.voice||'').split('\n').slice(0,voiceLimit).join('\n')};
  const parts = [`【角色卡·${c.name || '未命名'}】` + (c.aliases?.trim() ? `（也叫：${c.aliases.trim()}）` : '')];
  if (c.publicProfile?.trim()) parts.push('〔公开资料〕\n' + c.publicProfile.trim());
  if (c.initial?.trim()) parts.push('〔初始设定〕\n' + c.initial.trim());
  if (c.base?.trim()) parts.push('〔底色：遇事怎么做、说话的样子、身份与配套〕\n' + c.base.trim());
  if (c.voice?.trim()) parts.push('〔原话（只用来校准口气和节奏，不要照抄）〕\n' + asList(c.voice));
  if (c.forbid?.trim()) parts.push('〔禁止：他不会这样做〕\n' + asList(c.forbid));
  if (c.arc?.trim()) parts.push('〔变化轨迹〕\n' + c.arc.trim());
  if (c.now?.trim()) parts.push('〔当前状态与称呼〕\n' + c.now.trim());
  if (c.relation?.trim()) parts.push('〔和主角的关系档案〕\n' + c.relation.trim());
  return parts.join('\n');
}

function mentioned(text, card) {
  if (!text) return false;
  return splitNames(card).some((n) => (n === card.name || n.length >= 2) && text.includes(n));
}

/** 用来判断“谁在场 / 哪个关键词出现了”的文字：本轮输入、导演指令、最近两条回复 */
function scanText(path, extra = '') {
  const users = path.filter((n) => n.role === 'user');
  const replies = path.filter((n) => n.role === 'assistant' && n.kind !== 'ooc' && n.text);
  const u = users[users.length - 1];
  return [u?.text || '', u?.director || '', ...replies.slice(-2).map((n) => {
    const { title, body } = parseReply(n.text);
    return [title, body].filter(Boolean).join('\n');
  }), extra].join('\n');
}

/**
 * 选出这一轮要发的角色卡和模块。
 * modules：全局模块库；story.modules：这个故事启用的模块；story.manualOn：手动开着的情境模块
 */
export function selectExtras(story, path, modules = [], extra = '') {
  const scan = scanText(path, extra);
  const cards = (story.cards || []).filter((c) => c.name?.trim());
  const sentCards = cards.filter((c) => c.core || mentioned(scan, c));
  const present = sentCards.filter((c) => mentioned(scan, c));
  const enabled = new Set(Object.keys(story.modules || {}).filter((k) => story.modules[k]));
  // 全局模块库 + 这个故事自己导入的（酒馆预设、世界书）
  const sentModules = [...modules, ...(story.localModules || [])].filter((m) => {
    if (!enabled.has(m.id) || !m.text?.trim()) return false;
    if (m.mode === 'manual') return !!story.manualOn?.[m.id];
    if (m.mode === 'keyword') return String(m.keywords || '').split(/[,，、;；\s]+/).filter(Boolean).some((k) => scan.includes(k));
    return true;
  });
  return { sentCards, present, sentModules };
}

/** 末尾提醒：在场角色的禁止清单，放在最后一条玩家消息里（离模型“下笔”最近） */
/** 每轮最后一句的格式提醒：规则很长时模型容易忘了写弹幕和选项 */
function formatTail(story) {
  const want = [story.danmu !== false ? '【弹幕】' : '', story.options !== false ? '【选项】' : ''].filter(Boolean);
  if (!want.length) return '';
  return `\n\n（格式提醒：正文写完后依次写${want.join('和')}，不要省略。）`;
}

function tailReminder(present, { maxEach = 5 } = {}) {
  const rows = present.filter((c) => c.forbid?.trim()).map((c) => `- ${c.name}：${lines(c.forbid).slice(-maxEach).map((l) => l.replace(/^[-*•·]\s*/, '')).join('；')}`);
  if (!rows.length) return '';
  return '\n\n【在场角色提醒·玩家场外设置，不要在正文里提到】\n' + rows.join('\n');
}

// ───────────── 前情档案（存档挂在某一章的回复节点上） ─────────────

/** 当前这条线上最近的一次存档：{ index, node, mem }，没有则 null */
export function latestCheckpoint(path) {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].checkpoint) return { index: i, node: path[i], mem: path[i].checkpoint };
  }
  return null;
}

/** 角色卡上会随剧情变的三栏：有存档就用存档里最新的 */
export function applyCardState(card, mem) {
  const s = mem?.cards?.[card.name];
  if (!s) return card;
  return { ...card, brief: s.brief ?? card.brief, now: s.now ?? card.now, arc: s.arc ?? card.arc, relation: s.relation ?? card.relation };
}

const bullet = (arr) => (arr || []).map((x) => String(x || '').trim()).filter(Boolean).map((x) => '- ' + x.replace(/^[-*•·]\s*/, '')).join('\n');

export function memoryText(mem) {
  if (!mem) return '';
  mem = { ...mem, ...projectColumns(mem) };
  const out = [`【前情档案：第 1–${mem.upTo} 章已整理；之后的剧情见对话原文。档案里的是已经发生的事实】`];
  if (mem.early?.trim()) out.push('〔早期概要〕\n' + mem.early.trim());
  if (mem.summaries?.length) out.push('〔各段摘要〕\n' + mem.summaries.map((x) => `第${x.from}–${x.to}章：${x.text.trim()}`).join('\n'));
  const sec = (title, arr) => { const b = bullet(arr); if (b) out.push(`〔${title}〕\n${b}`); };
  sec('不可逆的事（永久有效）', mem.irreversible);
  sec('勘误（和上面冲突时以这里为准）', mem.corrections);
  sec('物品与信物', mem.items);
  sec('未决事项、未兑现的承诺、暗线', mem.threads);
  sec('信息差：谁知道什么、谁不知道', mem.knowledge);
  sec('暗处动向：各角色接下来想做什么', mem.offscreen);
  sec('最近反复出现的套路（接下来换个写法）', mem.repeats);
  return out.join('\n');
}

/**
 * path：从第一条到当前的节点（最后一条通常是刚发出的玩家输入）
 * opts.modules：全局规则模块库
 * 返回 { system, messages, info }，info.parts 是各部分的明细（给查看器用）
 */
/** 输入预算按字数保守粗估；模型真正的 token 数以接口回报为准。 */
export function inputBudgetChars(conn) {
  const n = Number(conn?.inputBudgetChars);
  return Number.isFinite(n) && n >= 6000 && n <= 120000 ? Math.floor(n) : 30000;
}

export function buildContext(story, path, { budgetChars = 60000, keepRawLast = 2, modules = [], extra = '', globalMemo = '', continuationMessages = [], showThought = false } = {}) {
  const lean = story.memoryMode !== 'full';
  let { sentCards, present, sentModules } = selectExtras(story, path, modules, extra);
  const cp = latestCheckpoint(path);
  if (cp) cp.mem = editionMemory(cp.mem, activeEdition(path));
  const compact = !!cp && Array.isArray(cp.mem.records) && story.memoryMode !== 'full';
  const recentN = Math.max(2, Math.min(lean ? 6 : 4, Number(story.recentChapters) || 2));
  const continuity = story.memoryMode !== 'full' ? continuityPlan(story, path, cp, splitNames, { recentN, extra }) : null;
  const user = path.findLast(n=>n.role === 'user');
  const director = [user?.director,extra].filter(Boolean).join(' ');
  const recentBodies = lean ? continuity.chapters.slice(-recentN).map(continuity.body) : [];
  if (lean) {
    present = (story.cards || []).filter(c=>continuity.presentNames.includes(c.name));
    sentCards = (story.cards || []).filter(c=>c.core || present.includes(c));
  }
  const selection = lean ? leanMemory(cp?.mem, [user?.text,director].filter(Boolean).join(' '), director,
    recentBodies.at(-1) || '', (story.cards || []).flatMap(splitNames), [...present.flatMap(splitNames),story.protagonist?.name].filter(Boolean), Math.min(1800,Math.floor(budgetChars/6))) : null;
  const layered = compact ? selection || layeredMemory(cp.mem, scanText(path, extra), { requireMatch: true, prioritizeCore: true }) : null;
  const parts = [];
  const add = (label, text, kind) => { if (text?.trim()) parts.push({ label, text: text.trim(), kind }); };
  function promptCard(c) {
    const state=applyCardState(c,cp?.mem);
    if (lean && !present.includes(c)) return ['【角色卡·' + c.name + '】',(state.brief || state.now || state.base || '').split(/[。！？\n]/)[0].slice(0,60)].filter(Boolean).join(' · ');
    return cardText(lean ? {...state,forbid:''} : state,lean ? {arcLimit:700,voiceLimit:2} : {});
  }
  add('开头', '你正在主持一场文字互动小说。', 'base');
  add('规则（这个故事）', story.rules?.trim() ? '【规则】\n' + story.rules.trim() : '', 'rules');
  add('全局备忘', globalMemo?.trim() ? '【全局备忘（所有故事通用）】\n' + globalMemo.trim() : '', 'rules');
  add('世界与角色设定', story.world?.trim() ? '【世界与角色设定】\n' + story.world.trim() : '', 'world');
  add('主角', protagonistText(story, path), 'card');
  for (const c of sentCards.filter((c) => c.core)) add(`角色卡 · ${c.name}（常驻）`, promptCard(c), 'card');
  if (cp && !compact) add(`前情档案 · 整理到第 ${cp.mem.upTo} 章`, memoryText(cp.mem), 'memory');
  if (layered?.core) add('永久核心记忆', `【永久核心：已发生的关键事实】\n${layered.core}`, 'memory');
  if (layered) {
    const current = [`当前已整理到第 ${cp.mem.upTo} 章`, ...(lean ? continuity.activeLines.map(line=>line.detail) : Object.entries(cp.mem.cards || {}).map(([name, v]) => `${name}：${String(v.now || '').slice(0, 160)}`).slice(0, 5)), layered.state].filter(Boolean).join('\n');
    add('当前状态', `【当前状态和未决事项】\n${current}`, 'memory');
  }
  // 只在稳定前缀末尾放缓存断点；本轮命中的模块和非核心角色不会使它失效。
  let cachePrefix = parts.map((p) => p.text).join('\n\n');
  for (const m of sentModules) add(`规则模块 · ${m.name}${m.mode === 'manual' ? '（情境）' : m.mode === 'keyword' ? '（关键词）' : ''}`, `【规则模块·${m.name}】\n${m.text.trim()}`, 'module');
  for (const c of sentCards.filter((c) => !c.core)) add(`角色卡 · ${c.name}（被提到）`, promptCard(c), 'card');
  add('玩家输入约定', INPUT_CONVENTION, 'rules');
  add('输出格式', '【输出格式】\n' + formatContract({ showThought, danmu: story.danmu !== false, options: story.options !== false }), 'format');
  if (continuity) add('互动连续性', '【互动连续性】\n初始设定是故事的起点。判断人物现在的态度、距离和措辞时，以本分支中已经发生的互动为依据。较早片段只是前因；可以延续、暂时搁下或在合适时回应。保留仍未挑明的地方，不替人物定性。', 'rules');
  let system = parts.map((p) => p.text).join('\n\n');
  const chapterReplies = path.map((n, i) => n.role === 'assistant' && n.kind !== 'ooc' && n.text?.trim() ? i : -1).filter((i) => i >= 0);
  const startReply = chapterReplies[Math.max(0, chapterReplies.length - recentN)];
  const recentStart = startReply == null ? 0 : (path[startReply - 1]?.role === 'user' ? startReply - 1 : startReply);
  const recentPath = continuity ? path.slice(recentStart) : cp ? path.slice(cp.index) : path;
  // 出戏对话：之后已经回到正戏的，就不再发给模型
  let lastPlayUser = -1;
  recentPath.forEach((n, i) => { if (n.role === 'user' && n.kind !== 'ooc') lastPlayUser = i; });
  const kept = recentPath.filter((n, i) => !(n.kind === 'ooc' && i < lastPlayUser));

  // 最近 keepRawLast 轮的回复保留弹幕和选项（让模型延续口气），更早的只留正文
  const playReplies = kept.filter((n) => n.role === 'assistant' && n.kind !== 'ooc');
  const rawSet = new Set(playReplies.slice(-(lean ? 1 : keepRawLast)).map((n) => n.id));

  const tail = tailReminder(present,{maxEach:lean ? 8 : 5});
  const fmtTail = formatTail(story);
  const lastUser = kept.findLast((n) => n.role === 'user');
  function message(n, raw = false) {
    if (n.role === 'user') {
      let content = userContent(n, { withDirector: n === lastUser });
      if (n === lastUser) {
        if (n.kind !== 'ooc') content += tail + fmtTail;
        if (extra.trim()) content += directorBlock(extra);
      }
      return { role: 'user', content };
    }
    const content = raw || n.kind === 'ooc' ? stripReasoning(n.text || '').trim() : forContext(n.text || '');
    return { role: 'assistant', content };
  }
  let messages = kept.map((n) => message(n, rawSet.has(n.id))).filter((m) => m.role === 'user' || m.content);

  let trimmed = 0;
  const size = (ms) => ms.reduce((a, m) => a + m.content.length, 0);
  const continuationChars = size(continuationMessages);
  let continuityInfo;
  const materials = [];
  if (lean) for (const card of story.cards || []) {
    const here = present.includes(card);
    materials.push({source:'角色卡',id:card.name,chars:sentCards.includes(card) ? promptCard(card).length : 0,
      reason:here ? '近期叙述或导演提及，完整卡；禁止清单在末尾提醒' : card.core ? '离场常驻，仅索引' : '离场非常驻，省略'});
  }
  const lead = {role:'user',content:cp ? '（更早的剧情见系统提示里的“前情档案”。下面从最近一章接着来。）' : '（更早的剧情因为太长没有发送。下面从这里接着来。）'};
  const fixedSize = () => size(messages) + system.length + continuationChars + (messages[0]?.role === 'assistant' ? lead.content.length : 0);
  if (continuity) {
    const evidence = selection?.verify && selection.candidates.find(({r})=>
      r.event.length + 18 <= 1200 && !parts.some(p=>p.text.includes(r.event)) && !covered(r.event,recentBodies,cp?.mem.records));
    const evidenceSpace = evidence ? ('【根据本轮场景召回的较早事实】\n- [第'+evidence.r.sourceFrom+'–'+evidence.r.sourceTo+'章] '+evidence.r.event).length+2 : 0;
    if (fixedSize() + evidenceSpace > budgetChars) {
      messages = kept.map((n) => message(n)).filter((m) => m.role === 'user' || m.content);
    }
    const cardParts = parts.filter(p=>p.kind === 'card');
    for (const card of [...sentCards].sort((a,b)=>Number(present.includes(a))-Number(present.includes(b)))) {
      if (fixedSize() + evidenceSpace <= budgetChars) break;
      const part = cardParts.find(p=>p.label === `角色卡 · ${card.name}${card.core ? '（常驻）' : '（被提到）'}`);
      if (!part) continue;
      const here = present.includes(card);
      if (here) {
        const state = applyCardState(card,cp?.mem);
        const shorter = cardText({...state,voice:'',forbid:''},{arcLimit:700});
        if (shorter.length >= part.text.length) continue;
        part.text = shorter;
      } else parts.splice(parts.indexOf(part),1);
      const entry = materials.find(m=>m.source==='角色卡' && m.id===card.name);
      if (entry) Object.assign(entry,{chars:here ? part.text.length : 0,reason:here ? '预算不足，省略原话示范' : '预算不足，省略离场索引'});
      cachePrefix = '';
      system = parts.map(p=>p.text).join('\n\n');
    }
    const selected = new Map();
    const baseline = continuity.chapters.filter((c) => c.index >= recentStart);
    for (const chapter of baseline) selected.set(chapter.id, null);
    let remaining = budgetChars - fixedSize();
    const recallTitle = '【根据本轮场景召回的较早事实】';
    const recalled = [];
    function takeFacts(priority, firstOnly = false) {
      for (const r of layered?.records.recalled || []) {
        if (recalled.some(x=>x.r===r) || (priority != null && !!coreFact(r) !== priority)) continue;
        const line = `- [第${r.sourceFrom}${r.sourceTo === r.sourceFrom ? '' : '–' + r.sourceTo}章] ${r.event}`;
        const chars = line.length + (recalled.length ? 1 : recallTitle.length + 3);
        if (chars > remaining) continue;
        remaining -= chars;
        recalled.push({r, line});
        if (firstOnly) break;
      }
    }
    if (selection && layered) {
      const sources = [...recentBodies, ...parts.map(p=>p.text)];
      let room = 1200;
      for (const { r, matches } of selection.candidates) {
        if (sources.some(text=>text.includes(r.event)) || covered(r.event,recentBodies,cp?.mem.records) ||
            r.event.length + 18 > room) continue;
        layered.records.recalled.push(r);
        room -= r.event.length + 18;
        sources.push(r.event);
        if (selection.verify && !continuity.excerpts.some(e=>e.key)) {
          const hit = passageForFact(continuity.chapters,continuity.body,r,matches,recentN,user?.text);
          if (hit && !sources.some(text=>text.includes(hit.quote)) && !r.event.includes(hit.quote)) continuity.excerpts.push(hit);
        }
        if (layered.records.recalled.length >= 5) break;
      }
    }
    if (compact && !selection.candidates.length && path.at(-1)?.kind !== 'ooc' &&
        selection.verify && !continuity.excerpts.some(hit => hit.key)) {
      const known = [...recentBodies, ...layered.records.core.map(r => r.event), ...layered.records.state.map(r => r.event)];
      continuity.excerpts.push(...recallPassages(continuity.chapters, continuity.scene, continuity.body, {
        query: user?.text || '', people: (story.cards || []).flatMap(splitNames), recentN,
        changedScene: true,
      }).filter(hit => !known.some(text => text.includes(hit.quote))));
    }
    if (selection?.verify) takeFacts(null,true);
    takeFacts(true);
    const sceneIds = new Set(continuity.scene.map((c) => c.id));
    const outside = continuity.excerpts.filter(({ chapter }) => !sceneIds.has(chapter.id) && !selected.has(chapter.id));
    const quoteReserve = Math.min(1600, Math.floor(Math.max(0, remaining) / 3),
      outside.reduce((sum, { quote, detail }) => sum + quote.length + (detail?.length || 0) + 46, 0));
    // 额外原文以整章的玩家行动和 GM 回应为单位，不把较早段落混进最新行动。
    function take(chapter, reserve = 0) {
      const rows = [chapter.user && message(chapter.user), message(chapter.node)].filter(Boolean);
      const chars = size(rows);
      if (chars > remaining - reserve) return false;
      remaining -= chars;
      selected.set(chapter.id, rows);
      return true;
    }
    for (const chapter of continuity.scene.slice().reverse()) {
      if (!selected.has(chapter.id) && !take(chapter, quoteReserve)) break;
    }
    const quotes = [];
    const automatic = [];
    const quoteTitle = '【较早互动原文·供接续参考】';
    let quoteRoom = Math.min(lean ? 1600 : 3200, remaining);
    const seen = new Set();
    for (const { chapter, quote, detail, pinned, key: passageKey, reason, rounds, fresh } of continuity.excerpts) {
      if (lean && selection.fastPath && !pinned && !continuity.excerpts.some(hit=>hit.pinned && hit.chapter.id === chapter.id)) continue;
      const key = chapter.id + '\n' + quote;
      if (selected.has(chapter.id) || seen.has(key) || quotes.some((item) =>
        item.chapter === chapter.no && (item.quote.includes(quote) || quote.includes(item.quote)))) continue;
      const text = `〔第${chapter.no}章${pinned ? ' · 玩家保留' : passageKey ? ' · 自动找回' : ''}〕\n${detail ? detail + '\n' : ''}${quote}`;
      const chars = text.length + 2 + (quotes.length ? 0 : quoteTitle.length + 1);
      if (chars > remaining || (!(lean && pinned) && chars > quoteRoom)) continue;
      if (!(lean && pinned)) quoteRoom -= chars;
      remaining -= chars;
      quotes.push({ chapter: chapter.no, text, quote }); seen.add(key);
      if (passageKey) automatic.push({ nodeId: chapter.id, chapter: chapter.no, key: passageKey, quote, reason, rounds, fresh });
    }
    const pendingTitle = '【其他尚未整理的较早剧情原文】';
    const pendingBlocks = [];
    let pendingRoom = lean ? 3000 : Infinity;
    for (const chapter of continuity.pendingRanked) {
      if (selected.has(chapter.id) || quotes.some((quote) => quote.chapter === chapter.no)) continue;
      if (lean) {
        const topics = [...selection.terms.filter(t=>!(story.cards||[]).some(c=>splitNames(c).includes(t))), ...selection.topicTerms];
        if (selection.fastPath || !topics.some(t=>continuity.body(chapter).includes(t) && !recentBodies.some(body=>body.includes(t)))) continue;
      }
      const text = [`〔第${chapter.no}章〕`, chapter.user ? '玩家：' + userContent(chapter.user) : '', message(chapter.node).content].filter(Boolean).join('\n');
      const chars = text.length + 2 + (pendingBlocks.length ? 0 : pendingTitle.length + 1);
      if (chars > remaining || chars > pendingRoom || (lean && pendingBlocks.length >= 3)) continue;
      pendingRoom -= chars;
      remaining -= chars;
      pendingBlocks.push({ no: chapter.no, text });
      selected.set(chapter.id, null);
    }
    const earlier = continuity.chapters.flatMap((c) => selected.get(c.id) || []);
    messages = [...earlier, ...messages];
    if (quotes.length) add('较早互动原文', quoteTitle + '\n' + quotes.sort((a, b) => a.chapter - b.chapter).map((x) => x.text).join('\n\n'), 'continuity');
    if (pendingBlocks.length) add('尚未整理的较早剧情', pendingTitle + '\n' + pendingBlocks.sort((a, b) => a.no - b.no).map((block) => block.text).join('\n\n'), 'continuity');
    takeFacts(false);
    if (recalled.length) add('历史记忆检索', recallTitle + '\n' + recalled.map((x) => x.line).join('\n'), 'memory');
    if (layered) layered.hits = recalled.map(({ r }) => ({ id: r.id, from: r.sourceFrom, to: r.sourceTo }));
    system = parts.map((p) => p.text).join('\n\n');
    const keptChapters = continuity.chapters.filter((c) => selected.has(c.id)).map((c) => c.no);
    const omitted = continuity.pending.filter((c) => !selected.has(c.id)).map((c) => c.no);
    const sceneOmitted = continuity.scene.filter((c) => !selected.has(c.id)).map((c) => c.no);
    if (lean) {
      for (const [source, rows] of [['核心',layered?.records.core],['状态',layered?.records.state],['检索',recalled.map(x=>x.r)]]) {
        for (const r of rows || []) materials.push({source,id:r.id,chapter:r.sourceTo,from:r.sourceFrom,chars:r.event.length,
          reason:source==='检索' ? selection.candidates.find(x=>x.r===r)?.matches.join('、') : r.type});
      }
      for (const q of quotes) materials.push({source:'原文摘句',chapter:q.chapter,chars:q.quote.length,
        reason:automatic.find(hit=>hit.chapter===q.chapter)?.reason || '玩家保留'});
      for (const c of continuity.chapters.filter(c=>selected.has(c.id))) materials.push({source:'整章原文',
        chapter:c.no,chars:continuity.body(c).length,reason:c.index>=recentStart?'最近对话':'未整理相关章节'});
      for (const line of continuity.activeLines) materials.push({source:'状态',id:line.id,chars:line.detail.length,reason:'近期未完互动'});
    }
    continuityInfo = { kept: keptChapters, excerpts: [...new Set(quotes.map((x) => x.chapter))], omitted, sceneOmitted, automatic };
  }
  if (!continuity && fixedSize() > budgetChars) {
    const protectedIndex = Math.max(0,recentStart - path.indexOf(recentPath[0]));
    const removable = recentPath.slice(0,protectedIndex).filter(n=>kept.includes(n) && (n.role==='user' || message(n, rawSet.has(n.id)).content)).length;
    while (trimmed < removable && fixedSize() > budgetChars) {
      messages.shift();
      trimmed++;
    }
  }
  if (messages[0]?.role === 'assistant') messages.unshift(lead);
  messages.push(...continuationMessages);
  const historyChars = size(messages);
  return {
    system,
    cachePrefix,
    messages,
    info: {
      materials, memoryPlan: lean ? 'lean' : 'legacy', fastPath: selection?.fastPath || false,
      systemChars: system.length, historyChars, totalChars: system.length + historyChars, budgetChars, trimmed, count: messages.length,
      parts: parts.filter((p) => p.text).map((p) => ({ label: p.label, chars: p.text.length, text: p.text, kind: p.kind })),
      tail, cards: sentCards.map((c) => c.name), present: present.map((c) => c.name), modules: sentModules.map((m) => m.name),
      memoryUpTo: cp ? cp.mem.upTo : 0,
      memoryMode: compact ? 'layered' : 'full', retrievalHits: layered?.hits || [], coreIncluded: layered?.records.core.length || 0, coreRecalled: layered?.records.recalled.filter(r => coreFact(r) && layered.hits.some(h => h.id === r.id)).length || 0, coreOmitted: layered?.omittedCore.length || 0, omittedCore: (layered?.omittedCore || []).map(r => ({ from:r.sourceFrom, to:r.sourceTo, preview:[...r.event].slice(0,30).join(''), recalled:layered.hits.some(h => h.id === r.id) })), continuity: continuityInfo,
    },
  };
}
