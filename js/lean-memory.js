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
      if (term.length >= 3 && !edge.test(term)) terms.add(term);
    }
  }
  return [...terms];
}

export function covered(text, sources) {
  const clean = s => s.normalize('NFKC').replace(/[\s\p{P}]/gu,'');
  const key = clean(text);
  if (!key) return true;
  return sources.some(raw => {
    const source = clean(raw);
    if (source.includes(key)) return true;
    if (key.length < 3) return false;
    let hits = 0;
    for (let i=0;i<=key.length-3;i++) if (source.includes(key.slice(i,i+3))) hits++;
    return hits >= (key.length-2)*0.6;
  });
}

function fit(rows, cap, max = Infinity) {
  const result=[];
  for (const row of rows) {
    const chars = row.event.length + 18;
    if (result.length >= max) break;
    if (chars > cap || covered(row.event,result.map(r=>r.event))) continue;
    result.push(row); cap-=chars;
  }
  return result;
}
const render = rows => rows.map(r=>'- [第'+r.sourceFrom+'–'+r.sourceTo+'章] '+r.event).join('\n');

// A repeated inscription is a strong anchor across overlapping chapter summaries.
// Prefer the complete quotation, including a signature, for wording questions.
function wordingCandidates(hits, query) {
  const asksHolder = /还在.{1,10}那|谁.{0,3}(收着|留着|保管|持有)|在谁/.test(query);
  if (!asksHolder && !/写|原话|落款|留言|题词/.test(query)) return hits;
  const holders = [];
  const selected = [];
  const quotations = [];
  for (const hit of hits) {
    const quotes = [...hit.r.event.matchAll(/[「“]([^」”]+)[」”]/gu)];
    const words = quotes.length === 1 && quotes[0][1].replace(/[\s\p{P}]/gu, '');
    const holder = asksHolder && hit.r.event.match(/(?:由|[，。；])([\p{Script=Han}]{2,4}?)(?:收着|留着|保管|持有)/u)?.[1];
    const index = words && words.length >= 5 ? quotations.findIndex((other, i) =>
      other && (!asksHolder || (holder && holders[i] && (holder.endsWith(holders[i]) || holders[i].endsWith(holder)))) && (other.startsWith(words) || words.startsWith(other)) &&
      selected[i].matches.some(term => hit.matches.includes(term))) : -1;
    if (index < 0) {
      selected.push(hit);
      quotations.push(words);
      holders.push(holder);
    } else if (words.length > quotations[index].length) {
      selected[index] = hit;
      quotations[index] = words;
      holders[index] = holder;
    }
  }
  return selected;
}

export function leanMemory(mem, query, director, lastBody, aliases, present) {
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
  const fastPath=!director && !intent && !terms.length;
  const topicTerms = lexicalTerms(query);
  if (!terms.length && intent) terms=topicTerms.filter(t=>{
    const n=all.filter(r=>r.event.includes(t)).length;
    return n>0 && n<=all.length*0.15;
  });
  const ranked=[...all].sort((a,b)=>(b.importance||0)-(a.importance||0)||b.sourceTo-a.sourceTo);
  const core=fit(ranked.filter(r=>r.type!=='knowledge' && (r.irreversible || r.type==='correction')),600,8);
  const knowledge=fit(ranked.filter(r=>r.type==='knowledge' && [...r.people||[],...r.knowers||[]].some(n=>present.includes(n))),600);
  core.push(...knowledge);
  // 只有明确描述当前归属的短项可以常驻，带历史或引文的混合记录留待检索。
  const state=fit(all.filter(r=>r.type==='thread' || (r.type==='item' && /^[^。！？：“”\n]{1,28}(?:现由|目前由)[^。！？：“”\n]{1,16}(?:保管|持有)[。]?$/u.test(r.event))).sort((a,b)=>b.sourceTo-a.sourceTo),900);
  const hits=[];
  for (const r of all) {
    if (fastPath || core.includes(r) || state.includes(r)) continue;
    if (['style','plan'].includes(r.type) && !(director && /套路|写法|暗处|幕后/.test(director))) continue;
    const labels=[r.event,...r.people||[],...r.items||[],...r.tags||[],r.location].filter(Boolean).join(' ');
    const matches=terms.filter(t=>labels.includes(t));
    if (matches.length) hits.push({r,matches,score:matches.reduce((s,t)=>s+t.length,0)});
  }
  hits.sort((a,b)=>b.score-a.score||(b.r.importance||0)-(a.r.importance||0)||b.r.sourceTo-a.r.sourceTo);
  return {core:render(core),state:render(state),hits:[],coreOmitted:0,records:{core,state,recalled:[]},
    candidates:verify ? wordingCandidates(hits, query) : hits,fastPath,verify,terms,topicTerms:intent?topicTerms:[]};
}
