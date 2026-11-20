// 墨游 · 番外：模板、通用要求、每篇番外发给模型的内容
// 番外不进正史：不写回剧情，也不会作为前情发给正文。

import { db } from './db.js';
import { uid } from './util.js';
import { forContext, parseReply } from './parse.js';
import { cardText, splitNames, protagonistText } from './prompt.js';
import { recallPassages } from './recall.js';
import { evidenceRecords } from './extra-evidence.js';
import { layeredMemory, recordsAt } from './structured-memory.js';
import { EMPHASIS_GUIDE } from './inline.js';
import { stripReasoning, FINAL_OUTPUT_GUIDE } from './reasoning.js';
import { castNames, castText } from './extra-options.js';
import { PLAYBOOKS, PLAYBOOK_COMMON, LAYOUT_GUIDE, layoutOf, PLAYBOOK_UPDATES, PLAYBOOK_RELATIONS, PLAYBOOK_EDITORIAL, NICKNAME_GUIDE, extraEditorial, refreshPlaybookText, playbookOf } from './extra-playbooks.js';

export const SCOPES = {
  follow: '跟随形式',
  all: '全知：正史里发生过的都能写',
  public: '只知道公开的事：旁人能看到、听说的',
  char: '只知道视角角色知道的事',
};

export const LENGTHS = { short: ['短', 1000], mid: ['中', 2500], long: ['长', 5000], xlong: ['超长', 8000] };
/** 篇幅：可以是上面的档位，也可以是自己填的字数 */
export function lengthOf(length) {
  const n = Number(length);
  if (Number.isFinite(n) && n >= 200) { const c = Math.min(Math.round(n), 20000); return [c >= 6500 ? '超长' : c >= 3500 ? '长' : c >= 1800 ? '中' : '短', c]; }
  return LENGTHS[length] || LENGTHS.mid;
}

export const DEFAULT_BASE = `- 第一行写番外标题（# 开头），然后是正文。
- 这是非正史番外：不改变正史的事实、人物认知和关系进度；论坛猜测、网友同人、假设剧情都不算正史。
- 人物保持正史人设；配角各有自己的性格和立场，不要所有人都变成同一种嗑CP的群众。
- 重点是把人物写鲜活：有趣的假设、生活细节、旁观者视角、无关紧要的小事件。梗要充分展开，不硬写升华结尾。
- 可以原创正文没写过的小事，但不擅自新增重大秘密、新的感情史、或会影响正史判断的大事件。`;

const BUILTIN = [
  ['小说体', 'all', '用小说正文的写法写一个完整的小场景：有开头、发展和收尾。传统中文自然段，对白、动作、心理融合在段落里。'],
  ['论坛体', 'public', '写成真实网络论坛的帖子：楼主开帖，后面十几到二十几层回复，用“楼主”“1楼”“回复#3”这类标记。不同楼层的人立场和掌握的信息都不同：有人分析得准，有人一本正经胡说八道，有人歪楼、抬杠、玩梗、潜水打卡。不要求最后得出正确答案。'],
  ['日记体', 'char', '用视角角色的第一人称写日记，可以按日期分段。写他嘴上不会说出口的真实想法；表面说的和心里想的可以有落差，但要符合他的人设。'],
  ['采访体', 'char', '视角角色接受一场采访：一问一答，问题写“问：”，回答写“答：”。他按自己的性格回答，可以绕弯子、答非所问、避而不答，不要求每题都有工整答案。'],
  ['剧本体', 'all', '写成广播剧剧本：“角色名：台词”，动作神态放在括号里，可以加【音效：……】，场景转换写“第二幕·地点”。台词有来有回，不用“嗯”“哦”凑行数。'],
  ['群聊记录', 'all', '模拟聊天软件的群聊或私聊记录：“昵称：内容”一条一行，可以有时间、撤回提示、【表情包：……】、【语音 0:12，转文字：……】、已读不回。每个人说话方式不同；群里每个人只知道自己知道的事。'],
  ['角色图鉴', 'all', '写成游戏角色图鉴：基本信息、性格关键词、外貌关键词、和主角现在的关系、口头禅、一两条日常小事。条目化，可以玩梗，但不能和正史人设冲突。'],
  ['吐槽局', 'public', '几个已登场的配角凑在一起吃饭喝酒，聊主角和这段关系的八卦。以对话为主，互相接梗拆台，有人说漏嘴、有人护短、有人看热闹不嫌事大，可以跑题。'],
];

export function builtinTemplates() {
  return [...BUILTIN.map(([name, scope, text], i) => ({ id: 'builtin-' + i, name, scope, text, note: '', layout: layoutOf({name}) })), ...PLAYBOOKS.map(p => ({...p, text:p.text+'\n'+(PLAYBOOK_UPDATES[p.layout] || '')+'\n'+(PLAYBOOK_RELATIONS[p.layout] || '')+'\n'+(PLAYBOOK_EDITORIAL[p.layout] || ''), playbookRevision:5, note:''}))];
}

export async function getTemplates() {
  const v = await db.kvGet('fwTemplates', null);
  if (!Array.isArray(v)) return builtinTemplates();
  let changed = false;
  if (!(await db.kvGet('fwPlaybooksV1', false))) {
    for (const p of PLAYBOOKS) if (!v.some(t => t.id === p.id || t.name === p.name)) {v.push({...p, note:''});changed=true;}
  }
  for (const t of v) {
    const p=playbookOf(t), update=p && PLAYBOOK_UPDATES[p.layout];
    if(p && t.playbookRevision !== 5) {
      // 保留用户改过的正文，只补充新版要求；后续再编辑不会被重复追加。
      t.text=refreshPlaybookText(t.text);
      if(update && !t.text.includes(update)) t.text+='\n'+update;
      const relation=PLAYBOOK_RELATIONS[p.layout];
      if(relation && !t.text.includes(relation))t.text+='\n'+relation;
      const editorial=PLAYBOOK_EDITORIAL[p.layout];
      if(editorial && !t.text.includes(editorial))t.text+='\n'+editorial;
      t.playbookRevision=5;changed=true;
    }
  }
  if(changed) await saveTemplates(v);
  return v;
}
export async function saveTemplates(list) { await db.kvSet('fwTemplates', list); return db.kvSet('fwPlaybooksV1', true); }
export async function getBase() {
  const v = await db.kvGet('fwBase', null);
  return v == null ? DEFAULT_BASE : v;
}
export async function saveBase(text) { return db.kvSet('fwBase', text); }

export function newTemplate() { return { id: uid(), name: '', scope: 'all', text: '', note: '' }; }

/**
 * 正史章节：沿当前这条线，每一章 = 一条有正文的回复 + 它前面那句玩家输入
 * 返回 [{ no, id, title, said, text }]
 */
export function chaptersOf(path) {
  const out = [];
  let lastUser = null;
  for (const n of path) {
    if (n.role === 'user') { if (n.kind !== 'ooc') lastUser = n; continue; }
    if (n.kind === 'ooc' || !n.text?.trim()) continue;
    const said = !lastUser ? '' : lastUser.kind === 'start' ? (lastUser.text?.trim() ? '开场：' + lastUser.text.trim() : '') : lastUser.kind === 'continue' ? '（继续）' : lastUser.text || '';
    out.push({ no: out.length + 1, id: n.id, title: parseReply(n.text).title, said, text: forContext(n.text) });
  }
  return out;
}

/**
 * 拼一篇番外要发的内容。
 * opts: { chapters, anchorNo, recentN, pinned:[no], template, request, scope, pov, length, modules(已筛好要带的), base }
 */
export function buildExtraContext(story, opts) {
  const { chapters, anchorNo, recentN = 6, pinned = [], template, request = '', pov = '', length = 'mid', modules = [], base = DEFAULT_BASE } = opts;
  const scope = opts.scope && opts.scope !== 'follow' ? opts.scope : (template?.scope || 'all');
  const upto = chapters.filter((c) => c.no <= anchorNo);
  const recent = recentN > 0 ? upto.slice(-recentN) : [];
  const pinnedSet = new Set(pinned.filter((no) => no <= anchorNo));
  const layout = layoutOf(template);
  const rawAllowed = scope === 'all';
  const snapshotChapters = layout && rawAllowed ? upto.slice(-3) : [];
  // 知情范围不明的原文可能含有另一人的私密场景，严格视角下只使用带知情者的记忆。
  const nodeById = new Map((opts.path || []).map(n => [n.id, n]));
  const older = upto.filter(c => !recent.includes(c) && !pinnedSet.has(c.no) && !snapshotChapters.includes(c));
  const passages = rawAllowed && older.length ? recallPassages(
    older.map(c => ({ ...c, node: nodeById.get(c.id) || c })), [], c => c.text,
    { query: request, context: upto.at(-1)?.title || '', people: castNames(opts.cast), changedScene: true, recentN: 0 }
  ) : [];
  const picked = rawAllowed ? upto.filter((c) => pinnedSet.has(c.no) || recent.includes(c) || snapshotChapters.includes(c)) : [];
  const materialOf = (c) => `【第${c.no}章${c.title ? ' · ' + c.title : ''}】\n${c.said ? '（主角：' + c.said.trim() + '）\n' : ''}${c.text}`;
  const recentMaterial = picked.filter((c) => !pinnedSet.has(c.no)).map(materialOf).join('\n\n');
  const pinnedMaterial = picked.filter((c) => pinnedSet.has(c.no)).map(materialOf).join('\n\n');
  const material = [recentMaterial, pinnedMaterial].filter(Boolean).join('\n\n');
  const observer = layout === 'report' ? opts.cast?.reporter : layout === 'chat' ? opts.cast?.owner : null;
  const readers = [pov || observer?.name || (!layout ? opts.cast?.owner?.name : '')];
  if (scope === 'char' && layout === 'show') readers.push(story.protagonist?.name, ...(opts.cast?.companions || []).map(c => c.name));
  if (scope === 'char' && !readers.some(Boolean) && layout !== 'fic') readers.push(story.protagonist?.name);
  const history = recordsAt(opts.historyPath || opts.path || [], anchorNo);
  const visible = r => scope === 'all' || r.knowers?.includes('公开') ||
    (scope === 'char' && readers.some(name => name && r.knowers?.includes(name)));
  let eligible = history.filter(visible);
  if (!rawAllowed) {
    const sources = [
      ...history.filter(r => !r.knowers?.length).map(r => ({ id:r.id, from:r.sourceFrom, to:r.sourceTo, text:r.event })),
      ...upto.map(c => ({ id:c.id, from:c.no, to:c.no, text:c.text, chapter:true, pinned:pinnedSet.has(c.no) })),
    ];
    const known = new Set(eligible.map(r => r.event));
    for (const r of evidenceRecords(sources, [...readers, story.protagonist?.name, ...(story.cards || []).filter(c => !c.auto?.from || c.auto.from <= anchorNo).map(c => c.name)], opts.evidenceCache).filter(visible)) {
      if (!known.has(r.event)) { eligible.push(r); known.add(r.event); }
    }
    eligible = eligible.map(r => ({ ...r, event: (r.knowers.includes('公开') ? '【公开可见】' :
      '【仅' + r.knowers.filter(name => readers.includes(name)).join('、') + '可用】') + r.event }));
  }
  const memory = layeredMemory({ upTo: anchorNo, records: eligible }, [request, pov, castNames(opts.cast).join(' '), ...upto.slice(-2).map((c) => c.title)].join(' '),
    { at: anchorNo, coreChars: 1800, stateChars: 700, retrieveChars: 3500 });

  // 角色卡：常驻的、视角角色、素材里被提到的
  const scan = material + '\n' + request + '\n' + pov + '\n' + castNames(opts.cast).join('\n');
  const cards = (story.cards || []).filter((c) => c.name?.trim() && (!c.auto?.from || c.auto.from <= anchorNo) &&
    (['chat','fic'].includes(layout) || [opts.cast?.owner,opts.cast?.partner,opts.cast?.subject].some(p=>p?.kind==='mixed') || c.core || c.name === pov || splitNames(c).some((n) => (n === c.name || n.length >= 2) && scan.includes(n))));
  const pastCp = [...(opts.path || [])].reverse().find((n) => n.checkpoint?.upTo <= anchorNo)?.checkpoint;
  const presentNow = opts.atLiveHead ?? (Array.isArray(opts.historyPath) && opts.historyPath.filter((n) => n.role === 'assistant' && n.kind !== 'ooc').length <= anchorNo);
  const asOfCard = (c) => {
    if (presentNow) return c;
    const saved = pastCp?.cards?.[c.name];
    return { ...c, now: saved?.now || '', arc: saved?.arc || '', relation: saved?.relation || '' };
  };

  const scopeText = scope === 'char' && ['show','chat','fic','report'].includes(layout) && opts.cast?.version >= 3
    ? '按各份材料的手机主人、报告作者、同人作者或在场人物分别限制其知情范围；关系对象不等于叙述者，不能因选了对方而把主角换成对方。私密真相若仅叙述者知道，不能泄漏给网友。'
    : scope === 'public'
    ? '写这篇的人（网友、路人、旁人）只知道公开发生、旁人能看到或听说的事：公开场合的言行、传闻、照片、热搜之类。私下的对话、内心想法、亲密细节一律不知道，只能猜，而且可以猜错。'
    : scope === 'char'
      ? (pov ? `以${pov}的视角写：只能写${pov}亲眼见过、亲耳听过、或通过合理渠道得知的事；${pov}不知道的事，不能写成他知道。` : '以视角角色的视角写：只能写他亲眼见过、亲耳听过、或通过合理渠道得知的事。')
      : '可以写正史里发生过的任何事，但不能和正史矛盾。';
  const [lenLabel, lenChars] = lengthOf(length);

  const parts = [];
  const add = (label, text) => { if (text?.trim()) parts.push({ label, text: text.trim() }); };
  add('开头', '你在为一部文字互动小说写番外。番外是独立于正史的创作，写完不推进主线。');
  add('番外通用要求', '【番外通用要求】\n' + base);
  add('文字排版', EMPHASIS_GUIDE);
  add('网名与备注',NICKNAME_GUIDE);
  if (layout) {
    add('玩法与快照', PLAYBOOK_COMMON);
    add('剧情快照材料', '【自动附带的剧情快照材料】\n'+
      '角色档案使用下方主角与角色卡，关系阶段、最近3件具体事件及未回收细节从下方最近章节提取；没有依据的口头禅、癖好与底线不补成事实。语气依据人设和本次要求选择。\n'+
      (snapshotChapters.length ? snapshotChapters.map(c => `事件来源 第${c.no}章（${c.id}）：${c.title || '未命名'}，主角当轮行动：${c.said || '无'}；具体事件见下方本章原文。`).join('\n')
        : rawAllowed ? '正史还未开始，没有可评分的历史事件。报告应标记资料不足，其他玩法可依据人设原创非正史小事。'
          : '本篇按知情范围只带明确可知的记忆；不要根据未发送的原文推断私密事件。资料不足就说明。'));
    add('材料排版', LAYOUT_GUIDE);
    if (PLAYBOOK_UPDATES[layout] && !template?.text?.includes(PLAYBOOK_UPDATES[layout])) add('当前玩法要求', PLAYBOOK_UPDATES[layout]);
    if (PLAYBOOK_RELATIONS[layout] && !template?.text?.includes(PLAYBOOK_RELATIONS[layout])) add('人物关系与材料整合',PLAYBOOK_RELATIONS[layout]);
    add('本次人物选择',castText(opts.cast,layout));
    if (opts.variant) add('本次子类', '【本次玩法选择】\n' + opts.variant + '\n未指定的维度自行变化；指定子类不限制框架内的自由扩展。');
  }
  add(`形式 · ${template?.name || '自定义'}`, '【这篇的形式与写法】\n' + (template?.text?.trim() || '按下面玩家的要求来写。'));
  add('知情范围', '【知情范围】\n' + scopeText);
  if (!rawAllowed) add('分段知情范围', '公开帖子、评论、路人发言只能引用标注公开可见的事实。标注姓名的事实只供该人亲历、回忆或私聊时使用，其他人不能凭空得知。' +
    (scope === 'char' && readers.filter(Boolean).length ? '本次有知情素材的视角范围：' + readers.filter(Boolean).join('、') + '。' : ''));
  for (const m of modules) add(`规则模块 · ${m.name}`, `【规则模块·${m.name}】\n${m.text.trim()}`);
  add('世界设定', rawAllowed && story.world?.trim() ? '【世界设定】\n' + story.world.trim() : '');
  const p = story.protagonist || {};
  const protagonist = rawAllowed ? story : { protagonist: { name: p.name, gender: p.gender, publicProfile: p.publicProfile } };
  add('主角', protagonistText(protagonist, opts.path || []));
  if (memory.core) add('截至时间点的核心记忆', '【截至时间点已确认的核心记忆】\n' + memory.core);
  if (memory.state) add('当时的状态', '【当时未决事项和物品】\n' + memory.state);
  for (const c of cards) add(`角色卡 · ${c.name}`, cardText(rawAllowed ? asOfCard(c) : { name: c.name, publicProfile: c.publicProfile }));
  if (memory.recalled) add('历史记忆检索', '【从此前全部合格记忆召回】\n' + memory.recalled);
  add('时间点', anchorNo > 0
    ? `【时间点】这篇番外发生在正史第 ${anchorNo} 章之后。第 ${anchorNo} 章之后的正史还没有发生，不要写到。`
    : '【时间点】正史还没开始，按设定写。');
  add(`最近原文 · ${picked.length} 章`, recentMaterial ? '【时间点前最近原文】\n' + recentMaterial : '');
  if (passages.length) add('较早正文片段', passages.map(hit => '【第' + hit.chapter.no + '章】\n' + hit.quote).join('\n\n'));
  add('指定章节原文', pinnedMaterial ? '【手动指定的更早章节】\n' + pinnedMaterial : '');
  if(layout) add('当前叙事修订（优先于旧模板冲突条款）',extraEditorial(layout,opts.cast));
  add('最终输出要求',FINAL_OUTPUT_GUIDE);
  const budget = Number(opts.budgetChars) || 30000;
  let system = parts.map((p) => p.text).join('\n\n');
  const user = `请写这篇番外，篇幅大约 ${lenChars} 字（${lenLabel}篇）${lenChars >= 5000 ? '，要写足，不要提前收尾' : ''}。` + (request.trim() ? `\n这次的要求：${request.trim()}` : '') + (pov && scope !== 'char' ? `\n视角角色：${pov}` : '');
  const excerpts = parts.find(p => p.label === '较早正文片段');
  if (excerpts && system.length + user.length > budget) {
    parts.splice(parts.indexOf(excerpts), 1);
    system = parts.map(p => p.text).join('\n\n');
  }
  const recall = parts.find((p) => p.label === '历史记忆检索');
  if (recall) {
    const available = Math.max(0, budget - (system.length - recall.text.length) - user.length - 150);
    if (recall.text.length > available) {
      const lines = recall.text.split('\n');
      let kept = lines.shift();
      for (const line of lines) {
        if (kept.length + line.length + 1 <= available) kept += '\n' + line;
      }
      recall.text = kept.includes('\n') ? kept : '';
    }
    if (!recall.text) parts.splice(parts.indexOf(recall), 1);
    system = parts.map((p) => p.text).join('\n\n');
  }
  return {
    system,
    messages: [{ role: 'user', content: user }],
    info: { parts: parts.map((p) => ({ label: p.label, chars: p.text.length, text: p.text })), totalChars: system.length + user.length, budgetChars: budget,
      chapters: picked.map((c) => c.no), excerptChapters: parts.includes(excerpts) ? passages.map(h => h.chapter.no) : [], hasCanon: !!(parts.includes(excerpts) || picked.length || memory.core || memory.state || recall?.text), memoryHits: memory.hits.filter((hit,i) => recall?.text.includes(memory.records.recalled[i].event)), coreOmitted: memory.coreOmitted, cards: cards.map((c) => c.name), scope, layout, snapshotChapters: rawAllowed ? snapshotChapters.map(c=>c.no) : [], variant: opts.variant || '', cast:opts.cast || null },
  };
}

/** 番外原文 → 标题 + 段落块（保留单个换行，论坛、群聊这类形式靠换行分楼层） */
export function extraBlocks(text) {
  const raw = stripReasoning(text,{streaming:true}).replace(/\r/g, '').trim();
  let title = '';
  let body = raw;
  const first = raw.split('\n')[0] || '';
  const m = first.match(/^#{1,4}\s*(.+?)\s*#*$/);
  if (m) { title = m[1].replace(/^\*+|\*+$/g, '').trim(); body = raw.slice(first.length).trim(); }
  const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return { title, blocks };
}
