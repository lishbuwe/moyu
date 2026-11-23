// 每份章节档案仍挂在原节点；records 保留各条的来源、版本与失效历史。
// legacy 是迁移前的原文副本，供核对和备份，任何编辑都不覆盖它。
const LISTS = ['irreversible', 'corrections', 'items', 'threads', 'knowledge', 'offscreen', 'repeats'];
const types = { irreversible: 'fact', corrections: 'correction', items: 'item', threads: 'thread', knowledge: 'knowledge', offscreen: 'plan', repeats: 'style', summaries: 'event', early: 'event' };
const importance = { irreversible: 10, corrections: 10, knowledge: 9, threads: 8, items: 7, summaries: 5, early: 4, offscreen: 5, repeats: 3 };
const clean = (s) => String(s ?? '').trim();
const id = () => 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const deep = (v) => structuredClone(v);

function fields(mem) {
  return { early: mem.early || '', earlyUpTo: mem.earlyUpTo || 0,
    summaries: deep(mem.summaries || []), ...Object.fromEntries(LISTS.map((k) => [k, deep(mem[k] || [])])), cards: deep(mem.cards || {}) };
}

function atom(column, text, from, to, branchId, meta = {}) {
  return { id: id(), event: clean(text), sourceFrom: Number(from) || 1, sourceTo: Number(to) || Number(from) || 1,
    sourceChapter: Number(from) === Number(to) ? Number(from) : null,
    branchId: branchId || '', people: [], location: '', items: [], type: types[column] || 'fact',
    importance: importance[column] || 5, irreversible: column === 'irreversible', knowers: [], tags: [],
    invalidatedAt: null, invalidatedBy: null, column, order: 0, ...meta };
}

/** 幂等迁移：保留旧栏目、每个章段的原始范围和一份不可变的旧档案副本。 */
export function ensureStructured(mem, branchId = '') {
  if (!mem || (mem.schema >= 1 && Array.isArray(mem.records))) return false;
  mem.legacy = deep(fields(mem));
  const records = [];
  if (clean(mem.early)) records.push(atom('early', mem.early, 1, mem.earlyUpTo || mem.upTo, branchId));
  for (const [order, s] of (mem.summaries || []).entries()) if (clean(s.text)) records.push(atom('summaries', s.text, s.from, s.to, branchId, { order }));
  for (const column of LISTS) for (const [order, text] of (mem[column] || []).entries()) if (clean(text)) records.push(atom(column, text, 1, mem.upTo, branchId, { order }));
  mem.records = records;
  mem.schema = 1;
  return true;
}

export function activeRecords(mem, at = mem?.upTo || 0) {
  return (mem?.records || []).filter((r) => r.sourceTo <= at && (r.invalidatedAt == null || r.invalidatedAt > at));
}

/** 保留旧栏目供界面使用，但其文本由当前有效记录重新投影。 */
export function projectColumns(mem) {
  if (!Array.isArray(mem?.records)) return fields(mem || {});
  const out = { early: '', earlyUpTo: mem.earlyUpTo || 0, summaries: [], ...Object.fromEntries(LISTS.map((k) => [k, []])) };
  for (const r of activeRecords(mem).sort((a, b) => (a.order || 0) - (b.order || 0))) {
    if (r.dormant) continue;
    if (r.column === 'early') { out.early = r.event; out.earlyUpTo = r.sourceTo; }
    else if (r.column === 'summaries') out.summaries.push({ from: r.sourceFrom, to: r.sourceTo, text: r.event });
    else if (LISTS.includes(r.column)) out[r.column].push(r.event);
  }
  return out;
}

/** 整理或手改后，对比每一栏：失效旧版本，写入新版本，未改动的 ID 和来源不变。 */
export function syncStructured(mem, next, { from = mem.upTo, to = mem.upTo, branchId = '', metadata = [] } = {}) {
  ensureStructured(mem, branchId);
  const desired = [];
  if (clean(next.early)) desired.push({ column: 'early', text: clean(next.early), from: 1, to: next.earlyUpTo || to });
  for (const s of next.summaries || []) if (clean(s.text)) desired.push({ column: 'summaries', text: clean(s.text), from: s.from, to: s.to });
  for (const column of LISTS) for (const text of next[column] || []) if (clean(text)) desired.push({ column, text: clean(text), from, to });
  const current = activeRecords(mem).filter(r=>!r.dormant);
  const key = (x) => x.column + '\u0000' + x.event + (['early', 'summaries'].includes(x.column) ? `\u0000${x.sourceFrom}-${x.sourceTo}` : '');
  const wanted = new Map();
  for (const d of desired) {
    const k = d.column + '\u0000' + d.text + (['early', 'summaries'].includes(d.column) ? `\u0000${d.from}-${d.to}` : '');
    wanted.set(k, (wanted.get(k) || 0) + 1);
  }
  const kept = new Map();
  for (const r of current) {
    const k = key(r), n = wanted.get(k) || 0;
    if ((kept.get(k) || 0) < n) kept.set(k, (kept.get(k) || 0) + 1);
    else { r.invalidatedAt = to; r.invalidatedBy = 'revision'; }
  }
  const used = new Map();
  const orders = new Map();
  const assigned = new Set();
  for (const d of desired) {
    const k = d.column + '\u0000' + d.text + (['early', 'summaries'].includes(d.column) ? `\u0000${d.from}-${d.to}` : '');
    const n = used.get(k) || 0; used.set(k, n + 1);
    const order = orders.get(d.column) || 0; orders.set(d.column, order + 1);
    if (n < (kept.get(k) || 0)) {
      const old = current.find((r) => key(r) === k && r.invalidatedAt == null && !assigned.has(r.id));
      if (old) { old.order = order; assigned.add(old.id); }
      continue;
    }
    const hint = metadata.find((x) => clean(x.event || x.text) === d.text) || {};
    mem.records.push(atom(d.column, d.text, d.from, d.to, branchId, {
      brief: typeof hint.brief === 'string' && hint.brief.length <= 40 ? hint.brief.trim() : '', people: Array.isArray(hint.people) ? hint.people.map(clean) : [], location: clean(hint.location),
      items: Array.isArray(hint.items) ? hint.items.map(clean) : [], type: clean(hint.type) || types[d.column],
      importance: Math.max(1, Math.min(10, Number(hint.importance) || importance[d.column] || 5)),
      irreversible: d.column === 'irreversible' || hint.irreversible === true,
      knowers: Array.isArray(hint.knowers) ? hint.knowers.map(clean) : [],
      tags: Array.isArray(hint.tags) ? hint.tags.map(clean) : [], order,
    }));
  }
  Object.assign(mem, fields({ ...mem, ...next }));
  return mem;
}

/** 新模型额外提取的单条事件，保存来源与覆盖关系，不改变旧栏目显示。 */
export function addEvents(mem, events, from, to, branchId) {
  ensureStructured(mem, branchId);
  for (const x of Array.isArray(events) ? events : []) {
    if (!clean(x?.event)) continue;
    const chapter = Number(x.sourceChapter);
    const at = Number.isInteger(chapter) && chapter >= from && chapter <= to ? chapter : null;
    for (const r of mem.records) if (r.column === 'event' && !r.irreversible && Array.isArray(x.replaces) && x.replaces.includes(r.id) && r.invalidatedAt == null) { r.invalidatedAt = at || to; r.invalidatedBy = 'replacement'; }
    mem.records.push(atom('event', x.event, at || from, at || to, branchId, {
      brief: typeof x.brief === 'string' && x.brief.length <= 40 ? x.brief.trim() : '', people: Array.isArray(x.people) ? x.people.map(clean) : [], location: clean(x.location),
      items: Array.isArray(x.items) ? x.items.map(clean) : [], type: clean(x.type) || 'event',
      importance: Math.max(1, Math.min(10, Number(x.importance) || 5)), irreversible: x.irreversible === true,
      knowers: Array.isArray(x.knowers) ? x.knowers.map(clean) : [], tags: Array.isArray(x.tags) ? x.tags.map(clean) : [],
    }));
  }
}

/** IndexedDB 结构无需升级：首次打开故事时原位迁移，旧字段和原文继续留存。 */
export async function migrateCheckpoints(nodes, db) {
  const all = nodes instanceof Map ? [...nodes.values()] : nodes;
  let migrated = 0, failed = 0;
  for (const n of all) if (n.checkpoint && !Array.isArray(n.checkpoint.records)) {
    const before = deep(n.checkpoint);
    ensureStructured(n.checkpoint, n.id);
    try { await db.put('nodes', n); migrated++; }
    catch { n.checkpoint = before; failed++; }
  }
  return { migrated, failed };
}

const alias = { 本子: ['本', '笔记本', '速写本', '日记本', '手账'], 停电: ['断电', '没电', '电闸'], 戒指: ['指环'], 信: ['信件', '书信'] };
const words = (s) => [...new Set((clean(s).toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z0-9]{2,}/gu) || []).flatMap((w) => {
  const bits = [w];
  if (w.length > 3 && /[\p{Script=Han}]/u.test(w)) for (let i = 0; i < w.length - 1; i++) bits.push(w.slice(i, i + 2));
  for (const [name, variants] of Object.entries(alias)) if (w.includes(name)) bits.push(name, ...variants);
  return bits;
}))];

const factKey = text => clean(text).normalize('NFKC').replace(/\s+/gu, '').replace(/[。.!！]+$/u, '');

export function retrieveRecords(records, query, { at = Infinity, scope = 'all', pov = '', limitChars = 4000, omit = [], requireMatch = false } = {}) {
  const terms = words(query);
  const excluded = new Set(omit.map((x) => x.id));
  const eligible = records.filter((r) => r.sourceTo <= at && (r.invalidatedAt == null || r.invalidatedAt > at) && !excluded.has(r.id) && (
    scope === 'all' || (scope === 'public' ? r.knowers?.includes('公开') : r.knowers?.includes(pov) || r.knowers?.includes('公开'))));
  const score = (r) => {
    const labels = [r.event, ...(r.people || []), r.location, ...(r.items || []), ...(r.tags || [])].join(' ').toLowerCase();
    const hits = terms.reduce((sum, term) => sum + (labels.includes(term) ? (term.length >= 3 ? 5 : 3) : 0), 0);
    if (requireMatch && !hits) return -1;
    return hits * 10 + (Number(r.importance) || 5) * 2 + Math.min(5, (r.sourceTo || 0) / Math.max(1, at === Infinity ? r.sourceTo || 1 : at) * 5);
  };
  const ranked = eligible.map(r => ({r, score: score(r)})).filter(x => x.score >= 0)
    .sort((a, b) => b.score - a.score || b.r.sourceTo - a.r.sourceTo);
  const seen = new Set(omit.map(r => factKey(r.event)));
  const result = []; let used = 0;
  for (const {r} of ranked) {
    const key = factKey(r.event);
    if (seen.has(key)) continue;
    const size = r.event.length + 14;
    if (used + size > limitChars) continue;
    seen.add(key); result.push(r); used += size;
  }
  return result;
}

export const coreFact = r => r.irreversible || ['correction', 'knowledge'].includes(r.type);

export function layeredMemory(mem, query, { at = mem?.upTo || 0, coreChars = 2300, stateChars = 900, retrieveChars = 4000, scope = 'all', pov = '', requireMatch = false, prioritizeCore = false } = {}) {
  const all = activeRecords(mem, at);
  const seen = new Set();
  const fit = (list, cap) => {
    const out = [];
    let size = 0;
    for (const r of list) {
      const key = factKey(r.event);
      if (seen.has(key) || size + r.event.length + 18 > cap) continue;
      seen.add(key);
      out.push(r);
      size += r.event.length + 18;
    }
    return out;
  };
  const coreWanted = all.filter(coreFact)
    .sort((a, b) => (b.importance || 0) - (a.importance || 0) || b.sourceTo - a.sourceTo);
  const core = fit(coreWanted, coreChars);
  const state = fit(all.filter((r) => ['thread', 'item'].includes(r.type))
    .sort((a, b) => b.sourceTo - a.sourceTo), stateChars);
  const options = { at, scope, pov, limitChars: retrieveChars, requireMatch, omit: [...core, ...state] };
  const priority = prioritizeCore ? retrieveRecords(coreWanted, query, options) : [];
  const recalled = [...priority, ...retrieveRecords(all, query, { ...options, omit: [...options.omit, ...priority],
    limitChars: retrieveChars - priority.reduce((n,r) => n + r.event.length + 14, 0) })];
  const line = (r) => `- [第${r.sourceFrom}${r.sourceTo === r.sourceFrom ? '' : '–' + r.sourceTo}章] ${r.event}`;
  return { core: core.map(line).join('\n'), state: state.map(line).join('\n'), recalled: recalled.map(line).join('\n'),
    hits: recalled.map((r) => ({ id: r.id, from: r.sourceFrom, to: r.sourceTo })),
    coreOmitted: new Set(coreWanted.map(r => factKey(r.event))).size - core.length, records: { core, state, recalled } };
}

/** 按分支节点的历史版本合并，允许从未来那份档案里找回确知发生在时间点之前的事件。 */
export function recordsAt(path, at) {
  const checkpoints = path.map((n) => n.checkpoint).filter((cp) => Array.isArray(cp?.records));
  const snapshot = [...checkpoints].reverse().find((cp) => cp.upTo <= at);
  // 旧档案是整份快照。只取时间点最近的一份，避免把已删除的旧栏目从更早快照带回来。
  // 若还没有时间点内的档案，取第一份未来档案中来源范围确定的早期记录。
  const base = snapshot || checkpoints.find((cp) => cp.upTo > at);
  if (!base) return [];
  const selected = new Map((base.records || []).filter((r) => r.sourceTo <= at).map((r) => [r.id, r]));
  for (const cp of checkpoints) if (cp.upTo > at) for (const r of cp.records) {
    // 后整理的事件只有确切来源章节才能回填；跨越时间点的旧摘要不能猜测。
    if (r.sourceChapter != null && r.sourceChapter <= at) selected.set(r.id, r);
  }
  return [...selected.values()].filter((r) => r.invalidatedAt == null || r.invalidatedAt > at);
}
