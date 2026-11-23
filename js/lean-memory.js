// 只在故事选择精简方案时调用。角色卡和历史存档保持原样。
import { activeRecords } from './structured-memory.js';
const past = /以前|之前|上次|上回|那次|当初|曾经|还记得|记不记得|早先|先前/;
const question = /[?？吗呢]|什么|哪|怎么|多少/;
const pointer = /这个|那个|那张|那件|这张|这件|它|翻过来/;
const edge = /^[了着过的地得]|[了着过的地得]$/;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh',{granularity:'word'}) : null;

function lexicalTerms(text) {
  const groups = text.replace(new RegExp(past.source+'|'+pointer.source+'|'+question.source,'g'),' ').match(/[\p{L}\d]+/gu) || [];
  const terms = new Set();
  for (const group of groups) {
    const words = segmenter ? [...segmenter.segment(group)].map(s=>s.segment) : [group];
    for (let i=0;i<words.length;i++) for (const term of [words[i],words.slice(i,i+2).join(''),group]) {
      if (term.length >= 2 && !edge.test(term)) terms.add(term);
    }
  }
  return [...terms];
}

export function covered(text, sources, records = []) {
  const clean = s => s.normalize('NFKC').replace(/[\s\p{P}]/gu,'');
  const key = clean(text);
  if (!key) return true;
  return sources.some(raw => {
    const source = clean(raw);
    if (source.includes(key)) return true;
    if (key.length < 3) return false;
    let hits = 0, total = 0;
    for (let i=0;i<=key.length-3;i++) {
      const part = key.slice(i,i+3);
      if (records.length >= 4 && records.filter(r=>r.event.includes(part)).length > records.length*0.3) continue;
      total++; if (source.includes(part)) hits++;
    }
    return total >= 3 && hits === total;
  });
}

function fit(rows, cap) {
  const result = [];
  const included = new Set();
  for (const row of rows) {
    const text = row.brief?.trim() && row.brief.trim().length <= 40 ? row.brief.trim() : row.event;
    // A shared brief does not prove that two original facts are equivalent.
    const key = row.event.normalize('NFKC').trim();
    if (included.has(key)) continue;
    const entry = {...row, event:text};
    const cost = render([entry]).length + (result.length ? 1 : 0);
    if (cost > cap) continue;
    included.add(key);
    result.push(entry);
    cap -= cost;
  }
  return {rows:result, omitted:rows.filter(r=>!included.has(r.event.normalize('NFKC').trim())).length};
}
const render = rows => rows.map(r=>'- [第'+r.sourceFrom+'–'+r.sourceTo+'章] '+r.event).join('\n');

export function leanMemory(mem, query, director, lastBody, aliases, present, coreBudget = 1800) {
  const all = activeRecords(mem).filter(r=>typeof r.event === 'string' && r.event.trim());
  const vocab = new Set(aliases);
  const items = new Set();
  for (const r of all) {
    for (const t of [...(r.people||[]),...(r.items||[]),...(r.tags||[]),r.location]) if (typeof t==='string' && t.length>=2 && !edge.test(t)) vocab.add(t);
    for (const t of r.items||[]) items.add(t);
  }
  let terms = [...vocab].filter(t=>t && query.includes(t));
  if (!terms.length && !past.test(query) && pointer.test(query)) {
    const tail=lastBody.slice(-260);
    terms=[...vocab].filter(t=>t && tail.includes(t)).sort((a,b)=>(tail.lastIndexOf(b)+b.length)-(tail.lastIndexOf(a)+a.length)||b.length-a.length).slice(0,1);
  }
  const intent=past.test(query) || (pointer.test(query) && question.test(query));
  const verify=question.test(query) && (intent || terms.some(t=>items.has(t)));
  
  const topicTerms = lexicalTerms(query);
  if (!intent && !director) terms = terms.filter(term => !aliases.includes(term));
  const examines = /翻过来|查看|辨认|读出|念出|打开看看/u.test(query);
  const fastPath = !director && !intent && !verify && !examines;
  if (intent) terms = [...new Set([...terms, ...topicTerms.filter(t=>{
    const n=all.filter(r=>r.event.includes(t)).length;
    return n>0 && n<=Math.max(1,all.length*0.15);
  })])];
  const ranked=[...all].sort((a,b)=>(b.importance||0)-(a.importance||0)||b.sourceTo-a.sourceTo);
  const facts = fit(ranked.filter(r=>r.type !== 'knowledge' && (r.irreversible || r.type === 'correction')),coreBudget);
  const relevantKnowledge = ranked.filter(r=>{
    if (r.type !== 'knowledge') return false;
    const people = [...r.people || [], ...r.knowers || []].filter(Boolean);
    return !people.length || people.some(n=>present.includes(n));
  });
  const knowledge = fit(relevantKnowledge,800);
  const core = [...facts.rows,...knowledge.rows];
  // 只有明确描述当前归属的短项可以常驻，带历史或引文的混合记录留待检索。
  const sceneTerms = [...new Set([...lexicalTerms(lastBody.slice(-300)), ...lexicalTerms(query)])]
    .filter(term => term.length >= 2 && !present.includes(term) && !aliases.includes(term) && !edge.test(term));
  const state=fit(all.filter(r => sceneTerms.some(term => r.event.includes(term))).filter(r=>r.type==='thread' && !r.dormant).sort((a,b)=>b.sourceTo-a.sourceTo),900).rows;
  const hits=[];
  for (const r of all) {
    if (fastPath || core.some(sent => sent.id === r.id && sent.event === r.event) || state.some(sent=>sent.id === r.id && sent.event === r.event)) continue;
    if (['style','plan'].includes(r.type) && !(director && /套路|写法|暗处|幕后/.test(director))) continue;
    const labels=[r.event,...r.people||[],...r.items||[],...r.tags||[],r.location].filter(Boolean).join(' ');
    const matches=terms.filter(t=>labels.includes(t));
    if (matches.length) hits.push({r,matches,score:matches.reduce((s,t)=>s+t.length,0)});
  }
  hits.sort((a,b)=>b.score-a.score||(b.r.importance||0)-(a.r.importance||0)||b.r.sourceTo-a.r.sourceTo);
  return {core:render(core),state:render(state),hits:[],coreOmitted:facts.omitted + knowledge.omitted,records:{core,state,recalled:[]},
    candidates:hits,fastPath,verify,terms,topicTerms:intent?topicTerms:[]};
}
