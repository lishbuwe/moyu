import {readFileSync} from 'node:fs';
import {buildContext} from '../js/prompt.js';

const [file,...args] = process.argv.slice(2);
if (!file) throw Error('用法：node tools/probe-context.mjs 存档.json [--strip 文本] [输入…]');
const save = JSON.parse(readFileSync(file,'utf8'));
const stripAt = args.indexOf('--strip');
const strip = stripAt >= 0 ? args.splice(stripAt,2)[1] : '';
function stripCards(object) {
  for (const [key,value] of Object.entries(object || {})) {
    if (typeof value === 'string') object[key] = value.replaceAll(strip,'');
    else if (value && typeof value === 'object') stripCards(value);
  }
}
for (const story of save.stories) {
  const nodes = new Map(save.nodes.filter(n=>n.storyId === story.id).map(n=>[n.id,n]));
  const path = [], seen = new Set();
  for (let n=nodes.get(story.headId); n; n=nodes.get(n.parentId)) {
    if (seen.has(n.id)) throw Error('分支节点循环');
    seen.add(n.id); path.unshift(n);
    if (strip) stripCards(n.checkpoint?.cards);
  }
  if (strip) stripCards(story.cards);
  for (const text of args.length ? args : ['我推开门。','还记得以前那件事吗？','它后来怎么样了？','第二天，我到了车站。']) {
    const {info} = buildContext(story,[...path,{role:'user',kind:'play',inputFormat:'quoted',text}],{budgetChars:30000});
    console.log(JSON.stringify({story:story.title,text,chars:info.totalChars,chapters:info.continuity?.kept,
      excerpts:info.continuity?.excerpts,hits:info.retrievalHits.length,omitted:info.coreOmitted,
      parts:info.parts.map(({label,chars})=>({label,chars})),materials:info.materials}));
  }
}
