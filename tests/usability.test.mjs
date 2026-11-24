import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://qa.example/moyu/' });
for (const key of ['window','document','Node','Event','CustomEvent','localStorage','location','FileReader']) globalThis[key] = dom.window[key];
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0); globalThis.cancelAnimationFrame = clearTimeout;
globalThis.confirm = () => true;
dom.window.HTMLElement.prototype.scrollIntoView = function() {};
const style = document.createElement('style'); style.textContent = await readFile(new URL('../css/app.css', import.meta.url), 'utf8'); document.head.append(style);
const { db, exportStory, exportAll, importData } = await import('../js/db.js');
const { readAttachment, attachmentBytes, selectedImport } = await import('../js/attachments.js');
const { chatMessages, newDiscussion, saveDiscussion, getDiscussion, exportDiscussions } = await import('../js/discuss.js');
const { markdownPack, importMarkdownPack, groupModules, deleteModules, undoModuleDelete } = await import('../js/rules.js');
const { getModules, saveModules } = await import('../js/state.js');
const { protagonistState, reviewProtagonistChanges, applyProtagonistChanges } = await import('../js/protagonist.js');
const { buildContext } = await import('../js/prompt.js');
const { inlineText } = await import('../js/inline.js');
const play = await import('../js/views/play.js');
const extras = await import('../js/views/extras.js');
const settings = await import('../js/views/settings.js');
const discussion = await import('../js/views/discuss.js');
const chars = await import('../js/views/chars.js');
const { runArchivist } = await import('../js/memory.js');
const storyView = await import('../js/views/story.js');
let requests = [], responses = [], root;
const options = '\n\n【选项】\nA. 查看地图\nB. 收好信件\nC. 询问路人\nD. 留在原地';
const wait = async fn => { for (let i=0;i<300;i++) { if(await fn()) return; await new Promise(r=>setTimeout(r,10)); } throw new Error('等待状态超时'); };
const button = (text, container = document) => [...container.querySelectorAll('button')].find(b=>b.textContent===text);
async function seedStory() {
  const story = { id:'story-qa',title:'测试故事',world:'主角是已经成年的青年。',rules:'保持设定',cards:[],headId:'a1',options:true,danmu:false,modules:{},localModules:[],packs:[],memEvery:0,protagonist:{name:'林舟',gender:'男',note:'初始是大学生。'} };
  const nodes = [{id:'u1',storyId:story.id,parentId:null,role:'user',kind:'start',text:'开始',createdAt:1},
    {id:'a1',storyId:story.id,parentId:'u1',role:'assistant',kind:'play',status:'done',text:'# 毕业之后\n\n林舟已经毕业，入职设计公司。'+options,createdAt:2}];
  await db.put('stories',story); await db.putMany('nodes',nodes); return {story,nodes};
}
beforeEach(async () => {
  for(const store of ['stories','nodes','extras','connections']) for(const item of await db.all(store)) await db.del(store,item.id);
  for(const key of ['modules','packs','disc.index','relay','defaultConn','globalMemo','modules.undo','fwTemplates','fwBase','fwPlaybooksV1','extraConnectionId','usageLog','spend']) await db.kvSet(key,null);
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  localStorage.clear(); document.body.innerHTML='<div id="fixture"></div><div id="toast"></div>'; root=document.querySelector('#fixture');
  requests=[]; responses=[];
  await db.put('connections',{id:'qa-conn',format:'openai',name:'测试连接',baseUrl:'https://model.qa.example/v1',apiKey:'virtual-key',model:'test',stream:false,maxTokens:2048});
  await db.kvSet('relay',{on:false});
  globalThis.fetch=async(url,init)=>{ requests.push({url,body:JSON.parse(init.body)}); const answer=responses.shift()??('# 新进展\n\n你收好了信。'+options);
    return new Response(JSON.stringify({choices:[{message:{content:answer},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:20}}),{headers:{'Content-Type':'application/json'}}); };
});

test('选项追加全文，保留草稿与修改，双击只保存一次', async () => {
  const {story}=await seedStory(); const dispose=await play.render(root,{id:story.id});
  try {
    const ta=root.querySelector('textarea'), buttons=root.querySelectorAll('.options button');
    ta.value='B超报告在桌上。'; buttons[0].click(); buttons[1].click();
    assert.equal(ta.value,'B超报告在桌上。\n查看地图\n收好信件');
    assert.notEqual(document.activeElement,ta);
    ta.value=ta.value.replace('收好信件','收好报告。');
    ta.setSelectionRange(ta.value.length,ta.value.length);
    root.querySelector('[aria-label="插入台词引号"]').click();
    ta.setRangeText('明天见。',ta.selectionStart,ta.selectionEnd,'end');
    const action='B超报告在桌上。\n查看地图\n收好报告。“明天见。”';
    assert.equal(ta.value, action);
    const send=button('发送'); send.click(); send.click();
    await wait(()=>requests.length===1&&!dispose.busy());
    assert.ok(requests[0].body.messages.at(-1).content.startsWith(action));
    const saved=(await db.byStory(story.id)).filter(n=>n.kind==='play'&&n.role==='user');
    assert.equal(saved.length,1); assert.equal(saved[0].text,action); assert.equal(saved[0].inputFormat,'quoted');
    assert.equal(ta.value,'');
  } finally { dispose(); }
});

test('补选项使用单局数量约定，并保存模型返回的各项', async () => {
  const { story,nodes }=await seedStory();
  story.rules='每章末给两个参考选项。';
  nodes[1].text='# 门口来信\n她撑开伞。';
  await db.put('stories',story); await db.put('nodes',nodes[1]);
  const dispose=await play.render(root,{id:story.id});
  try {
    responses.push('【选项】\nA. 留下\nB. 出门');
    button('这一章没写选项 · 补选项').click();
    await wait(()=>root.querySelectorAll('.options button').length===2);
    assert.match(requests[0].body.messages[0].content,/每章末给两个参考选项/);
    assert.doesNotMatch(requests[0].body.messages.at(-1).content,/四个|五行/);
  } finally { dispose(); }
});

test('导入后的长文本完整显示，选段重写定位只移动正文滚动区的纵轴', async (t) => {
  const story = { id: 'import-layout', title: '导入故事', headId: 'import-reply', cards: [], danmu: false };
  const wide = 'https://example.test/' + 'abc'.repeat(180);
  const nodes = [
    { id: 'import-start', storyId: story.id, role: 'user', kind: 'start', text: '开始' },
    { id: 'import-reply', storyId: story.id, parentId: 'import-start', role: 'assistant', kind: 'play',
      status: 'done', text: '# ' + wide + '\n\n正文保留。\n\n【选项】\nA. ' + wide },
  ];
  await importData({ app: 'moyu', schema: 1, stories: [story], nodes });
  globalThis.CSS = { escape: (id) => id };
  t.after(() => { delete globalThis.CSS; });
  const nativeScroll = t.mock.method(dom.window.HTMLElement.prototype, 'scrollIntoView', () => {});
  const dispose = await play.render(root, { id: story.id });
  try {
    const scroller = root.querySelector('.play-scroll');
    const reply = root.querySelector('[data-id="import-reply"]');
    assert.equal(reply.querySelector('h2').textContent, wide);
    assert.equal(reply.querySelector('.options button').textContent, 'A' + wide);
    t.mock.method(scroller, 'getBoundingClientRect', () => ({ top: 48 }));
    t.mock.method(dom.window.HTMLElement.prototype, 'getBoundingClientRect', function () {
      return { top: this.dataset.id === 'import-reply' ? 248 : 0 };
    });
    scroller.scrollLeft = 90;
    root.querySelector('.chapter-row .more').click();
    [...document.querySelectorAll('.menu-list button')].find((b) => b.textContent.startsWith('从某一段往后重写')).click();
    await wait(() => scroller.scrollTop === 200);
    assert.equal(scroller.scrollLeft, 0);
    assert.equal(nativeScroll.mock.callCount(), 0);
    assert.equal((await db.get('nodes', 'import-reply')).text, nodes[1].text);
  } finally { dispose(); }
});

test('正文自动找回旧对白，普通动作不沿用，换场和回退不携带上一场的引用', async () => {
  const { story, nodes } = await seedStory();
  const quote = '他把半温莎结松开，压低声音说：“这一回我教你。”';
  nodes[1].text = '他的手搭在椅背上。\n\n' + quote + '\n\n我没有伸手。';
  await db.put('nodes', nodes[1]);
  let parentId = nodes[1].id;
  for (let i = 2; i <= 5; i++) {
    const user = { id: 'recall-u' + i, storyId: story.id, parentId, role: 'user', kind: 'play', text: '好。' };
    const reply = { id: 'recall-a' + i, storyId: story.id, parentId: user.id, role: 'assistant', kind: 'play',
      status: 'done', text: i === 2 ? '次日，窗外下起了雨。' : '雨仍在下。' };
    if (i === 5) reply.checkpoint = { upTo: 5, records: [], schema: 1 };
    await db.putMany('nodes', [user, reply]);
    parentId = reply.id;
  }
  story.headId = parentId;
  await db.put('stories', story);
  let dispose = await play.render(root, { id: story.id });
  async function send(text) {
    const count = requests.length + 1;
    root.querySelector('textarea').value = text;
    responses.push('雨仍在下。' + options);
    button('发送').click();
    await wait(() => requests.length === count && !dispose.busy());
    return requests.at(-1).body.messages.find((m) => m.role === 'system').content;
  }
  try {
    assert.ok((await send('还记得那个半温莎结吗？')).includes(quote));
    const first = await db.get('stories', story.id);
    const anchor = await db.get('nodes', first.headId);
    assert.ok(anchor.recallRefs.some((hit) => hit.nodeId === nodes[1].id));
    dispose(); root.replaceChildren();
    dispose = await play.render(root, { id: story.id });
    assert.ok(!(await send('我毫不客气地看了他一眼。')).includes(quote));
    assert.ok(!(await send('嗯。')).includes(quote));
    assert.ok((await send('还记得那个半温莎结吗？')).includes(quote));
    assert.ok(!(await send('次日，我到了码头。')).includes(quote));
    const past = [nodes[0], nodes[1], { ...nodes[0], id: 'alternative', text: '嗯。' }];
    assert.deepEqual(buildContext(story, past).info.continuity.automatic, []);
  } finally { dispose(); }
});

test('番外重写、切回旧版本后续写绑定各自素材与要求，重复点击只请求一次', async () => {
  const {story}=await seedStory();
  const oldContext={system:'旧版本专用设定',messages:[{role:'user',content:'旧版的要求'}],info:{totalChars:20,parts:[],chapters:[],cards:[]}};
  await db.put('extras',{id:'extra-qa',storyId:story.id,tplName:'小说体',tplText:'写场景',request:'新版要求',anchorId:'a1',anchorNo:1,length:'mid',cur:0,versions:[{text:'# 旧版\n\n旧版的结尾。',context:oldContext,request:'旧版的要求',status:'done'}]});
  const dispose=await extras.render(root,{id:story.id,extraId:'extra-qa'});
  try {
    responses.push('# 新版\n\n新版结尾。','接在旧版后面的新内容。');
    const generate=button('重新生成一个版本');generate.click();generate.click();
    await wait(()=>!dispose.busy()&&requests.length===1);
    assert.equal((await db.get('extras','extra-qa')).versions.length,2);
    root.querySelector('[aria-label="上一个版本"]').click();
    await wait(()=>root.textContent.includes('旧版的结尾。'));
    button('接着当前版本写').click(); await wait(()=>!dispose.busy()&&requests.length===2);
    const sent=requests[1].body;
    assert.ok(sent.messages[0].content.includes('第 1 章之后'));
    assert.ok(sent.messages.some(m=>m.content.includes('旧版的要求')));
    assert.ok(!sent.messages[0].content.includes('旧版本专用设定'));
    assert.ok(sent.messages.some(m=>m.role==='assistant'&&m.content.includes('旧版的结尾。')));
    assert.equal(sent.max_tokens,2048);
    const saved=await db.get('extras','extra-qa');
    assert.ok(saved.versions[0].text.endsWith('接在旧版后面的新内容。'));
    assert.equal(saved.versions[1].text,'# 新版\n\n新版结尾。');
  } finally {dispose();}
});

test('正文流式结束时没有终止标记，显示续写并接到同一章', async () => {
  const {story} = await seedStory();
  const conn = await db.get('connections', 'qa-conn');
  await db.put('connections', {...conn, stream: true});
  const okFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async (url, init) => {
    if (sent++) return okFetch(url, init);
    const chunk = JSON.stringify({choices: [{delta: {content: '# 半章\n\n他打开'}}]});
    return new Response('data: ' + chunk + '\n\n', {headers: {'Content-Type': 'text/event-stream'}});
  };
  const dispose = await play.render(root, {id: story.id});
  try {
    button('继续').click();
    await wait(() => sent === 1 && !dispose.busy());
    const interrupted = (await db.get('stories', story.id)).headId;
    assert.equal((await db.get('nodes', interrupted)).status, 'partial');
    assert.ok(root.textContent.includes('接口没发结束标记'));
    assert.equal(getComputedStyle(root.querySelector('.play-scroll')).overflowX, 'hidden');
    assert.equal(getComputedStyle(root.querySelector('.play-scroll .feed')).overflowWrap, 'anywhere');
    responses.push('信封。' + options);
    button('续写').click();
    await wait(() => requests.length === 1 && !dispose.busy());
    assert.equal((await db.get('stories', story.id)).headId, interrupted);
    assert.ok(requests[0].body.messages.at(-2).content.endsWith('他打开'));
    assert.equal((await db.get('nodes', interrupted)).text, '# 半章\n\n他打开信封。' + options);
  } finally { dispose(); }
});

test('已完成章也可续写，旧选项留在原版，新增正文正常显示在新版本', async () => {
  const {story, nodes} = await seedStory();
  const dispose = await play.render(root, {id: story.id});
  try {
    responses.push('他在新办公室坐下。' + options);
    button('续写').click();
    await wait(() => requests.length === 1 && !dispose.busy());
    const head = (await db.get('stories', story.id)).headId;
    assert.notEqual(head, story.headId);
    assert.equal((await db.get('nodes', head)).parentId, nodes[1].parentId);
    assert.equal((await db.get('nodes', story.headId)).text, nodes[1].text);
    assert.ok(!requests[0].body.messages.at(-2).content.includes('查看地图'));
    assert.equal(root.querySelector('.gm p:last-of-type').textContent, '他在新办公室坐下。');
  } finally { dispose(); }
});

test('整理保存可核对的互动，手选原文能保留和取消，下一场收到原句', async () => {
  const {story, nodes} = await seedStory();
  const quote = '林舟已经毕业，入职设计公司。';
  const picked = '他把想说的话又咽了回去。';
  story.cards = [{name: '林舟'}];
  story.protagonist = {name: '顾律'};
  await db.put('stories', story);
  nodes[1].text = '# 毕业之后\n\n' + quote + '\n\n' + picked + options;
  await db.put('nodes', nodes[1]);
  responses.push(JSON.stringify({
    summary: '他开始工作，却留下了一句没说完的话。',
    openLines: [{chapter: 1, people: ['林舟', '顾律'], detail: '这句话还没说完。', quote: picked}],
  }));
  await runArchivist(story, new Map(nodes.map((n) => [n.id, n])), nodes, await db.get('connections', 'qa-conn'));
  const original = await db.get('nodes', 'a1');
  assert.equal(original.checkpoint.continuity.lines[0].refs[0].quote, picked);
  const dispose = await play.render(root, {id: story.id});
  try {
    root.querySelector('.chapter-row button.more').click();
    [...document.querySelectorAll('.menu-list button')].find(b => b.textContent.startsWith('保留这段互动')).click();
    await wait(() => button('保存'));
    const boxes = [...document.querySelectorAll('[role="dialog"] input[type="checkbox"]')];
    boxes[0].checked = true;
    button('保存').click();
    await wait(() => !button('保存'));
    const pinned = await db.get('nodes', 'a1');
    assert.deepEqual(pinned.continuityPins, [quote]);
    assert.deepEqual(pinned.checkpoint, original.checkpoint);
    const path = [nodes[0], pinned,
      {id: 'u2', role: 'user', kind: 'play', text: '次日，我去见林舟。'},
      {id: 'a2', role: 'assistant', kind: 'play', text: '我们在长椅旁停下。'},
      {id: 'u3', role: 'user', kind: 'play', text: '我看他一眼。'},
      {id: 'a3', role: 'assistant', kind: 'play', text: '他把伞收了起来。'},
    ];
    const context = buildContext(story, path, {budgetChars: 6000});
    assert.ok(context.system.includes('玩家保留') && context.system.includes(quote) && context.system.includes(picked));
    root.querySelector('.chapter-row button.more').click();
    [...document.querySelectorAll('.menu-list button')].find(b => b.textContent.startsWith('管理保留的互动')).click();
    await wait(() => button('保存'));
    document.querySelector('[role="dialog"] input[type="checkbox"]').checked = false;
    button('保存').click();
    await wait(() => !button('保存'));
    assert.deepEqual((await db.get('nodes', 'a1')).continuityPins, []);
  } finally { dispose(); }
});

test('单张角色卡导出当前前情状态，重新导入只更新选中角色且需保存', async (t) => {
  const {story, nodes} = await seedStory();
  const card = {id: 'char-qa', name: '顾安', initial: '旧人设', core: false, now: '初始状态'};
  const other = {id: 'other-qa', name: '夏宁', initial: '另一个人'};
  await db.put('stories', {...story, cards: [card, other]});
  await db.put('nodes', {...nodes[1], checkpoint: {upTo: 1, items: ['保留信封'], cards: {'顾安': {now: '分支当前状态', arc: '变化', relation: '友人'}}}});
  let exported;
  t.mock.method(URL, 'createObjectURL', (blob) => {
    exported = blob.text();
    return 'blob:https://qa.example/character';
  });
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', () => {});
  let fileText;
  t.mock.method(dom.window.HTMLInputElement.prototype, 'click', function () {
    Object.defineProperty(this, 'files', {value: [new File([fileText], '角色卡.json')]});
    this.dispatchEvent(new Event('change'));
  });
  const dispose = await chars.render(root, {id: story.id});
  try {
    button('编辑', root.querySelector('[data-name="顾安"]')).click();
    button('导出角色卡').click();
    await wait(() => exported);
    const data = JSON.parse(await exported);
    assert.equal(data.card.now, '分支当前状态');
    assert.equal(data.card.core, false);
    assert.equal(data.card.id, undefined);
    button('取消').click();
    fileText = JSON.stringify({...data, card: {...data.card, initial: '修订人设', now: '修订状态', id: other.id}, world: '不会被导入'});
    button('导入角色卡').click();
    await wait(() => document.querySelector('[role="dialog"]'));
    assert.equal((await db.get('stories', story.id)).cards[0].initial, '旧人设');
    button('保存').click();
    await wait(() => !document.querySelector('[role="dialog"]'));
    const saved = await db.get('stories', story.id);
    assert.equal(saved.cards[0].id, card.id);
    assert.equal(saved.cards[0].initial, '修订人设');
    assert.deepEqual(saved.cards[1], other);
    assert.equal(saved.world, story.world);
    assert.equal(saved.headId, story.headId);
    const chapter = await db.get('nodes', story.headId);
    assert.equal(chapter.text, nodes[1].text);
    assert.deepEqual(chapter.checkpoint.items, ['保留信封']);
    assert.equal(chapter.checkpoint.cards['顾安'].now, '修订状态');
  } finally { dispose(); }
});

test('Markdown按文件分组，批量删除撤销不覆盖之后新建的模块',async()=>{
  const a=await importMarkdownPack('## 节奏\n写具体行动\n## 对白\n各有口吻','文风甲.md');
  assert.equal(a.mods.length,2);assert.equal(a.mods[0].pack,a.mods[1].pack);
  await groupModules(a.mods.map(m=>m.id),'统一文风');
  assert.equal(new Set((await getModules()).map(m=>m.pack)).size,1);
  await deleteModules(a.mods.map(m=>m.id));await saveModules([{id:'new',name:'后来新增',text:'保留'}]);
  assert.equal(await undoModuleDelete(),2);assert.equal((await getModules()).length,3);
});

test('设置栏目可折叠并记忆，规则管理提供批量选中删除与恢复',async()=>{
  await importMarkdownPack('## 节奏\n写具体行动\n## 对白\n各有口吻','文风甲.md');
  await settings.render(root,{section:'modules'});
  assert.ok(root.querySelectorAll('details.settings-section').length>=8);
  assert.equal(root.querySelector('#sec-modules').open,true);
  assert.equal(root.querySelectorAll('.rule-pack').length,1);
  button('全选').click();button('删除所选').click();await wait(async()=>!(await getModules()).length);
  await wait(()=>!!button('撤销上次删除'));button('撤销上次删除').click();await wait(async()=>(await getModules()).length===2);
  await wait(()=>[...root.querySelectorAll('.settings-section')].some(d=>d.firstElementChild.textContent==='阅读'));
  const reading=[...root.querySelectorAll('.settings-section')].find(d=>d.firstElementChild.textContent==='阅读');
  reading.open=true;reading.dispatchEvent(new Event('toggle'));
  assert.equal(localStorage.getItem('moyu-yl2c.settings.fold.阅读'),'open');
});

test('复制 API 连接复用地址和密钥，选模型保存后可在游玩页切换', async () => {
  const {story} = await seedStory();
  const source = {...await db.get('connections','qa-conn'), createdAt: 1, mt8000: true, viaRelay: true};
  await db.put('connections', source);
  await settings.render(root,{});
  const openCopy = async () => {
    button('复制连接', root).click();
    await wait(() => !!document.querySelector('[role=dialog]'));
    return document.querySelector('[role=dialog]');
  };
  let dialog = await openCopy();
  assert.equal(dialog.querySelector('input[type=password]').value, source.apiKey);
  assert.equal(button('删除', dialog), undefined);
  button('取消', dialog).click();
  assert.equal((await db.all('connections')).length, 1);

  const originalFetch = globalThis.fetch;
  const outgoing = [];
  globalThis.fetch = (url, init) => {
    outgoing.push({url, auth: init.headers.Authorization});
    if (url.endsWith('/models')) return new Response(JSON.stringify({data:[{id:'second-model'}]}));
    return originalFetch(url, init);
  };
  dialog = await openCopy();
  button('获取模型列表', dialog).click();
  await wait(() => !!button('second-model'));
  button('second-model').click();
  await wait(() => dialog.querySelector('input[list]').value === 'second-model');
  button('保存副本', dialog).click();
  await wait(() => !document.querySelector('[role=dialog]'));
  const copy = (await db.all('connections')).find(c => c.id !== source.id);
  assert.equal(copy.model, 'second-model');
  assert.equal(copy.viaRelay, true);
  assert.deepEqual(await db.get('connections',source.id), source);
  assert.equal(await db.kvGet('defaultConn',null), null);
  assert.ok((await exportAll()).connections.every(c => !c.apiKey));

  root.replaceChildren();
  const dispose = await play.render(root,{id:story.id});
  try {
    const chip = root.querySelector('.model-chip');
    assert.equal(chip.textContent, source.name);
    chip.click();
    const copiedModel = () => [...document.querySelectorAll('[role=dialog] .menu-list button')].find(b => b.firstChild.textContent === 'second-model');
    await wait(copiedModel);
    copiedModel().click();
    await wait(() => chip.textContent === 'second-model');
    button('继续').click();
    await wait(() => requests.length === 1 && !dispose.busy());
    assert.equal(requests[0].body.model, 'second-model');
    assert.deepEqual(outgoing, [
      {url:source.baseUrl + '/models', auth:'Bearer ' + source.apiKey},
      {url:source.baseUrl + '/chat/completions', auth:'Bearer ' + source.apiKey},
    ]);
  } finally { dispose(); }
});

test('复制 Vertex 连接保留服务账号 JSON 和地区', async () => {
  const key = JSON.stringify({type:'service_account',private_key:'fake-key',project_id:'fake-project',client_email:'test@example.test'});
  await db.put('connections',{id:'qa-conn',format:'vertex',apiKey:key,model:'first-model',region:'us-central1',mt8000:true});
  await db.kvSet('defaultConn', 'qa-conn');
  await settings.render(root,{});
  button('复制连接', root).click();
  await wait(() => !!document.querySelector('[role=dialog]'));
  const dialog = document.querySelector('[role=dialog]');
  assert.equal(dialog.querySelector('textarea').value, key);
  button('获取模型列表', dialog).click();
  await wait(() => !!button('gemini-4-neon'));
  assert.ok(document.body.textContent.includes('显示内置候选'));
  button('gemini-4-neon').click();
  await wait(() => dialog.querySelector('input[list]').value === 'gemini-4-neon');
  button('保存副本',dialog).click();
  await wait(() => !document.querySelector('[role=dialog]'));
  const copy = (await db.all('connections')).find(c => c.id !== 'qa-conn');
  assert.equal(copy.format, 'vertex');
  assert.equal(copy.apiKey, key);
  assert.equal(copy.region, 'us-central1');
  assert.equal(copy.model, 'gemini-4-neon');
  assert.equal(await db.kvGet('defaultConn',null), 'qa-conn');
});

test('故事批量开关不修改另一个故事的启用状态',async()=>{
  const {story}=await seedStory();const {mods}=await importMarkdownPack('## 一\n规则一\n## 二\n规则二','规则.md');
  await db.put('stories',{...story,id:'other-story',modules:{[mods[0].id]:true}});
  const dispose=await storyView.render(root,{id:story.id,tab:'rules'});
  try {await wait(()=>!!button('全部开启'));button('全部开启').click();await wait(async()=>(await db.get('stories',story.id)).modules[mods[1].id]);
    assert.deepEqual((await db.get('stories','other-story')).modules,{[mods[0].id]:true});
  } finally {dispose();}
});

const sampleCard={spec:'chara_card_v3',spec_version:'3.0',data:{name:'测试人物',description:'成年人物，擅长设计。',personality:'说话直接',scenario:'工作室初见',first_mes:'你好。',character_book:{entries:[{comment:'城市',content:'故事发生在架空城市。',constant:true,enabled:true}]},extensions:{regex_scripts:[{scriptName:'界面',replaceString:'<script>notExecutable()</script>'}]}}};
function pngCard(kind='tEXt') {
  const json=Buffer.from(JSON.stringify(sampleCard)).toString('base64');
  let payload=Buffer.concat([Buffer.from('ccv3\0'),Buffer.from(json)]);
  if(kind==='zTXt')payload=Buffer.concat([Buffer.from('ccv3\0\0'),deflateSync(Buffer.from(json))]);
  if(kind==='iTXt')payload=Buffer.concat([Buffer.from('ccv3\0\x01\0\0\0'),deflateSync(Buffer.from(json))]);
  const chunk=(type,payload)=>{const out=Buffer.alloc(payload.length+12);out.writeUInt32BE(payload.length);out.write(type,4);payload.copy(out,8);return out;};
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk(kind,payload),chunk('IEND',Buffer.alloc(0))]);
}

test('PNG原始字节与JSON结构可往返，支持三种文字块且不执行脚本',async()=>{
  for(const kind of ['tEXt','zTXt','iTXt']){
    const bytes=pngCard(kind),a=await readAttachment(new File([bytes],'角色.png',{type:'image/png'}));
    assert.deepEqual(Buffer.from(attachmentBytes(a)),bytes);assert.equal(a.cardName,'测试人物');
    assert.equal(a.config.regex,1);assert.equal(a.items[0].json.data.extensions.regex_scripts[0].scriptName,'界面');
    const imported=selectedImport(a);assert.equal(imported.data.description,sampleCard.data.description);
    assert.ok(!imported.data.extensions.regex_scripts);
    a.sections.forEach(s=>s.selected=s.key.startsWith('book:'));
    assert.equal(selectedImport(a).entries.length,1);
  }
  await assert.rejects(readAttachment(new File([new Uint8Array([255,216,255])],'已转换.jpeg')),/原始PNG/);
});

test('讨论附件先本地拆解，发给模型只有勾选的文字；备份保留原始PNG',async()=>{
  const d=newDiscussion('','附件测试');await saveDiscussion(d);
  const dispose=await discussion.render(root,{id:d.id});
  try{
    button('📎 上传并拆卡').click();const input=document.querySelector('input[type=file]');const bytes=pngCard();
    Object.defineProperty(input,'files',{value:[new File([bytes],'角色.png',{type:'image/png'})]});input.dispatchEvent(new Event('change'));
    await wait(()=>root.querySelector('.attachment-card'));
    assert.equal(requests.length,0);
    const omit=root.querySelector('[aria-label="携带 性格"]');omit.checked=false;omit.dispatchEvent(new Event('change'));
    await wait(async()=>!(await getDiscussion(d.id)).pendingAttachments[0].sections.find(s=>s.key==='personality').selected);
    button('发送').click();await wait(()=>requests.length===1&&!dispose.busy());
    const sent=requests[0].body.messages.at(-1).content;
    assert.ok(sent.includes('成年人物，擅长设计。'));assert.ok(!sent.includes('说话直接'));assert.ok(!sent.includes('notExecutable'));
    const saved=await getDiscussion(d.id);assert.deepEqual(Buffer.from(attachmentBytes(saved.messages[0].attachments[0])),bytes);
    const backup=JSON.parse(JSON.stringify(await exportDiscussions()));assert.equal(backup.find(x=>x.id===d.id).messages[0].attachments[0].original,saved.messages[0].attachments[0].original);
    assert.ok(!JSON.stringify(chatMessages(saved)).includes('image_url'));
  }finally{dispose();}
});

test('主角更新只接受有原文依据的状态字段，并隔离分支及保留固定设定',()=>{
  const p={name:'林舟',gender:'男',note:'初始是大学生。'};
  const sources=[{id:'chapter:1',label:'第1章',text:'林舟已经毕业，入职设计公司。'}];
  const changes=reviewProtagonistChanges({changes:[{field:'identity',value:'设计公司职员',evidence:[{source:'chapter:1',quote:'已经毕业，入职设计公司'}]},{field:'name',value:'改名了',evidence:[]},{field:'abilities',value:'获得超能力',evidence:[{source:'chapter:1',quote:'获得超能力'}]}]},sources,{});
  assert.equal(changes.length,2);assert.equal(changes[1].valid,false);
  const next=applyProtagonistChanges(p,changes,'branch-a');assert.equal(next.name,p.name);assert.equal(next.gender,p.gender);assert.equal(next.note,p.note);
  assert.equal(protagonistState(next,[{id:'branch-a'}]).identity.value,'设计公司职员');assert.deepEqual(protagonistState(next,[{id:'branch-b'}]),{});
});

test('主角卡实际整理、审阅保存、撤销，正文上下文读取当前变化',async()=>{
  const {story,nodes}=await seedStory();const dispose=await chars.render(root,{id:story.id});
  try{
    responses.push(JSON.stringify({changes:[{field:'identity',value:'设计公司职员',conflict:false,evidence:[{source:'chapter:1',quote:'林舟已经毕业，入职设计公司。'}]}]}));
    button('根据当前剧情更新').click();await wait(()=>!!button('读取剧情并生成建议'));button('读取剧情并生成建议').click();
    await wait(()=>!button('保存勾选项').disabled);button('保存勾选项').click();
    await wait(async()=>(await db.get('stories',story.id)).protagonist.stateEntries?.length===1);
    const saved=await db.get('stories',story.id);assert.equal(saved.protagonist.name,'林舟');assert.equal(saved.protagonist.note,'初始是大学生。');
    assert.ok(buildContext(saved,nodes).system.includes('设计公司职员'));
    await wait(()=>!!button('撤销上次更新'));button('撤销上次更新').click();await wait(async()=>(await db.get('stories',story.id)).protagonist.stateEntries.length===0);
  }finally{dispose();}
});

test('主角状态默认收起、可记住展开状态，编辑不会触发折叠或改变资料',async()=>{
  const {story}=await seedStory();
  story.protagonist.stateEntries=[{field:'status',value:'已经毕业，正在适应新工作。',sourceNodeId:'a1'}];
  await db.put('stories',story);
  let dispose=await chars.render(root,{id:story.id});
  try{
    const fold=root.querySelector('details.protagonist-state');assert.equal(fold.open,false);
    assert.ok(fold.textContent.includes('已经毕业，正在适应新工作。'));
    fold.open=true;fold.dispatchEvent(new Event('toggle'));
    dispose();root.replaceChildren();dispose=await chars.render(root,{id:story.id});
    assert.equal(root.querySelector('details.protagonist-state').open,true);
    button('编辑',root.querySelector('[data-name="主角"]')).click();
    assert.ok(document.querySelector('[role=dialog]'));
    assert.equal(root.querySelector('details.protagonist-state').open,true);
    assert.deepEqual((await db.get('stories',story.id)).protagonist.stateEntries,story.protagonist.stateEntries);
    assert.equal(requests.length,0);
    button('取消',document.querySelector('[role=dialog]')).click();
  }finally{dispose();}
});

test('关键文字加粗与强调色仅创建文本节点，关闭后去标记并阻止HTML执行',()=>{
  const output=document.createElement('div');output.append(inlineText('他答应**明天回来**，留下==一封信==。<img src=x onerror=alert(1)>'));
  assert.equal(output.querySelector('strong').textContent,'明天回来');assert.equal(output.querySelector('.text-highlight').textContent,'一封信');assert.equal(output.querySelector('img'),null);
  output.replaceChildren(inlineText('**承诺**与==线索==',false));assert.equal(output.textContent,'承诺与线索');assert.equal(output.children.length,0);
});

test('引号内台词柔和配色，与关键词强调独立且不执行HTML',()=>{
  const output=document.createElement('div');
  output.append(inlineText('他问：“你会**明天回来**吗？带着==那封信==。”<script>bad()</script>'));
  const dialogue=output.querySelector('.dialogue-text');
  assert.ok(dialogue);assert.equal(dialogue.querySelector('strong').textContent,'明天回来');
  assert.equal(dialogue.querySelector('.text-highlight').textContent,'那封信');assert.equal(output.querySelector('script'),null);
  output.replaceChildren(inlineText('“**回来**。”',false,true));
  assert.ok(output.querySelector('.dialogue-text'));assert.equal(output.querySelector('strong'),null);
  output.replaceChildren(inlineText('“**回来**。”',true,false));
  assert.equal(output.querySelector('.dialogue-text'),null);assert.ok(output.querySelector('strong'));
  output.replaceChildren(inlineText('“还没有说完'));assert.equal(output.textContent,'“还没有说完');
});


async function seedRelayExtra({pending=true, versions=[]}={}) {
  const {story}=await seedStory();
  const conn=await db.get('connections','qa-conn');await db.put('connections',{...conn,viaRelay:true,stream:true});
  await db.kvSet('relay',{on:true,url:'https://relay.qa.example',token:'virtual-relay-secret'});
  await db.put('extras',{id:'relay-extra',storyId:story.id,tplName:'日记体',request:'写一天的日记',anchorId:'a1',anchorNo:1,length:'mid',cur:0,pending,versions});
  return story;
}
function extraRelayMock(stream) {
  const calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push({url,method:init.method});
    if(url.endsWith('/jobs'))return new Response(JSON.stringify({id:'extra-task'}),{status:201});
    if(init.method==='DELETE')return new Response('{}');
    if(url.includes('/stream?'))return stream(init,calls);
    return new Response(JSON.stringify({state:'done'}));
  };
  return calls;
}
function extraSSE(text,{signal,hang=false}={}) {
  const data='data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:hang?null:'stop'}],usage:hang?undefined:{prompt_tokens:20,completion_tokens:8}})+'\n\n';
  const body=hang?new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(data));signal.addEventListener('abort',()=>c.error(new DOMException('aborted','AbortError')),{once:true});}}):data+'data: [DONE]\n\n';
  return new Response(body,{headers:{'X-Upstream-Status':'200','X-Upstream-Content-Type':'text/event-stream','X-Job-State':hang?'running':'done'}});
}

test('番外先保存后台任务，断线后重进自动接回；不重建任务、不依赖原连接密钥',async()=>{
  const story=await seedRelayExtra();let fail=true;
  const calls=extraRelayMock(async()=>{
    const saved=(await db.get('extras','relay-extra')).versions[0];
    assert.equal(saved.relayJob,'extra-task');assert.equal(saved.relayContext.connection.model,'test');
    assert.ok(!JSON.stringify(saved.relayContext).includes('virtual-key'));
    if(fail)throw new TypeError('offline');return extraSSE('重新接回的完整日记。');
  });
  let dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
  try{
    await wait(()=>!dispose.busy()&&button('接回后台生成'));
    assert.equal(button('重新生成一个版本'),undefined);
    assert.equal(((await db.kvGet('usageLog',[]))||[]).length,0);
    dispose();root.replaceChildren();fail=false;
    await db.del('connections','qa-conn');
    dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
    await wait(()=>!dispose.busy());
    const saved=await db.get('extras','relay-extra');
    assert.equal(saved.versions.length,1);assert.equal(saved.versions[0].text,'重新接回的完整日记。');
    assert.equal(saved.versions[0].status,'done');assert.equal(saved.versions[0].relayJob,undefined);
    assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(calls.filter(c=>c.method==='DELETE').length,0);
    assert.equal(((await db.kvGet('usageLog',[]))||[]).length,1);
  }finally{dispose();}
});

test('番外续写返回前台重连保留原文，重放不重复追加，切走不停止后台任务',async()=>{
  const context={system:'设定',messages:[{role:'user',content:'日记要求'}],info:{totalChars:10,parts:[],chapters:[],cards:[]}};
  const story=await seedRelayExtra({pending:false,versions:[{text:'原本的日记。',status:'done',context,usageN:{input:5,output:4,cached:0}}]});
  let streams=0;
  const calls=extraRelayMock(init=>extraSSE(++streams===1?'续写片段':'续写片段，完整结尾。',{signal:init.signal,hang:streams===1}));
  const dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
  try{
    button('接着当前版本写').click();await wait(()=>root.textContent.includes('续写片段'));
    assert.equal(dispose.busy(),true);
    document.dispatchEvent(new Event('visibilitychange'));
    await wait(()=>!dispose.busy());
    const v=(await db.get('extras','relay-extra')).versions[0];
    assert.equal(v.text,'原本的日记。续写片段，完整结尾。');assert.equal(v.usageN.input,25);assert.equal(v.usageN.output,12);
    assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(calls.filter(c=>c.method==='DELETE').length,0);
    assert.equal(streams,2);
  }finally{dispose();}
});

test('番外手动接回、恢复网络不重复创建，任务过期保留已收正文',async()=>{
  const story=await seedRelayExtra({pending:false,versions:[{text:'已经收到的番外片段。',status:'streaming',relayJob:'extra-task',relayContext:{server:'https://relay.qa.example',base:'',mode:'new',inChars:5,connection:{format:'openai',model:'test',stream:true}}}]});let phase='auth';
  const calls=extraRelayMock(()=>phase==='auth'?new Response('{}',{status:401}):new Response('{}',{status:404}));
  const dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
  try{
    await wait(()=>!dispose.busy()&&button('接回后台生成'));
    const reconnectButton=button('接回后台生成');reconnectButton.click();reconnectButton.click();
    await wait(()=>!dispose.busy());
    assert.equal(calls.filter(c=>c.url.includes('/stream?')).length,2);
    phase='expired';window.dispatchEvent(new Event('online'));await wait(()=>!dispose.busy());
    const v=(await db.get('extras','relay-extra')).versions[0];
    assert.equal(v.error.kind,'relay_expired');assert.equal(v.relayJob,undefined);
    assert.ok(button('重新生成一个版本'));
    assert.equal(v.text,'已经收到的番外片段。');
    assert.equal(calls.filter(c=>c.method==='POST').length,0);
  }finally{dispose();}
});

test('番外主动停止会停止原后台任务，旧版无编号任务给出真实提示',async()=>{
  const story=await seedRelayExtra();
  const calls=extraRelayMock(()=>new Response('{}',{status:401}));
  let dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
  try{
    await wait(()=>!dispose.busy()&&button('停止后台生成'));
    button('停止后台生成').click();await wait(()=>!dispose.busy());
    assert.equal(calls.filter(c=>c.method==='DELETE').length,1);
    assert.equal((await db.get('extras','relay-extra')).versions[0].relayJob,undefined);
    dispose();root.replaceChildren();
    await db.put('extras',{id:'legacy-extra',storyId:story.id,cur:0,versions:[{text:'已收到的旧番外',status:'error',error:{kind:'relay_network',message:'长时间没有响应',hint:'点接回后台生成'}}]});
    dispose=await extras.render(root,{id:story.id,extraId:'legacy-extra'});
    assert.ok(root.textContent.includes('没有保存后台任务编号'));
    assert.ok(root.textContent.includes('已收到的旧番外'));assert.ok(button('接着当前版本写'));
  }finally{dispose();}
});


test('番外断线可自动重试接回，自动重试仅订阅原任务',async()=>{
  const story=await seedRelayExtra();let streams=0;
  const calls=extraRelayMock(()=>{if(++streams===1)throw new TypeError('temporary offline');return extraSSE('网络恢复后的日记。');});
  const dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
  try{
    await wait(()=>root.textContent.includes('网络恢复后的日记。')&&!dispose.busy());
    assert.equal(streams,2);assert.equal(calls.filter(c=>c.method==='POST').length,1);
  }finally{dispose();}
});

test('番外正在生成时离开再重进保留同一版本；主动停止只取消原任务',async()=>{
  const story=await seedRelayExtra();let streams=0;
  const calls=extraRelayMock(init=>extraSSE(++streams===1?'已经收到的片段':'已经收到的片段，接回后内容。',{signal:init.signal,hang:true}));
  let dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
  try{
    await wait(()=>root.textContent.includes('已经收到的片段'));
    dispose();await wait(()=>!dispose.busy());
    assert.equal(calls.filter(c=>c.method==='DELETE').length,0);
    assert.equal((await db.get('extras','relay-extra')).versions[0].relayJob,'extra-task');
    root.replaceChildren();dispose=await extras.render(root,{id:story.id,extraId:'relay-extra'});
    await wait(()=>root.textContent.includes('接回后内容'));
    button('停止').click();await wait(()=>!dispose.busy());
    const saved=await db.get('extras','relay-extra');
    assert.equal(saved.versions.length,1);assert.equal(saved.versions[0].text,'已经收到的片段，接回后内容。');
    assert.equal(saved.versions[0].status,'partial');assert.equal(saved.versions[0].relayJob,undefined);
    assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(calls.filter(c=>c.method==='DELETE').length,1);
  }finally{dispose();}
});

test('四个玩法升级仅补一次，保留自定义模板与后续删除、修改',async()=>{
  const {getTemplates,saveTemplates}=await import('../js/fanwai.js');
  await db.kvSet('fwTemplates',[{id:'custom',name:'我的写法',scope:'char',text:'保持我的写法'}]);
  const list=await getTemplates();assert.equal(list.length,5);assert.equal(list[0].text,'保持我的写法');
  assert.ok(list.some(t=>t.name==='一起参加恋综'));assert.ok(list.every(t=>t.text));
  const kept=list.filter(t=>t.name!=='他的聊天记录');kept[1].text='自己编辑后的要求';await saveTemplates(kept);
  const again=await getTemplates();assert.equal(again.length,4);assert.equal(again[1].text,'自己编辑后的要求');
});

test('玩法快照仅取锚点前最近三章，带子类与自由扩展，空素材报告不得编造评分',async()=>{
  const {buildExtraContext,builtinTemplates}=await import('../js/fanwai.js');
  const {story}=await seedStory();const template=builtinTemplates().find(t=>t.name==='恋爱脑报告');
  const chapters=[1,2,3,4,5].map(no=>({no,id:'chapter-'+no,title:'事件'+no,said:'行动'+no,text:'第'+no+'章独有事件'}));
  const make=anchorNo=>buildExtraContext(story,{template,chapters,anchorNo,recentN:0,variant:'观察侧重：日程让步'});
  const a=make(3),b=make(4);
  assert.deepEqual(a.info.snapshotChapters,[1,2,3]);assert.deepEqual(b.info.snapshotChapters,[2,3,4]);
  assert.ok(!a.system.includes('第4章独有事件'));assert.ok(b.system.includes('第4章独有事件'));
  assert.ok(a.system.includes('自由扩展'));assert.ok(a.system.includes('观察侧重：日程让步'));assert.ok(a.system.includes('资料不足'));
  assert.notEqual(a.system,b.system);
  const empty=make(0);assert.ok(empty.system.includes('没有可评分的历史事件'));
});

test('六种材料本地排版保留内容，缺失标记回退；HTML与链接不执行、不加载',async()=>{
  const {renderExtraLayout,parseExtraLayout}=await import('../js/extra-layout.js');
  const {samples}=await import('./extra-samples.js');
  for(const text of Object.values(samples)){
    const out=renderExtraLayout(text);assert.ok(out.querySelector('.ex-block'));assert.ok(out.textContent.length>80);
    assert.equal(out.querySelector('img,script,iframe'),null);
  }
  const report=renderExtraLayout(samples['恋爱脑报告']);assert.equal(report.querySelectorAll('progress').length,3);
  assert.equal(report.querySelector('progress').value,87);
  const chat=renderExtraLayout(samples['他的聊天记录']);assert.ok(chat.querySelector('.mine .ex-bubble'));assert.ok(chat.textContent.includes('撤回'));
  const forum=renderExtraLayout(samples['论坛体']);assert.ok(forum.querySelector('.ex-op'));assert.ok(forum.querySelector('.ex-quote'));assert.ok(forum.querySelector('.hot'));
  const broken='【聊天】\n会话｜未完成\n我｜测试｜<img src=x onerror=alert(1)>\n消息还没写完';
  const fallback=renderExtraLayout(broken);assert.ok(fallback.querySelector('.ex-chat'));assert.ok(fallback.textContent.includes('<img src=x onerror=alert(1)>\n消息还没写完'));assert.equal(fallback.querySelector('img'),null);
  const fragment='【聊天】\n会话｜还没有消息';assert.equal(renderExtraLayout(fragment).textContent,fragment);
  const invalid=renderExtraLayout('【报告】\n指数｜破坏测试｜9999｜<script>bad()</script>｜http://example.test\n【/】');
  assert.equal(invalid.querySelector('progress'),null);assert.ok(invalid.textContent.includes('未评分'));assert.equal(invalid.querySelector('script,a'),null);
  const nested='【论坛】\n楼主｜甲｜今天｜内容\n【聊天】\n他｜乙｜你好\n【/】';
  assert.deepEqual(parseExtraLayout(nested).map(b=>b.type),['论坛','聊天']);assert.ok(renderExtraLayout(nested).textContent.includes('你好'));
});

test('番外实际创建可选自定义子类，生成五类布局，原文切换后文字不丢失；新旧版本续写沿用素材',async()=>{
  const {samples}=await import('./extra-samples.js');const {story}=await seedStory();
  await extras.render(root,{id:story.id});button('✦ 写一篇番外').click();await wait(()=>!!document.querySelector('[role=dialog] select'));
  const dialog=document.querySelector('[role=dialog]'),type=dialog.querySelector('select');
  for(const name of ['一起参加恋综','他的聊天记录','我跟你的同人文','恋爱脑报告'])assert.ok([...type.options].some(o=>o.text===name));
  type.value='playbook-fic';type.dispatchEvent(new Event('change'));
  dialog.querySelector('[aria-label="题材"]').value='星际';dialog.querySelector('[aria-label="平台"]').value='AO3';dialog.querySelector('[aria-label="自定义子类"]').value='船舱便签';
  button('开始写',dialog).click();await wait(async()=>(await db.extrasOf(story.id)).length===1);
  const x=(await db.extrasOf(story.id))[0];assert.equal(x.layout,'fic');assert.ok(x.variant.includes('船舱便签'));assert.ok(x.variant.includes('星际'));
  responses.push(samples['我跟你的同人文']);root.replaceChildren();const dispose=await extras.render(root,{id:story.id,extraId:x.id});
  try{
    await wait(()=>!dispose.busy());assert.equal(requests.length,1);assert.ok(root.querySelector('.ex-fic'));assert.ok(root.querySelector('.ex-forum'));
    const v=(await db.get('extras',x.id)).versions[0];assert.equal(v.layoutVersion,1);
    button('原文').click();assert.equal(root.querySelector('.extra-raw').textContent,samples['我跟你的同人文']);
    button('排版').click();assert.ok(root.querySelector('.ex-fic'));
    responses.push('\n\n【场景】\n他把新的便签递了过来。\n【/】');button('接着当前版本写').click();await wait(()=>!dispose.busy()&&requests.length===2);
    assert.equal(requests[0].body.messages[0].content,requests[1].body.messages[0].content);
    assert.ok((await db.get('extras',x.id)).versions[0].text.endsWith('【/】'));
  }finally{dispose();}
});

async function openExtraForm(story,template) {
  root.replaceChildren();await extras.render(root,{id:story.id});button('✦ 写一篇番外').click();
  await wait(()=>!!document.querySelector('[role=dialog] select'));
  const dialog=document.querySelector('[role=dialog]'),select=dialog.querySelector('select');
  select.value=template;select.dispatchEvent(new Event('change'));return dialog;
}

test('聊天与报告无子类菜单；记录主人、报告对象和报告人各自保存，选中角色卡进入上下文',async()=>{
  const {story}=await seedStory();story.cards=[{id:'c1',name:'许秋',initial:'出版社编辑',publicProfile:'出版社编辑',personality:'讲话直截了当'}];await db.put('stories',story);
  const chat=await openExtraForm(story,'playbook-chat');
  assert.equal([...chat.querySelectorAll('details')].find(d=>d.firstElementChild.textContent.includes('子类')).hidden,true);
  const owner=chat.querySelector('[aria-label="看谁的手机"]');
  assert.ok([...owner.options].some(o=>o.text.includes('主角（你）')));assert.ok([...owner.options].some(o=>o.text==='不同人'));
  owner.value='__self';owner.dispatchEvent(new Event('change'));button('开始写',chat).click();
  await wait(async()=>(await db.extrasOf(story.id)).length===1);
  const first=(await db.extrasOf(story.id))[0];assert.equal(first.cast.owner.kind,'self');assert.equal(first.pov,'');assert.equal(first.cast.protagonist.name,'林舟');assert.equal(first.variant,'');
  const report=await openExtraForm(story,'playbook-report');
  assert.equal([...report.querySelectorAll('details')].find(d=>d.firstElementChild.textContent.includes('子类')).hidden,true);
  report.querySelector('[aria-label="看谁的恋爱脑报告"]').value='card-0';
  const writer=report.querySelector('[aria-label="谁写报告"]');writer.value='__named';writer.dispatchEvent(new Event('change'));
  report.querySelector('[aria-label="谁写报告姓名"]').value='夏晚';
  button('开始写',report).click();await wait(async()=>(await db.extrasOf(story.id)).length===2);
  const second=(await db.extrasOf(story.id)).find(x=>x.id!==first.id);
  assert.equal(second.cast.subject.name,'许秋');assert.equal(second.cast.reporter.name,'夏晚');
  responses.push('【报告】\n标题｜观察记录\n总评｜他给你留出了时间。\n【/】');
  root.replaceChildren();const dispose=await extras.render(root,{id:story.id,extraId:second.id});
  try{await wait(()=>!dispose.busy());const system=requests[0].body.messages[0].content;
    assert.ok(system.includes('许秋'));assert.ok(system.includes('出版社编辑'));assert.ok(system.includes('夏晚'));
    assert.ok(system.includes('完整报告'));assert.ok(root.querySelector('.ex-report-document'));assert.ok(root.textContent.includes('谁写报告：夏晚'));
  }finally{dispose();}
});

test('恋综随行人支持角色多选和手填，所有选中的人物都进入生成快照',async()=>{
  const {story}=await seedStory();story.cards=[{id:'c1',name:'许秋',initial:'出版社编辑'},{id:'c2',name:'陆明',initial:'热爱露营'}];await db.put('stories',story);
  const dialog=await openExtraForm(story,'playbook-show');
  assert.equal(dialog.querySelector('[aria-label="视角角色"]').closest('.field').hidden,true);
  dialog.querySelector('[aria-label="随行人：许秋"]').checked=true;dialog.querySelector('[aria-label="随行人：陆明"]').checked=true;
  dialog.querySelector('[aria-label="其他随行人"]').value='夏晚、许秋';
  button('开始写',dialog).click();await wait(async()=>(await db.extrasOf(story.id)).length===1);
  const x=(await db.extrasOf(story.id))[0];assert.deepEqual(x.cast.companions.map(p=>p.name),['许秋','陆明','夏晚']);assert.equal(x.cast.owner,undefined);
  const {buildExtraContext}=await import('../js/fanwai.js');
  const ctx=buildExtraContext(story,{chapters:[],anchorNo:0,template:{name:x.tplName,text:x.tplText,layout:x.layout},cast:x.cast});
  assert.ok(ctx.system.includes('出版社编辑'));assert.ok(ctx.system.includes('热爱露营'));assert.ok(ctx.system.includes('夏晚'));assert.ok(ctx.system.includes('主角默认参与'));
});

test('番外独立API贯穿新建重写续写，显式切换后生效，删除连接不回退正文API',async()=>{
  const {story}=await seedStory();story.connectionId='qa-conn';await db.put('stories',story);
  await db.put('connections',{id:'extra-api',name:'番外专用',format:'openai',baseUrl:'https://extra.qa.example/v1',apiKey:'virtual-extra-key',model:'extra-test',stream:false});
  const dialog=await openExtraForm(story,'playbook-chat');dialog.querySelector('[aria-label="番外 API"]').value='extra-api';
  button('开始写',dialog).click();await wait(async()=>(await db.extrasOf(story.id)).length===1);
  const x=(await db.extrasOf(story.id))[0];assert.equal(x.connectionId,'extra-api');assert.equal(await db.kvGet('extraConnectionId',''),'extra-api');
  responses.push('第一篇文字','接着写的文字','重新生成的文字');root.replaceChildren();const dispose=await extras.render(root,{id:story.id,extraId:x.id});
  try{
    await wait(()=>!dispose.busy());button('接着当前版本写').click();await wait(()=>!dispose.busy()&&requests.length===2);
    button('重新生成一个版本').click();await wait(()=>!dispose.busy()&&requests.length===3);
    assert.ok(requests.every(r=>r.url==='https://extra.qa.example/v1/chat/completions'));
    const saved=await db.get('extras',x.id);assert.ok(saved.versions.every(v=>v.connectionId==='extra-api'));
    await db.del('connections','extra-api');button('接着当前版本写').click();await wait(()=>!dispose.busy());assert.equal(requests.length,3);
    root.querySelector('[aria-label="选择番外 API"]').click();await wait(()=>!!document.querySelector('.menu-list button'));
    document.querySelector('.menu-list button').click();await wait(async()=>(await db.get('extras',x.id)).connectionId==='qa-conn');
    button('接着当前版本写').click();await wait(()=>!dispose.busy()&&requests.length===4);
    assert.equal(requests[3].url,'https://model.qa.example/v1/chat/completions');assert.equal((await db.get('stories',story.id)).connectionId,'qa-conn');
  }finally{dispose();}
});

test('连续聊天消息不重复昵称，节目弹幕静态换行，报告是统一文档布局',async()=>{
  const {renderExtraLayout}=await import('../js/extra-layout.js');
  const chat=renderExtraLayout('【聊天】\n会话｜测试\n我｜林舟｜第一句\n我｜林舟｜第二句\n他｜许秋｜回答\n【/】');
  assert.equal(chat.querySelectorAll('.ex-message .ex-time').length,2);assert.equal(chat.querySelectorAll('.consecutive').length,1);
  const show=renderExtraLayout('【节目】\n弹幕｜观众一｜第一条\n弹幕｜观众二｜第二条\n【/】');root.append(show);
  assert.equal(show.querySelector('.ex-danmu').getAttribute('aria-label'),'节目弹幕');
  // 样式来自本测试进程加载的实际CSS。
  assert.equal(getComputedStyle(show.querySelector('.ex-danmu')).overflow,'visible');
  const report=renderExtraLayout('【报告】\n标题｜报告\n总评｜完整的总评\n现场｜新的现场\n处方｜下次见。\n【/】',{reportMode:true});
  assert.ok(report.classList.contains('ex-report-document'));assert.ok(report.textContent.includes('新的现场'));
});

test('保存过的玩法模板只补一次新版要求，用户改写的内容保留',async()=>{
  const {getTemplates,saveTemplates}=await import('../js/fanwai.js');
  await db.kvSet('fwPlaybooksV1',true);
  await db.kvSet('fwTemplates',[{id:'playbook-chat',name:'他的聊天记录',scope:'all',text:'我自己补充的口吻要求'}]);
  const list=await getTemplates();assert.equal(list.length,1);assert.ok(list[0].text.startsWith('我自己补充的口吻要求'));assert.ok(list[0].text.includes('新版记录要求'));
  const text=list[0].text;assert.equal((await getTemplates())[0].text,text);
  list[0].text='我又重新编辑了';await saveTemplates(list);assert.equal((await getTemplates())[0].text,'我又重新编辑了');
});

test('番外列表停留期间新增角色后，打开表单仍能直接选择最新全部角色卡',async()=>{
  const {story}=await seedStory();await extras.render(root,{id:story.id});
  const updated={...story,cards:[{id:'first',name:'郁黎安',publicProfile:'建筑师，克制'},{id:'second',name:'许秋',initial:'编辑，讲话直接'}]};
  await db.put('stories',updated);
  button('✦ 写一篇番外').click();await wait(()=>!!document.querySelector('[role=dialog] select'));
  const dialog=document.querySelector('[role=dialog]'),type=dialog.querySelector('select');
  for(const [id,label] of [['playbook-chat','看谁的手机'],['playbook-report','看谁的恋爱脑报告'],['playbook-fic','和谁的同人文']]){
    type.value=id;type.dispatchEvent(new Event('change'));
    const select=dialog.querySelector(`[aria-label="${label}"]`);const texts=[...select.options].map(o=>o.textContent);
    assert.ok(texts.includes('郁黎安'));assert.ok(texts.includes('许秋'));
    assert.ok(texts.indexOf('许秋')<texts.indexOf('不同人'));
    assert.equal(select.querySelector('optgroup').label,'角色卡');
    if(id==='playbook-fic')assert.ok(!texts.some(t=>t.includes('主角（你）')));
    else assert.ok(texts[1].includes('主角（你）'));
  }
  type.value='playbook-report';type.dispatchEvent(new Event('change'));
  const reporter=dialog.querySelector('[aria-label="谁写报告"]');assert.ok(![...reporter.options].some(o=>o.text==='不同人'));assert.ok([...reporter.options].some(o=>o.text==='郁黎安'));
  type.value='playbook-show';type.dispatchEvent(new Event('change'));
  assert.ok(dialog.querySelector('[aria-label="随行人：郁黎安"]'));assert.ok(dialog.querySelector('[aria-label="随行人：许秋"]'));
  button('取消',dialog).click();assert.equal(requests.length,0);
});

test('同人选择的是主角的关系对象，报告作者独立，不能把对方当主角或叙述者',async()=>{
  const {buildExtraContext,builtinTemplates}=await import('../js/fanwai.js');
  const {castText}=await import('../js/extra-options.js');
  const {story}=await seedStory();story.cards=[{id:'partner',name:'郁黎安',publicProfile:'建筑师，克制'},{id:'writer',name:'许秋',initial:'编辑，讲话直接'}];
  const protagonist={kind:'self',name:'林舟'},target={kind:'character',cardId:'partner',name:'郁黎安'},reporter={kind:'character',cardId:'writer',name:'许秋'};
  const ficCast={version:3,protagonist,partner:target};
  const ctx=buildExtraContext(story,{chapters:[],anchorNo:0,scope:'char',template:builtinTemplates().find(t=>t.layout==='fic'),cast:ficCast});
  assert.ok(ctx.system.includes('林舟＋郁黎安'));assert.ok(ctx.system.includes('不是叙述视角或作者'));assert.ok(!ctx.system.includes('以郁黎安的视角写'));assert.ok(ctx.system.includes('建筑师，克制'));
  const r=castText({version:3,protagonist,subject:target,reporter},'report');
  assert.ok(r.includes('看谁的恋爱脑报告】郁黎安'));assert.ok(r.includes('谁写报告】许秋'));assert.ok(r.includes('与林舟的关系'));
  const chat=castText({version:3,protagonist,owner:target},'chat');assert.ok(chat.includes('玩家主角始终是林舟'));assert.ok(chat.includes('各组会话来自同一位手机主人'));
  const mixed=castText({version:3,protagonist,partner:{kind:'mixed'}},'fic');assert.ok(mixed.includes('各篇分别'));assert.ok(mixed.includes('不混成多人共同恋爱'));
});

test('聊天用文字头像与窄气泡，混合材料仍归属于同一篇完整报告',async()=>{
  const {renderExtraLayout}=await import('../js/extra-layout.js');
  const text='【报告】\n标题｜完整观察报告\n总评｜从一场接人开始。\n【/】\n【聊天】\n会话｜证据一\n我｜郁黎安｜已经出发。\n我｜郁黎安｜你等我。\n他｜林舟｜好。\n【/】\n【论坛】\n标题｜旁观记录\n楼主｜许秋｜今天｜他确实绕路了。\n【/】\n【节目】\n采访｜郁黎安｜顺路而已。\n【/】\n【同人】\n标题｜猜测\n正文｜网友猜错了他的理由。\n【/】\n【报告】\n结语｜以上材料共同解释了这次例外。\n处方｜下次别等雨停，等我。\n【/】';
  const doc=renderExtraLayout(text,{reportMode:true});root.append(doc);
  for(const type of ['chat','forum','show','fic'])assert.ok(doc.querySelector('.ex-'+type));
  assert.equal(doc.querySelectorAll('.ex-fallback').length,0);assert.ok(doc.textContent.includes('共同解释'));
  const bubbles=doc.querySelectorAll('.ex-bubble');assert.equal(getComputedStyle(bubbles[0]).maxWidth,'79%');assert.equal(getComputedStyle(bubbles[0]).fontSize,'12px');
  assert.equal(doc.querySelectorAll('.ex-chat-avatar').length,2);assert.equal(doc.querySelectorAll('img').length,0);
  assert.equal(getComputedStyle(doc.querySelector('.ex-chat-avatar')).width,'22px');
});


test('模型省略闭合、使用扩展材料或格式变体时逐块恢复，不让其余材料丢失排版',async()=>{
  const {renderExtraLayout,parseExtraLayout}=await import('../js/extra-layout.js');
  const text=`# 现场记录
【节目】
环节｜互猜习惯｜你接过答题器。
字幕｜回答正确
郁黎安｜我记得。
弹幕｜只关心晚饭｜这题怎么记得这么清楚？
【场景】
你转过头看他。
【/】
**【聊天记录】**
会话 │ 他的工作群
手机主人｜郁黎安
我｜不爱画直线｜已经到了。
他｜钢结构不背锅｜收到。
【备忘录】
标题｜周三的安排
时间｜今天 01:23
1. 提前出门。
2. 带上热茶。
【／】
【同人文】
标题｜下班以后
作者｜夜航编辑
正文｜林舟收起了信，许秋先移开目光。
【/同人文】
[评论区]
#1｜只关心晚饭｜今天｜这段像真的。
[/评论区]`;
  const out=renderExtraLayout(text);
  for(const cls of ['show','chat','note','fic','forum'])assert.ok(out.querySelector('.ex-'+cls),cls);
  for(const phrase of ['你接过答题器','我记得','你转过头','已经到了','钢结构不背锅','提前出门','带上热茶','许秋先移开目光','这段像真的'])assert.ok(out.textContent.includes(phrase),phrase);
  assert.equal(out.querySelector('.ex-fallback'),null);assert.equal(parseExtraLayout(text).filter(b=>b.recovered).length,2);
  assert.equal(out.querySelector('img,script,a'),null);
});

test('热评可省略时间、点赞带标签并换行写内容；未知栏目与昵称不吞字',async()=>{
  const {renderExtraLayout}=await import('../js/extra-layout.js');
  const out=renderExtraLayout(`【论坛】
标题｜施工现场
#1｜钢结构不背锅｜今日14:13｜先把图纸看完。
热评｜#4｜不喝蜂蜜水｜点赞 89｜

划重点：他亲自端了热茶。
【/】
【聊天】
会话｜工作群
备注｜钢结构不背锅｜周既白
钢结构不背锅｜14:18｜明天见。
【/】
【同人】
作者的话｜这个结尾留给你们。
正文｜林舟没有回头。
【/】`);
  const hot=out.querySelectorAll('.ex-post')[1];assert.ok(hot.querySelector('.hot'));assert.equal(hot.querySelector('.ex-author').textContent,'不喝蜂蜜水');
  assert.equal(hot.querySelector('.ex-likes').textContent,'赞 89');assert.ok(hot.querySelector('.ex-body').textContent.includes('他亲自端了热茶'));
  assert.equal(out.querySelector('.ex-bubble').textContent,'明天见。');assert.equal(out.querySelector('.ex-chat-note').textContent,'钢结构不背锅 · 周既白');assert.ok(out.querySelector('.ex-fic .ex-callout').textContent.includes('作者的话'));assert.ok(out.textContent.includes('这个结尾留给你们'));
});

test('报告撰写口吻与收报告现场、手机阅读人称、同人内外人称同时进入最终指令',async()=>{
  const {buildExtraContext,builtinTemplates}=await import('../js/fanwai.js');
  const {story}=await seedStory();story.cards=[{name:'未登场的同事',initial:'工程师，讲话精确'}];
  const chapters=[{no:1,id:'chapter-one',title:'初次见面',text:'你收到他留的便条。'}];
  const make=(layout,cast)=>buildExtraContext(story,{chapters,anchorNo:1,template:builtinTemplates().find(t=>t.layout===layout),cast});
  const cast={version:3,protagonist:{kind:'self',name:'林舟'},owner:{kind:'character',name:'许秋'}};
  const chat=make('chat',cast);assert.ok(chat.system.includes('以“你”代指玩家主角'));assert.ok(chat.system.includes('先写你在何种场景'));assert.ok(chat.system.includes('网名或备注'));
  assert.ok(chat.info.cards.includes('未登场的同事'));assert.ok(chat.system.includes('正文尚未出场'));assert.ok(chat.info.parts.find(p=>p.label==='当前叙事修订（优先于旧模板冲突条款）').text.endsWith('必须有看到手机的场景。'));
  const mixed=make('chat',{...cast,owner:{kind:'mixed'}});assert.ok(mixed.info.parts.find(p=>p.label==='当前叙事修订（优先于旧模板冲突条款）').text.endsWith('分别标明各手机主人。'));
  const report=make('report',{...cast,subject:cast.owner,reporter:{kind:'character',name:'未登场的同事'}});
  assert.ok(report.system.includes('开篇必须先写“你”收到'));assert.ok(report.system.includes('以撰写人自己的口吻'));assert.ok(report.system.includes('不能写进可见报告'));assert.ok(report.system.includes('自行判断被报告人是否在场'));assert.ok(report.system.includes('若他没看到则不强加读后反应'));
  assert.ok(!report.system.includes('证据注明素材章节或原文短句'));assert.ok(!report.system.includes('章节及具体证据'));
  const fic=make('fic',{...cast,partner:cast.owner});assert.ok(fic.system.includes('同人作品内部以第三人称'));assert.ok(fic.system.includes('现实场景必须以“你”'));assert.ok(fic.system.includes('甚至亲自写同人'));assert.ok(fic.info.cards.includes('未登场的同事'));
});

test('已保存第三版模板升级口吻但不删除自定义内容，旧番外重写仍收到最新修订',async()=>{
  const {getTemplates,buildExtraContext}=await import('../js/fanwai.js');
  const {story}=await seedStory();
  const oldText='我补充的要求。证据注明素材章节或原文短句，不能为凑分捏造正史。';
  await db.kvSet('fwPlaybooksV1',true);await db.kvSet('fwTemplates',[{id:'playbook-report',name:'恋爱脑报告',layout:'report',playbookRevision:3,text:oldText}]);
  const list=await getTemplates();assert.equal(list[0].playbookRevision,5);assert.ok(list[0].text.startsWith('我补充的要求。'));assert.ok(!list[0].text.includes('证据注明素材章节或原文短句'));
  assert.ok(list[0].text.includes('开篇必须先写'));assert.equal((await getTemplates())[0].text,list[0].text);
  const ctx=buildExtraContext(story,{chapters:[],anchorNo:0,template:{name:'恋爱脑报告',layout:'report',text:oldText}});
  assert.ok(ctx.info.parts.find(p=>p.label==='当前叙事修订（优先于旧模板冲突条款）').text.includes('绝不能写进可见报告'));assert.equal(ctx.info.parts.at(-1).label,'最终输出要求');
});

test('恋综对白在无外层标记和场景内均排版，片段与弹幕保持发生顺序',async()=>{
  const {renderExtraLayout}=await import('../js/extra-layout.js');
  const text=`你们装作初次见面的嘉宾。

对白 | 许秋 | （放下茶杯）“你做什么工作？”

你转过身，把杯子推过去。

【场景】
对白｜你｜“写字。”
字幕｜这个回答有点敷衍
观察室｜今天也不交稿｜他刚刚在笑。
【/】
【节目】
环节｜答案揭晓｜片段之前
弹幕｜快门比嘴快｜弹幕在这里
对白｜许秋｜“我知道。”
规则｜收工｜片段之后
【/】`;
  const out=renderExtraLayout(text,{layout:'show'});root.append(out);
  assert.equal(out.querySelectorAll('.ex-show-dialogue').length,3);
  for(const s of ['你们装作初次见面','你转过身','这个回答有点敷衍','他刚刚在笑','我知道'])assert.ok(out.textContent.includes(s));
  assert.ok(!out.textContent.includes('对白｜'));assert.ok(!out.textContent.includes('对白 |'));
  const main=out.querySelector('.ex-show').textContent;assert.ok(main.indexOf('片段之前')<main.indexOf('弹幕在这里'));assert.ok(main.indexOf('弹幕在这里')<main.indexOf('我知道'));assert.ok(main.indexOf('我知道')<main.indexOf('片段之后'));
  assert.equal(getComputedStyle(out.querySelector('.ex-danmu')).overflow,'visible');
  const novel=renderExtraLayout('对白｜甲｜这是小说里引用的格式。');assert.equal(novel.querySelector('.ex-show-dialogue'),null);
});

test('同人每篇评论嵌在本篇正文下面，独立论坛仍是独立帖子',async()=>{
  const {renderExtraLayout}=await import('../js/extra-layout.js');
  const text=['第一篇','第二篇','第三篇'].map((name,i)=>`【同人】\n标题｜${name}\n正文｜故事${i}\n【/】\n【评论区】\n标题｜${name}评论区\n#1｜读者${i}｜今天｜评论${i}\n【/】`).join('\n')+'\n【场景】\n你把手机递了过去。\n【/】\n【论坛】\n标题｜独立吃瓜帖\n楼主｜另一个人｜今天｜另一个话题\n【/】';
  const out=renderExtraLayout(text);root.append(out);
  assert.equal(out.querySelectorAll('.ex-fic').length,3);assert.equal(out.querySelectorAll('.ex-fic > .ex-fic-comments').length,3);
  [...out.querySelectorAll('.ex-fic')].forEach((fic,i)=>{assert.ok(fic.querySelector('.ex-fic-text').textContent.includes('故事'+i));assert.ok(fic.querySelector('.ex-fic-comments').textContent.includes('评论'+i));assert.equal(fic.querySelector('.ex-fic-comments .ex-eyebrow'),null);assert.ok(!fic.querySelector('.ex-fic-comments').classList.contains('ex-block'));});
  assert.equal(out.querySelectorAll(':scope > .ex-forum').length,1);assert.ok(out.querySelector(':scope > .ex-forum').textContent.includes('独立吃瓜帖'));
});

test('报告内聊天比普通聊天更小，字号不被放大的正文覆盖，强调与台词仍保留',async()=>{
  const {renderExtraLayout}=await import('../js/extra-layout.js');
  const text='【聊天】\n会话｜证据\n我｜截稿不交稿｜“**我记得**。”\n他｜快门比嘴快｜行。\n【/】';
  const host=document.createElement('div');host.className='gm';host.style.fontSize='28px';root.append(host);
  const report=renderExtraLayout(text,{reportMode:true}),chat=renderExtraLayout(text);host.append(report,chat);
  assert.equal(getComputedStyle(report.querySelector('.ex-bubble')).fontSize,'12px');assert.equal(getComputedStyle(chat.querySelector('.ex-bubble')).fontSize,'13px');
  assert.equal(getComputedStyle(report.querySelector('.ex-chat-head')).fontSize,'12px');assert.ok(report.querySelector('.ex-bubble .dialogue-text strong'));assert.ok(report.textContent.includes('截稿不交稿'));
});

test('三篇大跨度同人与所有番外网名、手机末尾未读彩蛋写入指令并迁移旧模板',async()=>{
  const {buildExtraContext,builtinTemplates,getTemplates}=await import('../js/fanwai.js');
  const {story}=await seedStory();const make=layout=>buildExtraContext(story,{chapters:[],anchorNo:0,template:builtinTemplates().find(t=>t.layout===layout)});
  const fic=make('fic');assert.ok(fic.system.includes('每次必须恰好三篇'));assert.ok(fic.system.includes('至少三个维度拉开距离'));assert.ok(fic.system.includes('用户指定题材时遵守指定'));assert.ok(fic.system.includes('故意OOC'));assert.ok(fic.system.includes('紧接该【同人】块'));
  const chat=make('chat');assert.ok(chat.system.includes('你没有看到的记录'));assert.ok(chat.system.includes('主角尚不知道'));assert.ok(chat.system.includes('不把它变成已发生的正史'));
  for(const template of [...builtinTemplates(),{name:'自定义',text:'写一个日常'}]){
    const ctx=buildExtraContext(story,{chapters:[],anchorNo:0,template});assert.ok(ctx.system.includes('所有番外的网名与备注'));assert.ok(ctx.system.includes('脑洞大'));
  }
  await db.kvSet('fwPlaybooksV1',true);await db.kvSet('fwTemplates',[{id:'playbook-fic',name:'我跟你的同人文',playbookRevision:4,text:'保留我的要求。写2—3篇差异明显的网友同人及本人读后现场'}]);
  const list=await getTemplates();assert.equal(list[0].playbookRevision,5);assert.ok(list[0].text.startsWith('保留我的要求'));assert.ok(!list[0].text.includes('写2—3篇'));assert.ok(list[0].text.includes('每次必须恰好三篇'));assert.equal((await getTemplates())[0].text,list[0].text);
});

test('实际番外阅读按保存的恋综形式修复没有节目块的对白，原文切换保留所有字符',async()=>{
  const {story}=await seedStory();const text='# 开场\n\n你端起杯子。\n\n对白｜许秋｜“我来晚了吗？”\n\n你摇了摇头。';
  await db.put('extras',{id:'loose-show',storyId:story.id,tplName:'一起参加恋综',layout:'show',anchorNo:1,cur:0,versions:[{id:'v1',text,status:'done',layoutVersion:1}]});
  const dispose=await extras.render(root,{id:story.id,extraId:'loose-show'});
  try{assert.ok(root.querySelector('.ex-show-dialogue'));assert.ok(root.textContent.includes('你摇了摇头'));button('原文').click();assert.equal(root.querySelector('.extra-raw').textContent,text);button('排版').click();assert.ok(root.querySelector('.ex-show-dialogue'));}finally{dispose();}
});

test('已存档思考标签在正文和番外原文/排版阅读中隐藏，原始存档仍保留',async()=>{
  const {story,nodes}=await seedStory();
  const raw='<think>HIDDEN_SECRET\n【选项】\nA. 错误\nB. 错误</think># 门口\n你打开了门。\n【选项】\nA. 进去\nB. 等待';
  nodes[1].text=raw;await db.put('nodes',nodes[1]);
  const dispose=await play.render(root,{id:story.id});
  try {assert.ok(!root.textContent.includes('HIDDEN_SECRET'));assert.ok(root.textContent.includes('你打开了门'));assert.equal((await db.get('nodes',nodes[1].id)).text,raw);}finally{dispose();}
  await db.put('extras',{id:'tagged-extra',storyId:story.id,tplName:'他的聊天记录',layout:'chat',anchorNo:1,cur:0,versions:[{id:'v1',text:'<think>EXTRA_SECRET</think># 手机\n【聊天】\n我｜许秋｜收到。\n【/】',layoutVersion:1,status:'done'}]});
  root.replaceChildren();const end=await extras.render(root,{id:story.id,extraId:'tagged-extra'});
  try{assert.ok(!root.textContent.includes('EXTRA_SECRET'));assert.ok(root.querySelector('.ex-bubble'));button('原文').click();assert.ok(!root.querySelector('.extra-raw').textContent.includes('EXTRA_SECRET'));assert.ok((await db.get('extras','tagged-extra')).versions[0].text.includes('EXTRA_SECRET'));}finally{end();}
});

test('旧默认整理周期调整到十章，保留关闭、自定义间隔和重新选定的一章', async () => {
  for (const [value, explicit, expected] of [[1,false,10],[15,false,10],[15,true,15],[1,true,1],[0,false,0],[7,false,7]]) {
    await db.put('stories', { id: 'interval', memEvery: value, memEveryExplicit: explicit });
    assert.equal((await db.get('stories', 'interval')).memEvery, expected);
    assert.equal((await db.all('stories'))[0].memEvery, expected);
  }
});

test('出戏后可以沿用正文选项或把问答转入讨论', async () => {
  const { story } = await seedStory();
  const dispose = await play.render(root, { id: story.id });
  try {
    button('出戏', root).click();
    const input = root.querySelector('textarea');
    input.value = '他知道这件事吗？';
    responses.push('他只见过信封。');
    root.querySelector('button.send').click();
    await wait(() => button('下一章采用', root));
    root.querySelector('.options button').click();
    assert.equal(input.value, '查看地图');
    button('转到讨论', root).click();
    const saved = (await db.get('stories', story.id)).headId;
    await wait(async () => (await getDiscussion('ooc-' + saved))?.messages.length === 2);
    assert.equal((await getDiscussion('ooc-' + saved)).messages[1].content, '他只见过信封。');
  } finally { dispose(); }
});

test('受限视角没有素材时在真实发送前等待选择，返回时不产生模型请求或空版本', async () => {
  const {story}=await seedStory();
  const extra={id:'no-evidence',storyId:story.id,request:'来一篇论坛帖',scope:'public',tplName:'论坛体',
    anchorId:'a1',anchorNo:1,pending:true,versions:[],cur:0,connectionId:'qa-conn'};
  await db.put('extras', extra);
  const dispose=await extras.render(root,{id:story.id,extraId:extra.id});
  try {
    const back=()=>[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('返回番外册'));
    await wait(back); assert.equal(requests.length,0); back().click();
    await wait(()=>!dispose.busy());
    assert.equal(requests.length,0);
    assert.equal((await db.get('extras',extra.id)).versions.length,0);
  } finally {dispose();}
});

test('旧记忆整合预览、应用、分支回退和还原，保留动机与原档',async()=>{
  const {ensureStructured}=await import('../js/structured-memory.js');
  const {render}=await import('../js/views/memory.js');
  const {story,nodes}=await seedStory();
  const checkpoint={upTo:1,summaries:[{from:1,to:1,text:'嘉树每天站柜台。贺嘉衡想让他学会接待顾客。'}]};
  ensureStructured(checkpoint,'a1');
  nodes[1].checkpoint=checkpoint;
  await db.put('nodes',nodes[1]);
  const answer='贺嘉衡让嘉树站柜台练接待。';
  responses.push(JSON.stringify({groups:[{rows:[0],kind:'转折',text:answer}],doubts:[]}));
  const end=await render(root,{id:story.id});
  try{
    button('整合已有记忆').click();
    await wait(()=>button('生成草稿'));
    assert.equal(requests.length,0);
    button('生成草稿').click();
    await wait(()=>button('应用整合版'));
    assert.equal(requests.length,1);
    assert.equal((await db.get('nodes','a1')).memoryEdition,undefined);
    button('应用整合版').click();
    await wait(async()=>!!(await db.get('nodes','a1')).memoryEdition);
    const context=async node=>buildContext({...story,memoryMode:'full'},[nodes[0],node]).system;
    const applied=await db.get('nodes','a1');
    assert.ok((await context(applied)).includes(answer));
    assert.deepEqual(applied.checkpoint,checkpoint);
    assert.ok(!(await context(nodes[1])).includes(answer));
    await wait(()=>!document.querySelector('.sheet'));
    assert.ok([...root.querySelectorAll('textarea')].some(t => t.readOnly && t.value === answer));
    button('整合已有记忆').click();await wait(()=>button('还原原档'));
    button('还原原档').click();
    await wait(async()=>(await db.get('nodes','a1')).memoryEdition===null);
    assert.ok((await context(await db.get('nodes','a1'))).includes(checkpoint.summaries[0].text));
  }finally{end();}
});

test('多批草稿失败后续跑，只重发未完成批次',async()=>{
  const {ensureStructured}=await import('../js/structured-memory.js');
  const {render}=await import('../js/views/memory.js');
  const {story,nodes}=await seedStory();
  const cp={upTo:1,summaries:Array.from({length:20},(_,i)=>({from:1,to:1,text:'细节编号'+i}))};
  ensureStructured(cp,'a1'); nodes[1].checkpoint=cp; await db.put('nodes',nodes[1]);
  const end=await render(root,{id:story.id});
  try{
    responses.push('{"groups":[]}','无效返回');
    button('整合已有记忆').click();await wait(()=>button('生成草稿'));button('生成草稿').click();
    await wait(()=>button('继续整合'));
    document.querySelector('.sheet [aria-label="关闭"]').click();
    button('整合已有记忆').click();await wait(()=>button('继续整合'));
    responses.push('{"groups":[],"doubts":["保留原文"]}');
    button('继续整合').click();await wait(()=>document.body.textContent.includes('没有可合并的建议'));
    assert.equal(requests.length,3);
    assert.deepEqual(requests[1].body.messages,requests[2].body.messages);
    document.querySelector('.sheet [aria-label="关闭"]').click();
    // 同一故事的新档案版本：其他栏目发生变化，相同的整合批次应全部命中本地结果。
    cp.edited = 123;
    await db.put('nodes',nodes[1]);
    end();
    root.replaceChildren();
    const closeAgain = await render(root,{id:story.id});
    try {
      button('整合已有记忆').click(); await wait(()=>button('生成草稿'));
      button('生成草稿').click(); await wait(()=>document.body.textContent.includes('没有可合并的建议'));
      assert.equal(requests.length,3);
    } finally { closeAgain(); }
    assert.ok(!(await db.get('nodes','a1')).memoryEdition);
  }finally{end();}
});

test('积压从第33章续存，失败后新增正文不会重复发请求，手动恢复分批写入', async () => {
  const { story } = await seedStory();
  story.memEvery = 10;
  const path = Array.from({ length: 55 }, (_, i) => ({
    id: 'archive-' + (i + 1), storyId: story.id, role: 'assistant',
    status: 'done', kind: 'play', text: '他把信放回桌上。',
  }));
  const { emptyMemory } = await import('../js/memory.js');
  path[31].checkpoint = { ...emptyMemory(), upTo: 32 };
  await db.putMany('nodes', path);
  const nodes = new Map(path.map(n => [n.id, n]));
  const conn = await db.get('connections', 'qa-conn');
  responses.push('{"summary":"没写完');
  await assert.rejects(runArchivist(story, nodes, path, conn, { automatic: true }), /已暂停/);
  path.push({ ...path[54], id: 'archive-56' });
  nodes.set(path[55].id, path[55]);
  assert.ok((await runArchivist(story, nodes, path, conn, { automatic: true })).paused);
  assert.equal(requests.length, 1);
  assert.equal((await db.get('nodes', path[31].id)).checkpoint.upTo, 32);
  responses.push('{"summary":"第一批"}', '{}');
  await assert.rejects(runArchivist(story, nodes, path, conn), /第 43–52 章/);
  assert.equal((await db.get('nodes', path[41].id)).checkpoint.upTo, 42);
  assert.ok((await runArchivist(story, nodes, path, conn, { automatic: true })).paused);
  assert.equal(requests.length, 3);
  responses.push('{"summary":"第二批"}', '{"summary":"第三批"}');
  const result = await runArchivist(story, nodes, path, conn);
  assert.deepEqual(result.written.map(n => n.checkpoint.upTo), [52, 56]);
  assert.equal((await db.get('nodes', path[55].id)).checkpoint.lastRun.from, 53);
});

test('过长单章在发送前提示输入预算，旧档仍可读取', async () => {
  const { story, nodes } = await seedStory();
  nodes[1].text = '一句正文。'.repeat(1500);
  const conn = { ...await db.get('connections', 'qa-conn'), inputBudgetChars: 6000 };
  await assert.rejects(runArchivist(story, new Map(nodes.map(n => [n.id, n])), nodes, conn), /第 1 章.*6000/);
  assert.equal(requests.length, 0);
  assert.equal((await db.get('nodes', 'a1')).checkpoint, undefined);
});

test('整合草稿略过更长的改写，保留可压缩的建议',async()=>{
  const {parseSuggestions}=await import('../js/consolidation.js');
  const result=parseSuggestions(JSON.stringify({groups:[
    {rows:[0],kind:'日常',text:'他在第二天到车站赴约。'},
    {rows:[1],kind:'转折',text:'他决定赴约。'},
  ]}),[{id:'a',event:'他赴约。'},{id:'b',event:'他犹豫了一夜，最后决定赴约。'}]);
  assert.deepEqual(result.groups.map(g=>g.sources[0].id),['b']);
});

test('整理转发断线后重进记忆页接回同一任务，只保存一次',async()=>{
  const story=await seedRelayExtra();
  const conn=await db.get('connections','qa-conn');
  const nodes=(await db.byStory(story.id)).sort((a,b)=>a.createdAt-b.createdAt);
  let offline=true;
  const calls=extraRelayMock(()=> {
    if(offline) throw new TypeError('offline');
    return extraSSE('{"summary":"他还记得那本书。"}');
  });
  await assert.rejects(runArchivist(story,new Map(nodes.map(n=>[n.id,n])),nodes,conn));
  offline=false;
  const {render}=await import('../js/views/memory.js');
  const close=await render(root,{id:story.id});
  try {
    await wait(async()=>(await db.get('nodes','a1')).checkpoint?.runs===1);
    assert.equal(calls.filter(c=>c.url.endsWith('/jobs')).length,1);
    assert.equal(calls.filter(c=>c.method==='DELETE').length,0);
    assert.ok(root.querySelector('details > summary'));
  } finally {close();}
});

test('核心栏装不下时，相关关键事实进入最终请求并计入补回数',()=>{
  const facts=Array.from({length:45},(_,i)=>({id:'r'+i,column:'irreversible',type:'fact',event:'旧事'+String(i).padStart(2,'0')+'。'.repeat(115)+'终',sourceFrom:i+1,sourceTo:i+1,irreversible:true,importance:5,tags:i===0?['速写本']:[]}));
  const path=[{id:'a',role:'assistant',text:'他到了。',checkpoint:{upTo:45,records:facts,cards:{}}},{id:'u',role:'user',text:'还记得以前那本速写本吗？'}];
  const ctx=buildContext({cards:[]},path,{budgetChars:6000});
  assert.equal(ctx.info.coreOmitted,45 - ctx.info.coreIncluded);
  assert.equal(ctx.info.omittedCore.length,ctx.info.coreOmitted);
  assert.ok(ctx.info.omittedCore.every(r => [...r.preview].length <= 30));
  assert.equal(ctx.info.totalChars,ctx.system.length + ctx.messages.reduce((sum,m)=>sum+m.content.length,0));
  const omitted = ctx.info.omittedCore.find(r=>!r.recalled);
  assert.ok(!ctx.system.includes(omitted.preview));
  assert.equal(ctx.info.coreRecalled,1);
  assert.ok(ctx.info.coreIncluded > 0 && ctx.info.coreIncluded <= 8);
  assert.ok(ctx.system.includes(facts[0].event));
  assert.ok(ctx.info.totalChars<=6000);
});

test('整合时只切到其他 App 再回来，接回原任务，草稿仍可应用',async()=>{
  const story=await seedRelayExtra();
  const {ensureStructured}=await import('../js/structured-memory.js');
  const node=await db.get('nodes','a1');
  node.checkpoint={upTo:1,summaries:[{from:1,to:1,text:'他延迟出发，在车站等到了她。'}]};
  ensureStructured(node.checkpoint,'a1');await db.put('nodes',node);
  let streams=0;
  const calls=extraRelayMock(init=>++streams===1 ? extraSSE('',{signal:init.signal,hang:true})
    : extraSSE('{"groups":[{"rows":[0],"kind":"转折","text":"他在车站等她。"}]}'));
  const {render}=await import('../js/views/memory.js');
  const close=await render(root,{id:story.id});
  try {
    button('整合已有记忆').click();await wait(()=>button('生成草稿'));button('生成草稿').click();
    await wait(()=>streams===1);
    for(const value of ['hidden','visible']) {
      Object.defineProperty(document,'visibilityState',{configurable:true,value});
      document.dispatchEvent(new Event('visibilitychange'));
    }
    await wait(()=>button('应用整合版'));
    assert.equal(streams,2);
    assert.equal(calls.filter(c=>c.url.endsWith('/jobs')).length,1);
    assert.equal(calls.filter(c=>c.method==='DELETE').length,0);
    button('应用整合版').click();
    await wait(()=>!document.querySelector('.sheet'));
  } finally {close();}
});

test('直连页面重载后只提示从中断处继续，自动整理不会重发',async()=>{
  const {story,nodes}=await seedStory();
  const conn=await db.get('connections','qa-conn');
  const key=JSON.stringify(['archiveTask',story.id,'a1']);
  await db.kvSet(key,{ids:['a1'],format:'openai'});
  try {
    const result=await runArchivist(story,new Map(nodes.map(n=>[n.id,n])),nodes,conn,{automatic:true});
    assert.match(result.paused,/手动重试/);
    assert.equal(requests.length,0);
    assert.equal((await db.get('nodes','a1')).checkpoint,undefined);
  } finally {await db.del('kv',key);}
});

test('有草稿时上下文预览与随后发送的玩家消息一致', async () => {
  const {story} = await seedStory();
  const dispose = await play.render(root,{id:story.id});
  try {
    root.querySelector('textarea').value = '我推开房门。';
    root.querySelector('[aria-label="更多"]').click();
    const entry = [...document.querySelectorAll('.menu-list button')].find(b=>b.textContent.startsWith('查看发给模型的内容'));
    entry.click();
    await wait(()=>document.body.textContent.includes('本轮草稿将发送的内容'));
    const history = [...document.querySelectorAll('details')].find(d=>d.querySelector('summary').textContent.startsWith('剧情对话')).querySelector('pre').textContent;
    assert.equal(requests.length,0);
    button('关闭').click();
    button('发送').click();
    await wait(()=>requests.length===1 && !dispose.busy());
    assert.match(requests[0].body.messages.at(-1).content,/我推开房门/);
    assert.ok(history.endsWith(requests[0].body.messages.at(-1).content));
  } finally { dispose(); }
});

test('整理依据章节原句结束旧事项并更新归属，空列表仍保留其他信息差',async()=>{
  const {story,nodes}=await seedStory();
  const first={...nodes[1],checkpoint:{upTo:1,threads:['等待回信'],items:['甲持有钥匙'],knowledge:['乙不知道地址'],cards:{}}};
  const chapter={...first,id:'next',parentId:first.id,text:'回信已经收到。甲将钥匙交给了乙。',checkpoint:undefined};
  const path=[nodes[0],first,chapter];
  responses.push(JSON.stringify({summary:'收信并交接钥匙',knowledge:[],changes:[
    {field:'threads',old:'等待回信',chapter:2,quote:'回信已经收到',next:''},
    {field:'items',old:'甲持有钥匙',chapter:2,quote:'甲将钥匙交给了乙',next:'乙持有钥匙'},
    {field:'knowledge',old:'乙不知道地址',chapter:2,quote:'乙看见地址',next:''}
  ]}));
  await runArchivist(story,new Map(path.map(n=>[n.id,n])),path,await db.get('connections','qa-conn'));
  const m=chapter.checkpoint;
  assert.deepEqual(m.items,['乙持有钥匙']);assert.deepEqual(m.threads,[]);assert.deepEqual(m.knowledge,['乙不知道地址']);
  assert.equal(m.records.find(r=>r.event==='甲持有钥匙').invalidatedAt,2);
  assert.ok(m.unsure.some(s=>s.includes('乙不知道地址')));
});

test('超过三十条的未决事项休眠，下一次整理仍保留可检索的有效记录',async()=>{
  const {story,nodes}=await seedStory();
  const first={...nodes[1],checkpoint:{upTo:1,threads:Array.from({length:32},(_,i)=>'未决事项'+i),cards:{}}};
  const path=[nodes[0],first];
  for(let i=2;i<=3;i++){
    const n={...nodes[1],id:'sleep'+i,parentId:path.at(-1).id,text:'窗外下起了雨。'};
    path.push(n);responses.push(JSON.stringify({summary:'窗外下雨',threads:[]}));
    await runArchivist(story,new Map(path.map(n=>[n.id,n])),path,await db.get('connections','qa-conn'));
    assert.equal(n.checkpoint.threads.length,30);
    const old=n.checkpoint.records.find(r=>r.event==='未决事项0');
    assert.ok(old.dormant);assert.equal(old.invalidatedAt,null);
  }
});

test('较旧的故事副本不能覆盖另一个页面已保存的修改',async()=>{
  const {story}=await seedStory();
  const a=await db.get('stories',story.id), b=await db.get('stories',story.id);
  a.title='更新后的标题';await db.put('stories',a);
  b.title='过期标题';await assert.rejects(db.put('stories',b),/别处更新/);
  assert.equal((await db.get('stories',story.id)).title,a.title);
  await db.put('stories',b);
  assert.equal((await db.get('stories',story.id)).title,b.title);
});

test('跨页面分别改标题和规则可以连续保存',async()=>{
  const {story}=await seedStory();
  const a=await db.get('stories',story.id), b=await db.get('stories',story.id);
  a.title='新的标题';await db.put('stories',a);
  b.rules='新的规则';await db.put('stories',b);
  b.rules+='。';await db.put('stories',b);
  const fresh=await db.get('stories',story.id);
  assert.equal(fresh.title,a.title);assert.equal(fresh.rules,b.rules);
});

test('整理时补写旧核心简版，旧正文与历史节点保真',async()=>{
  const {story,nodes}=await seedStory();
  const event='原协议仍然有效，只有收到双方签名的纸质回执，保管人才可以解除封存。单方签字或口头承诺均不生效。';
  const rec={id:'core-old',event,column:'irreversible',irreversible:true,sourceFrom:1,sourceTo:1};
  const first={...nodes[1],checkpoint:{schema:1,upTo:1,records:[rec],irreversible:[event],cards:{}}};
  const next={...nodes[1],id:'brief-next',parentId:first.id,text:'夜色渐深。'};
  const path=[nodes[0],first,next],brief='仅双方签署纸质回执后保管人可解封，单签或口头无效。';
  responses.push(JSON.stringify({summary:'入夜',briefUpdates:[{id:rec.id,brief}]}));
  await runArchivist(story,new Map(path.map(n=>[n.id,n])),path,await db.get('connections','qa-conn'));
  assert.equal(rec.brief,undefined);
  const updated=next.checkpoint.records.find(r=>r.id===rec.id);
  assert.equal(updated.brief,brief);assert.equal(updated.event,event);
});

test('单故事分享只带关联的无密钥配置，导回保留本机凭据', async()=>{
  const {story}=await seedStory();
  const c={id:'arch',format:'vertex',apiKey:'fake-private-material',baseUrl:'https://a:b@model.example/v1?key=other-secret'};
  await db.put('connections',c);
  await db.put('connections',{id:'unrelated'});
  Object.assign(story,{connectionId:'qa-conn',memConnId:c.id});
  await db.put('stories',story);
  const file=await exportStory(story.id);
  assert.deepEqual(file.connections.map(c=>c.id),['qa-conn','arch']);
  assert.ok(file.connections.every(c=>c.apiKey===''));
  assert.equal(file.connections[1].baseUrl,'https://model.example/v1');
  assert.doesNotMatch(JSON.stringify(file),/virtual-key|fake-private-material|other-secret/);
  await importData(file);
  assert.equal((await db.get('connections',c.id)).apiKey,c.apiKey);
});

test('从故事菜单复制设定重新开局，新故事不带历史节点和主角动态', async()=>{
  const {story}=await seedStory();
  story.cards=[{name:'旧相识',auto:{from:3},now:'后来才发生',base:'少言'}];
  story.protagonist.stateEntries=[{sourceNodeId:'a1'}];
  await db.put('stories',story);
  const library=await import('../js/views/library.js');
  await library.render(root);
  root.querySelector('[aria-label="更多"]').click();
  button('复制故事并重新开局').click();
  await wait(()=>button('复制并重开'));
  button('复制并重开').click();
  await wait(async()=>(await db.all('stories')).length===2);
  const copy=(await db.all('stories')).find(s=>s.id!==story.id);
  assert.equal(copy.headId,null);assert.equal(copy.opening,story.opening);assert.equal(copy.rules,story.rules);
  assert.equal(copy.cards[0].base,'少言');assert.equal(copy.cards[0].now,undefined);
  assert.equal(copy.protagonist.stateEntries,undefined);
  assert.equal((await db.byStory(copy.id)).length,0);assert.equal((await db.byStory(story.id)).length,2);
});

test('正文弹幕固定色按网名跨章一致，旧阅读偏好默认关闭',async()=>{
  const {story,nodes}=await seedStory();
  const {setPrefs}=await import('../js/state.js');
  story.danmu=true;story.headId='a2';await db.put('stories',story);
  nodes[1].text='# 章名\n正文。\n【弹幕】\n雨声：第一句\n晚舟：第二句';
  await db.putMany('nodes',[nodes[1],{...nodes[0],id:'u2',parentId:'a1'},{...nodes[1],id:'a2',parentId:'u2'}]);
  let dispose=await play.render(root,{id:story.id});
  assert.equal(root.querySelectorAll('.colored-name').length,0);
  dispose();root.replaceChildren();await setPrefs({danmuNameColors:true});
  try {
    dispose=await play.render(root,{id:story.id});
    const hues=[...root.querySelectorAll('.colored-name')].map(n=>n.style.getPropertyValue('--name-hue'));
    assert.equal(hues.length,4);assert.equal(hues[0],hues[2]);assert.notEqual(hues[0],hues[1]);
  } finally {dispose();await setPrefs({danmuNameColors:false});}
});

test('各个昵称色相在当前深浅纸面上对比度至少为4.5',()=>{
  const css=style.textContent;
  const luminance=rgb=>rgb.map(c=>c<=0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4)
    .reduce((sum,c,i)=>sum+c*[0.2126,0.7152,0.0722][i],0);
  const colors=[...css.matchAll(/\.colored-name \{ color: hsl\(var\(--name-hue\), (\d+)%, (\d+)%\)/g)];
  const papers=[...css.matchAll(/--bg: #([a-f0-9]{6});/g)];
  assert.equal(colors.length,2);
  for(const [i,color] of colors.entries()){
    const bg=luminance(papers[i][1].match(/../g).map(x=>parseInt(x,16)/255));
    const s=Number(color[1])/100,l=Number(color[2])/100;
    for(let h=0;h<360;h++){
      const fg=luminance([0,8,4].map(n=>{
        const k=(n+h/30)%12;
        return l-s*Math.min(l,1-l)*Math.max(-1,Math.min(k-3,9-k,1));
      }));
      assert.ok((Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05)>=4.5);
    }
  }
});

test('讨论写入失败时返回原因并继续导入其他数据', async () => {
  const discussion = Object.freeze({id:'frozen',messages:[]});
  const result = await importData({app:'moyu', stories:[{id:'other'}], discussions:[discussion], connections:[{id:'late'}]});
  assert.match(result.discussionsError,/updatedAt/);
  assert.ok(await db.get('stories','other'));
  assert.ok(await db.get('connections','late'));
});

test('整包模式预算不足时先删最早消息，保留最后回复原文', () => {
  const story = {memoryMode:'full', cards:[]};
  const path = Array.from({length:4}, (_,i)=>[
    {id:'u'+i, role:'user', text:'提问'+i+'文'.repeat(100)},
    {id:'a'+i, role:'assistant',text:'# 进展'+i+'\n正文。'+options},
  ]).flat();
  const full = buildContext(story,path);
  const ctx = buildContext(story,path,{budgetChars:full.info.totalChars-50});
  assert.equal(ctx.info.trimmed,1);
  assert.deepEqual(ctx.messages.slice(1),full.messages.slice(1));
  assert.equal(ctx.messages.at(-1).content,path.at(-1).text);
});

test('补回开场提示也占预算，差一字时继续裁剪', () => {
  const story = {memoryMode:'full'};
  const path = Array.from({length:4},(_,i)=>[
    {id:'u'+i,role:'user',text:'问'.repeat(100)},
    {id:'a'+i,role:'assistant',text:'答'.repeat(100)},
  ]).flat();
  const full = buildContext(story,path);
  const withLead = buildContext(story,path,{budgetChars:full.info.totalChars-1});
  assert.equal(withLead.info.trimmed,1);
  assert.equal(withLead.messages[0].role,'user');
  const exact = buildContext(story,path,{budgetChars:withLead.info.totalChars});
  assert.deepEqual(exact.messages,withLead.messages);
  const tighter = buildContext(story,path,{budgetChars:exact.info.totalChars-1});
  assert.equal(tighter.info.trimmed,2);
  assert.ok(tighter.info.totalChars<=tighter.info.budgetChars);
});

test('整理请求明确要求知情者并把返回的名单存进信息差记录', async () => {
  const {story,nodes} = await seedStory();
  const event = '甲从通知中知道门已关闭';
  responses.push(JSON.stringify({summary:event,knowledge:[event],memories:[{type:'knowledge',event,sourceChapter:1,knowers:['甲']}]}));
  await runArchivist(story,new Map(nodes.map(n=>[n.id,n])),nodes,await db.get('connections','qa-conn'));
  assert.match(JSON.stringify(requests[0].body),/必须填写 knowers/);
  const row = (await db.get('nodes','a1')).checkpoint.records.find(r=>r.column==='knowledge' && r.event===event);
  assert.deepEqual(row.knowers,['甲']);
});

test('阅读颜色迁移旧开关，过滤非法值，设置后重开保留，恢复默认清除覆盖', async () => {
  const {loadPrefs,getPrefs,setPrefs} = await import('../js/state.js');
  const style = document.documentElement.style;
  await db.kvSet('prefs',{dialogueColor:false,bodyColor:'red;display:none',fontSize:19});
  await loadPrefs();
  assert.equal(getPrefs().dialogueTint,false);
  assert.equal(getPrefs().fontSize,19);
  assert.equal(style.getPropertyValue('--read-text'),'');
  assert.equal(style.getPropertyValue('--read-dialogue'),'');
  await setPrefs({dialogueColor:'#abc',bodyColor:'#121212'});
  await loadPrefs();
  assert.equal(style.getPropertyValue('--read-dialogue'),'#abc');
  assert.equal(style.getPropertyValue('--read-text'),'#121212');
  const dispose = await settings.render(root,{});
  try {
    const picker = root.querySelector('[aria-label="自定义正文颜色"]');
    picker.value='#ffffff'; picker.dispatchEvent(new Event('input'));
    assert.equal(style.getPropertyValue('--read-text'),'#ffffff');
    assert.match(root.querySelector('.reading-colors').textContent,/这个颜色在当前模式下可能看不清/);
    root.querySelector('[aria-label="台词颜色 · 灰紫"]').click();
    assert.equal(style.getPropertyValue('--read-dialogue'),'var(--reading-swatch-5)');
    root.querySelector('.reading-colors .btn').click();
    assert.equal(style.getPropertyValue('--read-dialogue'),'');
    assert.equal(style.getPropertyValue('--read-text'),'');
  } finally { dispose(); await db.kvSet('prefs',null); await loadPrefs(); }
});

test('每种预设与对应模式的正文底色对比度均达 4.5',async () => {
  const css = await readFile(new URL('../css/app.css',import.meta.url),'utf8');
  function luminance(hex) {
    const [r,g,b] = hex.match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045 ? x/12.92 : ((x+.055)/1.055)**2.4);
    return .2126*r+.7152*g+.0722*b;
  }
  const palettes = [...css.matchAll(/--bg: #([0-9a-f]{6});([^}]+)/g)];
  assert.equal(palettes.length,2);
  for (const [,bg,variables] of palettes) {
    const colors = [...variables.matchAll(/--reading-swatch-\d+: #([0-9a-f]{6});/g)];
    assert.ok(colors.length>=6);
    for (const [,color] of colors) {
      const a=luminance(bg),b=luminance(color);
      assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5);
    }
  }
});
