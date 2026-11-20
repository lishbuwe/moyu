// 旧档没有知情者时，只认独立的、明确陈述消息来源的原句。
// 引号中的内容不能脱离说话者独立匹配；条件、转折和混合叙述留给明确标记的记忆。
const publicSource = /^(?:在)?(?:晚会|发布会|记者会|新闻发布会|颁奖礼|开幕式|全校大会|直播)(?:现场|上|中)?[，,]?(?:主持人|主办方|校方|发言人)?(?:向公众|向全场|向全校|当众|公开)(?:宣布|公布|宣读|播报)|^(?:校方|主办方|官方账号|主持人|发言人)(?:公开|当众)(?:宣布|公布|宣读)|^(?:官网公告|公开通告|官方公告)(?:写道|写明|显示|宣布|[：:])/u;
const uncertain = /如果|假如|要是|假设|也许|可能|传闻|据说|听说|打算|准备|计划|将要|梦见|想象|以为|并未|并没有|从未|尚未|否认|澄清|内心|心想|其实|暗中|实际上|私下|但|然而|却|[；;？?]/u;
const quotePairs = { '“': '”', '「': '」', '『': '』', '‘': '’', '"': '"' };

function sentences(text) {
  const result = [], quotes = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quotes.length && ch === quotes.at(-1)) quotes.pop();
    else if (quotePairs[ch]) quotes.push(quotePairs[ch]);
    if (!quotes.length && /[。！？!?\n]/u.test(ch)) {
      const sentence = text.slice(start, i + 1).trim();
      if (sentence) result.push(sentence);
      start = i + 1;
    }
  }
  if (!quotes.length && text.slice(start).trim()) result.push(text.slice(start).trim());
  return result;
}

function witnesses(event, readers) {
  const heard = readers.filter(name => ['亲眼看见', '亲眼看到', '亲耳听见', '亲耳听到', '收到短信', '收到私信'].some(verb => event.startsWith(name + verb)));
  // 有明确发送人和收件人的一句话只进入双方的材料。
  for (const sender of readers) {
    if (!event.startsWith(sender)) continue;
    for (const listener of readers) {
      if (sender === listener) continue;
      if (['对', '告诉', '发给'].some(verb => {
        const prefix = sender + verb + listener;
        return event.startsWith(prefix) && /^(?:说|说道|的短信|的私信)?[：:“「]/u.test(event.slice(prefix.length));
      })) heard.push(sender, listener);
    }
  }
  return [...new Set(heard)];
}

export function evidenceRecords(sources, names, cache = {}) {
  const readers = [...new Set(names.filter(Boolean))].sort();
  const signature = JSON.stringify(readers);
  const previous = new Map(cache.signature === signature && Array.isArray(cache.entries) ? cache.entries : []);
  const used = new Map(), records = [], seen = new Set();
  for (const source of sources) {
    let previousLine = '';
    for (const line of sentences(source.text)) {
      const preceding = previousLine;
      previousLine = line;
      let event = line;
      // 同章紧邻的进场与明确面向此人的发言。只认一个具名入场者，
      // 代词不能跨越切场、插话或其他叙述；公众不会因此获得私聊。
      let addressed = null;
      if (source.chapter && !uncertain.test(preceding)) {
        const listener = readers.find(name => preceding.startsWith(name) && /^(?:推门进来|在对面坐下|(?:走进|走入|来到|回到)(?:了)?[\p{Script=Han}]{1,8})。$/u.test(preceding.slice(name.length)));
        const speaker = listener && readers.find(name => name !== listener && ['对她说', '对他说', '朝她说', '朝他说'].some(verb => line.startsWith(name + verb + '：“') && /^.*：“[^“”]+”[。]?$/.test(line)));
        if (speaker && readers.every(name => name === listener || !preceding.includes(name))) {
          event = preceding + line;
          addressed = [speaker, listener];
        }
      }
      if (event.length > 200 || uncertain.test(event) || /[，,、]/u.test(event.replace(/^([^，,]{1,12})(现场|上|中)[，,]/u, '$1$2'))) continue;
      let knowers = previous.get(event);
      if (!knowers) {
        if (addressed) knowers = addressed;
        else if (publicSource.test(event)) knowers = ['公开'];
        else knowers = witnesses(event, readers);
      }
      if (!knowers.length) continue;
      used.set(event, knowers);
      const id = JSON.stringify([source.id, event]);
      if (seen.has(id)) continue;
      seen.add(id);
      records.push({ id, event, sourceFrom: source.from, sourceTo: source.to, people: knowers,
        knowers, importance: source.pinned ? 10 : 6, type: 'event' });
    }
  }
  cache.signature = signature;
  cache.entries = [...used].slice(-600);
  return records;
}
