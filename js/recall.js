// 旧正文检索在本机完成。只对当前分支上的正文建立索引。
const indexes = new WeakMap();
const stop = new Set('我们 你们 他们 她们 什么 一个 这个 那个 这样 那样 不是 没有 有点 一下 一眼 一会 看着 说道 说着 之后 的时候 自己 继续 我想 他说 她说'.split(' '));
export const HOLD_ROUNDS = 3;
const MAX_HITS = 3;

function terms(text) {
  const found = new Set();
  for (const word of text.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]{2,}/gu) || []) {
    if (!/^\p{Script=Han}/u.test(word)) { found.add(word); continue; }
    for (let i = 0; i < word.length - 1; i++) {
      for (const length of [2, 3]) {
        const term = word.slice(i, i + length);
        if (term.length === length && !stop.has(term) && !/^的|的$/u.test(term)) found.add(term);
      }
    }
  }
  return found;
}

function indexChapter(chapter, body) {
  const { node } = chapter;
  const cached = indexes.get(node);
  const action = chapter.user?.kind === 'play' ? chapter.user.text || '' : '';
  if (cached?.text === node.text && cached.action === action) return cached.chunks;
  const paragraphs = body(chapter).split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  if (action.trim()) {
    const bit = action.trim().slice(0, 280);
    chunks.push({ key: 'action', quote: '玩家：' + bit + (paragraphs.length ? '\n正文：' + paragraphs[0].slice(0, 180) : ''), terms: terms(bit) });
  }
  for (let i = 0; i < paragraphs.length; i++) {
    const text = paragraphs[i];
    for (let offset = 0; offset < text.length; offset += 280) {
      const bit = text.slice(Math.max(0, offset - 30), offset + 280);
      const before = offset === 0 ? paragraphs[i - 1]?.slice(-100) : '';
      const after = offset + 280 >= text.length ? paragraphs[i + 1]?.slice(0, 100) : '';
      const quote = [before, bit, after].filter(Boolean).join('\n');
      chunks.push({ key: i + ':' + offset, quote, terms: terms(bit) });
    }
  }
  indexes.set(node, { text: node.text, action, chunks });
  return chunks;
}

export function recallPassages(chapters, scene, body, { query, context, people, changedScene, recentN, sceneBoundary }) {
  if (chapters.length <= recentN) return [];
  const older = recentN ? chapters.slice(0, -recentN) : chapters;
  const sources = new Map(older.map((chapter) => [chapter.id, chapter]));
  const active = new Map();
  const lastNo = chapters.at(-1).no;
  if (!changedScene) {
    for (const anchor of scene.slice(-HOLD_ROUNDS).reverse()) {
      if (anchor === sceneBoundary && !anchor.userStartedScene) break;
      const rounds = HOLD_ROUNDS - (lastNo - anchor.no);
      if (anchor.node.status !== 'done' && anchor.node.status !== 'partial') continue;
      for (const hit of Array.isArray(anchor.node.recallRefs) ? anchor.node.recallRefs.slice(0, MAX_HITS) : []) {
        const chapter = sources.get(hit?.nodeId);
        if (!chapter || chapter.no >= anchor.no) continue;
        const chunk = indexChapter(chapter, body).find((item) => item.key === hit.key && item.quote === hit.quote);
        if (!chunk || active.has(chapter.id)) continue;
        active.set(chapter.id, { chapter, key: chunk.key, quote: chunk.quote, reason: hit.reason, rounds, fresh: false });
      }
    }
  }

  const direct = terms(query);
  const exact = query.normalize('NFKC').toLowerCase().trim().replace(/[。！？?!]+$/u, '');
  const focusedPrefix = /^[\p{Script=Han}]{3,8}$/u.test(exact) ? exact.slice(0, 3) : '';
  const contextTerms = terms(context);
  // 人名可帮助排序，但单独命中人名不能把一堆无关往事拉回来。
  const nameTerms = new Set(people.flatMap((name) => [...terms(name)]));
  for (const term of nameTerms) direct.delete(term);
  for (const term of nameTerms) contextTerms.delete(term);
  const candidateTerms = [...new Set([...direct, ...contextTerms])];
  if (!candidateTerms.length) return [...active.values()].slice(0, MAX_HITS);

  const indexed = older.map((chapter) => ({ chapter, chunks: indexChapter(chapter, body) }));
  const frequency = new Map();
  const sought = new Set(candidateTerms);
  for (const { chunks } of indexed) {
    const chapterMatches = new Set();
    for (const chunk of chunks) for (const term of chunk.terms) {
      if (sought.has(term)) chapterMatches.add(term);
    }
    for (const term of chapterMatches) frequency.set(term, (frequency.get(term) || 0) + 1);
  }
  const rare = candidateTerms.filter((term) => frequency.has(term) && (indexed.length < 4 || frequency.get(term) / indexed.length <= 0.65));
  const specificity = new Map(rare.map((term) => [term, Math.log1p(indexed.length / frequency.get(term))]));
  const weight = (term) => specificity.get(term) * (term.length >= 3 ? 2 : 1);
  const ranked = [];
  for (const { chapter, chunks } of indexed) {
    let best;
    for (const chunk of chunks) {
      const matches = rare.filter((term) => chunk.terms.has(term));
      const directHits = matches.filter((term) => direct.has(term));
      if (!directHits.some((term) => term.length >= 3 || term === exact || frequency.get(term) / indexed.length <= 0.08) && directHits.length < 2 &&
          !(matches.length >= 3 && matches.some((term) => term.length >= 3))) continue;
      const score = 4 * directHits.reduce((sum, term) => sum + weight(term) * specificity.get(term), 0) +
        (directHits.includes(focusedPrefix) ? 200 : 0) +
        Math.min(12, matches.filter((term) => !direct.has(term)).reduce((sum, term) => sum + weight(term), 0)) +
        Math.min(2, [...nameTerms].filter((term) => chunk.terms.has(term)).length);
      if (!best || score > best.score) {
        const reason = (directHits.length ? directHits : matches).sort((a, b) => weight(b) - weight(a)).slice(0, 5).join('、');
        best = { chapter, key: chunk.key, quote: chunk.quote, reason, score, direct: directHits.length > 0,
          rounds: HOLD_ROUNDS, fresh: true };
      }
    }
    if (best) ranked.push(best);
  }
  ranked.sort((a, b) => b.score - a.score || b.chapter.no - a.chapter.no);
  const best = ranked[0]?.score || 0;
  const fresh = ranked.filter((hit) => !active.has(hit.chapter.id) && hit.score >= best * 0.6);
  return [...fresh.filter((hit) => hit.direct), ...active.values(), ...fresh.filter((hit) => !hit.direct)].slice(0, MAX_HITS);
}

// 已确认事实后，只回到该事实的来源范围；同一实体可能在多章出现。
export function passageForFact(chapters, body, record, terms, recentN) {
  const from = record.sourceChapter || record.sourceFrom;
  const to = record.sourceChapter || record.sourceTo;
  let best;
  for (const chapter of chapters.slice(0, -recentN)) {
    if (chapter.no < from || chapter.no > to) continue;
    for (const paragraph of body(chapter).split(/\n+/)) {
      const matched = terms.filter(term => paragraph.includes(term));
      if (!matched.length) continue;
      const start = Math.max(0, paragraph.indexOf(matched[0]) - 100);
      const quote = paragraph.slice(start, start + 400);
      const score = matched.reduce((sum,t)=>sum+t.length,0) + (quote.includes(record.event) ? 1000 : 0);
      if (!best || best.score < score) best = { chapter, quote, score, key:'fact-'+record.id,
        reason:matched.join('、')+' · '+record.id, fresh:true, rounds:1 };
    }
  }
  return best;
}
