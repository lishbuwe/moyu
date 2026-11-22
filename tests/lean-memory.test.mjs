import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../js/prompt.js';
import { syntheticStory } from './helpers/synthetic-story.mjs';
const action='我看了他一眼。', question='以前那个蓝色笔记本，背面写了什么？';
function run(f,text,opts={}) {
  return buildContext(f.story,[...f.path,{role:'user',kind:'play',text}],{budgetChars:30000,...opts});
}
for(const n of [120,364]) for(const marked of [true,false]) test('A F H I K L '+n+' '+marked,()=>{
  const f=syntheticStory(n,{marked,backlog:5});
  f.path.at(-1).text+='蓝色笔记本。';
  const c=run(f,action);
  assert.equal(c.info.fastPath,true);
  assert.deepEqual(c.info.continuity.kept,[n-1,n]);
  assert.deepEqual(c.info.continuity.excerpts,[]);
  assert.deepEqual(c.info.retrievalHits,[]);
  assert.doesNotMatch(c.system,/ANSWER-|SECRET-A|变化节点0\b/);
  assert.match(c.system,/律律/);assert.match(c.system,/变化节点39/);
  assert.ok(c.info.totalChars<=30000);
});
for(const migrated of [true,false]) test('D E precise source '+migrated,()=>{
  const c=run(syntheticStory(120,{migrated}),question);
  assert.deepEqual(c.info.retrievalHits.map(r=>r.id),['book']);
  assert.deepEqual(c.info.continuity.excerpts,[40]);
  for(const p of c.info.parts.filter(p=>!['历史记忆检索','较早互动原文'].includes(p.label))) assert.doesNotMatch(p.text,/ANSWER-/);
});
test('B C pronoun resolves from last paragraph',()=>{
  const f=syntheticStory(120);f.path.at(-1).text+='蓝色笔记本。';
  assert.deepEqual(run(f,'翻过来').info.retrievalHits.map(x=>x.id),['book']);
  f.path.at(-1).text+='蓝色笔记本的背面写着 ANSWER-7421';
  assert.deepEqual(run(f,'翻过来').info.retrievalHits,[]);
});
test('G backlog requires a relevant topic and a participant',()=>{
  const f=syntheticStory(120,{backlog:8});f.path[2*116-1].text+='铜盒子';
  assert.ok(run(f,'上次那个铜盒子呢？').info.continuity.kept.includes(116));
});
test('J branch path and rollback',()=>{
  const f=syntheticStory(120);f.path=f.path.slice(0,60);
  assert.doesNotMatch(JSON.stringify(run(f,question)),/FUT-090|ANSWER-7421|BRANCH-other/);
});
