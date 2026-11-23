// 显式实体由调用方直接匹配。切词用于补充线索，缺少浏览器词典时保留连续词及汉字相邻片段。
const dictionary = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh',{granularity:'word'}) : null;
export function searchWords(text) {
  const normalized = String(text || '').normalize('NFKC').toLowerCase();
  if (dictionary) return [...dictionary.segment(normalized)].filter(x=>x.isWordLike).map(x=>x.segment);
  const groups = normalized.match(/[\p{Script=Han}]+|[\p{L}\d]+/gu) || [];
  return groups.flatMap(word=>/\p{Script=Han}/u.test(word) && word.length>2 ?
    [word,...Array.from({length:word.length-1},(_,i)=>word.slice(i,i+2))] : [word]);
}
