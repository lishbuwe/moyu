// 墨游 · 记忆（前情档案）：查看、修改、整理

import { db } from '../db.js';
import { el, toast, sheet } from '../util.js';
import { resolveConnection, getConnections, connLabel, go, setCurrentStory, watchStory, PLAY_KEYS } from '../state.js';
import { latestCheckpoint } from '../prompt.js';
import { pendingChapters, runArchivist, archivePause, archiveRecovery, BATCH, archivingNow } from '../memory.js';
import { activeEdition, editionMemory } from '../consolidation.js';
import { openEdition } from './memory-edition.js';
import { fmtMoney } from '../cost.js';
import { migrateCheckpoints, projectColumns, syncStructured } from '../structured-memory.js';

export const DEFAULT_EVERY = BATCH;

function pathTo(nodes, nodeId) {
  const out = [];
  let cur = nodeId ? nodes.get(nodeId) : null;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parentId ? nodes.get(cur.parentId) : null; }
  return out;
}

/** 整理用的连接：故事单独指定的 → 故事的连接 */
export async function archiveConn(story) {
  if (story.memConnId) {
    const c = (await getConnections()).find((x) => x.id === story.memConnId);
    if (c) return c;
  }
  return resolveConnection(story);
}

export async function render(root, { id }) {
  const story = await db.get('stories', id);
  if (!story) { toast('找不到这个故事'); setCurrentStory(null); go(''); return; }
  const nodes = new Map((await db.byStory(id)).map((n) => [n.id, n]));
  const migration = await migrateCheckpoints(nodes, db);
  if (migration.failed) toast(`${migration.failed} 份旧档案暂未迁移，已保留原文；请检查设备存储空间`, 5000);
  const conns = await getConnections();
  let running = null;
  let destroyed = false;
  let statusEl = null;
  let showOriginal = false;

  const sub = el('div', { class: 'sub' });
  const wrap = el('div', { class: 'wrap' });
  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' },
      el('button', { class: 'icon-btn', 'aria-label': '返回', onclick: () => go('play/' + encodeURIComponent(story.id)) }, '‹'),
      el('div', { class: 'title' }, '记忆 · 前情档案', sub)),
    el('div', { class: 'scroll' }, wrap)));

  const saveStory = () => db.put('stories', story).catch(() => {});

  function draw() {
    const path = pathTo(nodes, story.headId);
    const { cp, upTo, pending } = pendingChapters(path);
    sub.textContent = cp ? `整理到第 ${upTo} 章 · ${pending.length ? `还有 ${pending.length} 章没整理` : '已是最新'}` : `还没整理过 · ${pending.length} 章`;
    wrap.replaceChildren();

    // 整理设置与按钮
    const every = el('input', { type: 'number', min: '0', max: '60', step: '1', style: { width: '90px', flex: 'none' } });
    every.value = String(story.memEvery ?? DEFAULT_EVERY);
    every.addEventListener('change', () => { story.memEveryExplicit = true; story.memEvery = Math.max(0, Math.min(60, Number(every.value) || 0)); saveStory(); toast(story.memEvery ? `每 ${story.memEvery} 章自动整理一次` : '已关闭自动整理'); });
    const connSel = el('select', { onchange: () => { story.memConnId = connSel.value || null; saveStory(); } });
    const mode = el('input', { type: 'checkbox' }); mode.checked = story.memoryMode === 'full';
    mode.addEventListener('change', () => { story.memoryMode = mode.checked ? 'full' : 'layered'; saveStory(); toast(mode.checked ? '已切回整包档案' : '已启用分层记忆'); });
    const recent = el('input', { type: 'number', min: '2', max: '6', step: '1', style: { width: '90px', flex: 'none' } });
    recent.value = String(story.recentChapters || 2);
    recent.addEventListener('change', () => { story.recentChapters = Math.max(2, Math.min(6, Number(recent.value) || 2)); recent.value = String(story.recentChapters); saveStory(); });
    connSel.append(el('option', { value: '' }, '跟随故事的连接'));
    conns.forEach((c) => connSel.append(el('option', { value: c.id }, `${connLabel(c)}（${c.model}）`)));
    connSel.value = story.memConnId || '';
    const status = el('div', { class: 'hint' });
    statusEl = status;
    const ext = !running && archivingNow(story.id);
    const runBtn = el('button', { class: 'btn small primary', onclick: () => run() }, pending.length ? `现在整理（${pending.length} 章）` : '已是最新');
    runBtn.disabled = !pending.length || !!running || !!ext;
    const redoBtn = cp ? el('button', {
      class: 'btn small ghost',
      onclick: async () => {
        if (running || archivingNow(story.id)) return;
        if (!confirm(`删掉最近这次整理（第 ${cp.mem.lastRun?.from || '?'}–${cp.mem.upTo} 章），从上一次的档案重新整理？你在这次档案里手动改过的内容也会丢掉。`)) return;
        const backup = cp.node.checkpoint;
        delete cp.node.checkpoint;
        await db.put('nodes', cp.node);
        const ok = await run();
        if (!ok && !cp.node.checkpoint) {   // 没整理成：把原来的档案放回去
          cp.node.checkpoint = backup;
          await db.put('nodes', cp.node).catch(() => {});
          if (!destroyed) draw();
          toast('没整理成，已恢复原来的档案');
        }
      },
    }, '重新整理最近一次') : null;
    if (redoBtn) redoBtn.disabled = !!running || !!ext;
    const stop = (running || ext)?.ctrl;
    wrap.append(el('div', { class: 'card' },
      el('div', { class: 'row' }, runBtn, stop ? el('button', { class: 'btn small', onclick: () => stop.abort() }, '停止整理') : null,
        cp && !stop ? el('button', { class:'btn small', onclick:async () => {
          try { await openEdition(story,path,cp,await archiveConn(story),async () => { showOriginal = false; await reload(); }); } catch (e) { toast(e.message); }
        } }, '整合已有记忆') : null), status),
      el('details', {class:'card'}, el('summary',{text:'整理设置与更多操作'}),
        el('div',{class:'switch-row'}, el('label',{text:'自动整理间隔（章，0 为关闭）'}),every),
        el('div',{class:'field'}, el('label',{text:'整理用的连接'}),connSel),
        el('div',{class:'switch-row'},el('label',{text:'最近保留几章原文'}),recent),
        el('div',{class:'switch-row'},el('label',{text:'使用旧整包档案模式'}),mode),redoBtn));
    if (running) status.textContent = running.text;
    else if (ext) status.textContent = ext.text;

    if (!running && !ext && pending.length) archivePause(story.id, pending[0].id).then(reason => {
      if (reason && !destroyed && statusEl === status) {
        status.textContent = reason;
        runBtn.textContent = `从第 ${pending[0].no} 章继续整理`;
      }
    });
    if (!cp) {
      return;
    }

    const effective = editionMemory(cp.mem, activeEdition(path));
    const readOnly = effective !== cp.mem && !showOriginal;
    if (effective !== cp.mem) {
      wrap.append(el('div', { class: 'row' },
        el('strong', { text: readOnly ? '正文使用中的整合版' : '原始档案' }),
        el('button', { class: 'btn small', onclick: () => { showOriginal = !showOriginal; draw(); } },
          readOnly ? '查看或编辑原档' : '查看生效版')));
    }
    const m = readOnly ? effective : cp.mem;
    const shown = projectColumns(m);
    const fields = {};
    const listArea = (key, label, hint = '') => {
      const ta = el('textarea', { style: { minHeight: '90px' } });
      ta.value = (shown[key] || m[key] || []).join('\n');
      fields[key] = ta;
      return el('div', { class: 'field' }, el('label', { text: label }), ta, hint ? el('div', { class: 'hint', text: hint }) : null);
    };
    const early = el('textarea', { style: { minHeight: '120px' } }); early.value = shown.early || '';
    const sums = (shown.summaries || []).map((x) => { const ta = el('textarea', { style: { minHeight: '110px' } }); ta.value = x.text; return { x, ta }; });
    const cardFields = Object.entries(m.cards || {}).map(([name, v]) => {
      const now = el('textarea', { style: { minHeight: '70px' } }); now.value = v.now || '';
      const arc = el('textarea', { style: { minHeight: '70px' } }); arc.value = v.arc || '';
      const rel = el('textarea', { style: { minHeight: '90px' } }); rel.value = v.relation || '';
      return { name, now, arc, rel };
    });

    for (const [name,card] of Object.entries(m.cards || {})) if (card.relation?.length > 800)
      wrap.append(el('div',{class:'hint',text:name+'的关系档案超过800字，可在角色状态里核对。'}));
    const last = m.lastRun;
    if (last) wrap.append(el('div', {class:'hint', text:`上次整理 · 第 ${last.from}–${last.to} 章 · ${last.model || ''}${last.cost ? ' · ' + fmtMoney(last.cost) : ''}`}));
    if (last?.omitted) wrap.append(el('div',{class:'hint',text:'上次整理有 '+last.omitted+' 条旧记录未展示给存档员。'}));
    const section = label => {
      const details = el('details', {class:'card'}, el('summary',{text:label}));
      wrap.append(details);
      return details;
    };
    if ((m.unsure?.length || 0) + (m.conflicts?.length || 0) > 0) {
      wrap.append(el('div', { class: 'section-title', text: '需要你看一眼' }),
        el('div', { class: 'card notice' },
          el('div', { class: 'hint', style: { marginTop: 0, marginBottom: '8px' }, text: '存档员拿不准的、和设定冲突的，都放在这里，不会发给模型。看过后删掉；确认是对的，就把它挪到下面对应的栏里。' }),
          listArea('unsure', '待确认'), listArea('conflicts', '设定冲突')));
    }

    section('剧情与物品').append(el('div', {},
      shown.early?.trim() ? el('div', { class: 'field' }, el('label', { text: `早期概要（第 1–${m.earlyUpTo} 章，摘要太长时自动压缩而来）` }), early) : null,
      ...sums.map(({ x, ta }) => el('div', { class: 'field' }, el('label', { text: `第 ${x.from}–${x.to} 章` }), ta)),
      listArea('irreversible', '不可逆的事（永久保留，不会被压缩）'),
      listArea('corrections', '勘误（和上面冲突时以这里为准）', '改了早期章节的事实、或者发现档案记错了，写在这里。'),
      listArea('items', '物品与信物')));
    section('暗线与信息差').append(el('div', {},
      listArea('threads', '未决事项、未兑现的承诺、暗线'),
      listArea('knowledge', '信息差：谁知道什么、谁不知道', '防止角色开上帝视角。'),
      listArea('offscreen', '暗处动向：各角色接下来想做什么', '让角色在你不推的时候也会自己出手。'),
      listArea('repeats', '最近反复出现的套路', '下一段会提醒模型换个写法。')));
    if (cardFields.length) {
      const roleSection = section('角色当前状态');
      for (const c of cardFields) {
        roleSection.append(el('div', { class: 'card' },
          el('div', { style: { fontWeight: 600, marginBottom: '8px' } }, c.name),
          el('div', { class: 'field' }, el('label', { text: '当前状态与称呼' }), c.now),
          el('div', { class: 'field' }, el('label', { text: '变化轨迹' }), c.arc),
          el('div', { class: 'field' }, el('label', { text: '关系档案' }), c.rel)));
      }
    }
    if (readOnly) {
      for (const ta of wrap.querySelectorAll('textarea')) ta.readOnly = true;
      return;
    }
    const lines = (ta) => ta.value.split('\n').map((l) => l.trim()).filter(Boolean);
    wrap.append(el('div', { class: 'row', style: { margin: '10px 0 30px' } },
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          if (running || archivingNow(story.id)) { toast('正在整理，等它完成再保存修改'); return; }
          const changed = { ...m };
          for (const [k, ta] of Object.entries(fields)) changed[k] = lines(ta);
          if (m.early?.trim() || m.earlyUpTo) changed.early = early.value.trim();
          sums.forEach(({ x, ta }) => { x.text = ta.value.trim(); });
          changed.summaries = sums.map(({ x }) => x).filter((x) => x.text);
          for (const c of cardFields) m.cards[c.name] = { now: c.now.value.trim(), arc: c.arc.value.trim(), relation: c.rel.value.trim() };
          syncStructured(m, changed, { from: m.upTo, to: m.upTo, branchId: cp.node.id });
          m.edited = Date.now();
          await db.put('nodes', cp.node);
          toast('档案已保存，下一轮生效');
          draw();
        },
      }, '保存修改'),
      el('span', { class: 'hint', style: { margin: 0 }, text: '只改最新这一份；回退到更早的章节时，会用当时那一份。' })));
  }

  async function run() {
    if (running || archivingNow(story.id)) return false;
    const conn = await archiveConn(story);
    if (!conn) { toast('先在设置里添加连接'); return false; }
    const ctrl = new AbortController();
    running = { ctrl, text: '准备整理…' };
    draw();
    let ok = false;
    try {
      const path = pathTo(nodes, story.headId);
      const r = await runArchivist(story, nodes, path, conn, {
        signal: ctrl.signal, ctrl,
        onProgress: (t) => { if (running) { running.text = t; if (statusEl && !destroyed) statusEl.textContent = t; } },
      });
      running = null;
      ok = r.written.length > 0;
      toast(r.newCards?.length ? `已整理到第 ${r.to} 章，新建了角色卡：${r.newCards.join('、')}` : r.written.length ? `已整理到第 ${r.to} 章` : '没有需要整理的章节', r.newCards?.length ? 4500 : 2500);
    } catch (e) {
      running = null;
      if (e?.kind !== 'aborted' && e?.kind !== 'busy') {
        const s = sheet({ title: '整理没有完成' });
        s.body.append(el('div', { class: 'err' }, el('div', { class: 'h', text: '⚠ ' + (e.message || '出错了') }), e.hint ? el('div', { class: 'hint', text: e.hint }) : null, e.detail ? el('pre', { text: e.detail }) : null));
        s.foot.append(el('button', { class: 'btn primary', onclick: () => s.close() }, '知道了'));
      }
    }
    if (!destroyed) draw();
    return ok;
  }

  // 别处在整理：每秒看一眼，结束了就从数据库重新读一遍
  let sawExt = false;
  const timer = setInterval(async () => {
    const ext = !running && archivingNow(story.id);
    if (ext) { if (!sawExt) draw(); sawExt = true; if (statusEl) statusEl.textContent = ext.text; }
    else if (sawExt) { sawExt = false; await reload(); }
  }, 1000);
  async function reload() {
    const fresh = await db.byStory(id).catch(() => null);
    if (!fresh || destroyed) return;
    nodes.clear();
    fresh.forEach((n) => nodes.set(n.id, n));
    draw();
  }
  const onCheckpoint = (e) => {
    const d = e.detail || {};
    if (d.storyId !== story.id || destroyed) return;
    const n = nodes.get(d.nodeId);
    if (n) { n.checkpoint = d.mem; draw(); }
  };
  window.addEventListener('moyu:checkpoint', onCheckpoint);
  const onCards = (e) => { if (e.detail?.storyId === story.id && Array.isArray(e.detail.cards)) story.cards = e.detail.cards; };
  window.addEventListener('moyu:cards', onCards);
  const unwatch = watchStory(story, null, PLAY_KEYS);

  const recover = async () => {
    if (destroyed || running || archivingNow(id) || document.visibilityState !== 'visible') return;
    const first = pendingChapters(pathTo(nodes,story.headId)).pending[0];
    if (await archiveRecovery(id, first?.id) && !destroyed) await run();
  };
  document.addEventListener('visibilitychange',recover);
  void recover();
  const initialPath = pathTo(nodes,story.headId);
  const initialCheckpoint = latestCheckpoint(initialPath);
  if (initialCheckpoint) void archiveConn(story).then(conn => {
    if (!destroyed) return openEdition(story,initialPath,initialCheckpoint,conn,reload,{resumeOnly:true});
  }).catch(e => { if (!destroyed) toast(e.message); });
  draw();
  // 离开这页不打断整理：它会在后台写完，游玩页会收到通知
  return () => { destroyed = true; document.removeEventListener('visibilitychange',recover); clearInterval(timer); window.removeEventListener('moyu:checkpoint', onCheckpoint); window.removeEventListener('moyu:cards', onCards); unwatch(); };
}

export { pathTo as memPathTo, latestCheckpoint };
