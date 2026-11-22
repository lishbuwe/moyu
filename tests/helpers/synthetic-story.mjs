export function syntheticStory(count, { migrated = false, backlog = 0, marked = false } = {}) {
  const story = { memoryPlan:'lean', protagonist:{name:'顾律'}, cards:['陆青','白杨','周宁'].map(name => ({
    name, core:true, now:'现在叫律律。', relation:'互相信任。', arc:Array.from({length:40},(_,i)=>'变化节点'+i).join('\n'),
  })) };
  const path = [];
  const records = Array.from({length:24}, (_,i)=>({id:'r'+i, sourceFrom:1,sourceTo:40,type:'event',event:'旧时街景编号'+i}));
  records.push({id:'book', event:'蓝色笔记本的背面写着 ANSWER-7421', type:'item', sourceChapter:migrated?null:40,sourceFrom:migrated?1:40,sourceTo:migrated?80:40,items:migrated?[]:['蓝色笔记本']});
  records.push({id:'secret',type:'knowledge',event:'SECRET-A-255',knowers:['白杨'],sourceFrom:12,sourceTo:12});
  let seed = 7;
  for(let n=1;n<=count;n++){
    let body='';
    for(let j=0;j<800;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;body+=String.fromCharCode(0x5500+seed%400);}
    path.push({id:'u'+n,role:'user',kind:'play',text:'继续。'},
      {id:'a'+n,role:'assistant',kind:'play',text:'# 小节\n\n'+body+'\n陆青走了过来。'+(n===40?'\n蓝色笔记本的背面写着 ANSWER-7421':'')+(n===60?'FUT-090':'')});
  }
  const upTo=count-backlog;
  path[2*upTo-1].checkpoint={upTo,records,cards:{},continuity:{scenes:marked?[{nodeId:'a'+(count-2),quote:'陆青走了过来。'}]:[]}};
  return {story,path};
}
