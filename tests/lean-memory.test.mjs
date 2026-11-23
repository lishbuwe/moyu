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
  assert.deepEqual(c.info.continuity.excerpts,[]);
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
  const ctx = run(f,'上次那个铜盒子呢？');
  assert.ok([...ctx.info.continuity.kept, ...ctx.info.continuity.excerpts].includes(116));
});
test('J branch path and rollback',()=>{
  const f=syntheticStory(120);f.path=f.path.slice(0,60);
  assert.doesNotMatch(JSON.stringify(run(f,question)),/FUT-090|ANSWER-7421|BRANCH-other/);
});

test('旧档第59章的普通动作不召回第33章，明确问剑时仍能找到原文', () => {
  const f = syntheticStory(59);
  delete f.story.memoryPlan;
  const old = f.path[65];
  old.text = '他毫不客气地说，石中剑藏在旧塔的井底。';
  f.path.at(-1).recallRefs = [{nodeId:old.id,key:'0:0',quote:old.text,reason:'毫不客、不客气、石中剑'}];
  const ordinary = run(f, '我毫不客气地看了他一眼。');
  assert.deepEqual(ordinary.info.continuity.kept,[58,59]);
  assert.doesNotMatch(ordinary.system,/旧塔的井底/);
  assert.ok(run(f,'还记得那把石中剑吗？').system.includes('旧塔的井底'));
});

test('普通动作提到旧物不翻档，近期原文已有答案也不查旧章', () => {
  const f = syntheticStory(120);
  for (const text of ['我把蓝色笔记本放回桌上。','我把它放回桌上。']) {
    const ctx = run(f,text);
    assert.deepEqual(ctx.info.retrievalHits,[]);
    assert.deepEqual(ctx.info.continuity.excerpts,[]);
  }
  f.path.at(-1).text += '蓝色笔记本的背面写着 ANSWER-7421';
  const ctx = run(f,question);
  assert.deepEqual(ctx.info.retrievalHits,[]);
  assert.deepEqual(ctx.info.continuity.excerpts,[]);
});

test('关系记录完整保留后半句；核心只写剑柄时仍能追问藏处', () => {
  const f = syntheticStory(60);
  f.path.at(-1).checkpoint.records = [
    {id:'former', type:'fact', irreversible:true, event:'甲乙曾是恋人；两人已经分手，此事尚未公开。', sourceFrom:1, sourceTo:30},
    {id:'hilt', type:'fact', irreversible:true, event:'石中剑的剑柄已经裂开。', items:['石中剑'], sourceFrom:1, sourceTo:30},
  ];
  f.path[65].text = '石中剑藏在旧塔的井底。';
  assert.match(run(f,action).system,/两人已经分手，此事尚未公开/);
  assert.match(run(f,'还记得那把石中剑吗？当时藏在哪里？').system,/旧塔的井底/);
});

test('没有结构化记录时，普通短动作也不引用同词旧章', () => {
  const f = syntheticStory(60);
  f.path.at(-1).checkpoint.records = [];
  f.path[65].text = '推开房门。旧塔突然坍塌。';
  assert.deepEqual(run(f,'推开房门。').info.continuity.excerpts,[]);
});

test('重复句尾不会吞掉不同事实，缺失知情者的限制保留给正文 GM', () => {
  const f=syntheticStory(60);
  const records=Array.from({length:16},(_,i)=>({id:'f'+i, type:'fact', irreversible:true,sourceFrom:1,sourceTo:30,event:'事件编号'+i+'，这件事已无法挽回，今后不得忘记。'}));
  records.push(...Array.from({length:8},(_,i)=>({id:'k'+i,type:'knowledge',sourceFrom:2,sourceTo:30,event:'秘密编号'+i+'尚未公开。',people:i<4?[]:['陆青']})));
  f.path.at(-1).checkpoint.records=records;
  const c=run(f,action);
  for(const r of records) assert.ok(c.system.includes(r.event));
  assert.equal(c.info.coreOmitted,0);
});
