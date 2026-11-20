// 整合层只用于正文请求。档案编辑、历史时间点、番外始终保留原始事实与知情范围。
import { activeRecords } from './structured-memory.js';

export function activeEdition(path) {
  return [...path].reverse().find(node => Object.hasOwn(node, 'memoryEdition'))?.memoryEdition || null;
}

export function consolidationBatches(mem) {
  const rows = activeRecords(mem).filter(r => ['summaries','early','event','repeats'].includes(r.column) && !r.irreversible);
  rows.sort((a,b) => a.sourceFrom - b.sourceFrom || a.sourceTo - b.sourceTo);
  const batches = [];
  let batch = [], size = 0;
  for (const r of rows) {
    const chars = r.event.length + 70;
    if (batch.length && (size + chars > 3600 || batch.length >= 18)) {
      batches.push(batch); batch = []; size = 0;
    }
    batch.push(r); size += chars;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function parseSuggestions(raw, batch) {
  const json = JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, ''));
  if (!Array.isArray(json.groups)) throw Error('整合结果格式不完整，可继续当前批次');
  const groups = [], used = new Set();
  for (const g of json.groups) {
    if (!Array.isArray(g.rows) || !g.rows.length || !g.rows.every(i => Number.isInteger(i) && batch[i])) throw Error('来源编号无效，可继续当前批次');
    const ids = [...new Set(g.rows)];
    if (ids.some(i => used.has(i))) throw Error('同一来源被重复合并，可继续当前批次');
    if (!g.text?.trim() || !['日常','转折'].includes(g.kind)) throw Error('整合建议缺少正文或分类');
    const sourceLength = ids.reduce((sum, i) => sum + batch[i].event.length, 0);
    if (g.text.trim().length >= sourceLength) continue;
    ids.forEach(i => used.add(i));
    groups.push({ kind:g.kind, text:g.text.trim(), sources:ids.map(i => ({id:batch[i].id, text:batch[i].event})) });
  }
  return { groups, doubts:(Array.isArray(json.doubts) ? json.doubts : []).filter(s => typeof s === 'string' && s.trim()) };
}

export function editionMemory(mem, edition) {
  if (!edition?.groups?.length || !Array.isArray(mem.records)) return mem;
  const current = new Map(activeRecords(mem).map(r => [r.id,r]));
  const remove = new Set(), additions = [];
  for (const g of edition.groups) {
    if (!g.sources.every(s => current.get(s.id)?.event === s.text && !remove.has(s.id))) continue;
    const rows = g.sources.map(s => current.get(s.id));
    rows.forEach(r => remove.add(r.id));
    additions.push({ ...rows[0], id:'edition-' + rows[0].id, column:'summaries', type:'event', event:g.text,
      sourceFrom:Math.min(...rows.map(r=>r.sourceFrom)), sourceTo:Math.max(...rows.map(r=>r.sourceTo)),
      importance:g.kind === '转折' ? 8 : 3, tags:[...new Set(rows.flatMap(r=>r.tags || []))],
      people:[...new Set(rows.flatMap(r=>r.people || []))], items:[...new Set(rows.flatMap(r=>r.items || []))] });
  }
  if (!additions.length) return mem;
  const records = [...mem.records.filter(r => !remove.has(r.id)), ...additions].map(r =>
    r.column === 'summaries' ? {...r, order:r.sourceFrom} : r);
  return {...mem, records};
}

export const editorGuide = '你是小说档案编辑。下面是编号从0开始的既有记忆。合并重复日常，保存动机、后果、关键原话、知情与关系转折及各自发生章节。不同状态标明先后。无法核实的条目直接略过。只返回确实能缩短的合并或压缩，避免逐条复述。遗漏的编号会原样保留。只输出 JSON {"groups":[{"rows":[0,1],"kind":"日常或转折","text":"整合文本"}],"doubts":["待核对的问题"]}。没有值得压缩的内容就返回空组。只采用提供的材料。';
