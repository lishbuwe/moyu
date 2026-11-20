// 墨游 · 记忆（前情档案）：查看、修改、整理

import { db } from '../db.js';
import { el, toast, sheet } from '../util.js';
import { resolveConnection, getConnections, connLabel, go, setCurrentStory, watchStory, PLAY_KEYS } from '../state.js';
import { latestCheckpoint } from '../prompt.js';
import { pendingChapters, runArchivist, archivingNow } from '../memory.js';
import { openEdition } from './memory-edition.js';
import { fmtMoney } from '../cost.js';
import { migrateCheckpoints, projectColumns, syncStructured } from '../structured-memory.js';

export const DEFAULT_EVERY = 15;

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
    const recent = el('input', { type: 'number', min: '2', max: '4', step: '1', style: { width: '90px', flex: 'none' } });
    recent.value = String(story.recentChapters || 2);
    recent.addEventListener('change', () => { story.recentChapters = Math.max(2, Math.min(4, Number(recent.value) || 2)); recent.value = String(story.recentChapters); saveStory(); });
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
    wrap.append(el('div', { class: 'card' },
      el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '每几章自动整理一次', el('small', { text: '0 = 不自动，只手动整理。整理在后台进行，不耽误继续玩。' })), every),
      el('div', { class: 'field', style: { margin: '6px 0 10px' } }, el('label', { text: '整理用的连接' }), connSel,
        el('div', { class: 'hint', text: '留空就跟正文共用连接。每章自动整理会在正文结束后再发一次模型请求；如果常遇到 429，可以在这里单独选一条有额度的连接。便宜模型可能漏细节，请在整理后检查档案。' })),
      el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '使用旧整包档案模式', el('small', { text: '关闭时，正文会按场景接续，并引用还在发展的较早互动。' })), mode),
      el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '最近保留几章原文', el('small', { text: '按场景接续时的保底章数，预算允许时会带上更多相关原文。' })), recent),
      el('div', { class: 'row' }, runBtn, redoBtn, cp ? el('button', { class:'btn small', onclick:async () => {
        try { await openEdition(story,path,cp,await archiveConn(story),reload); } catch (e) { toast(e.message); }
      } }, '整合已有记忆') : null), status));
    if (running) status.textContent = running.text + '（可以离开这页，整理会在后台继续）';
    else if (ext) status.textContent = ext.text + '（游玩页在后台整理，完成后这里会自动刷新）';

    if (!cp) {
      wrap.append(el('div', { class: 'empty', style: { padding: '28px 8px' } },
        '还没有整理过前情。', el('br'),
        `每 ${story.memEvery ?? DEFAULT_EVERY} 章会自动整理一次：剧情摘要、不可逆的事、信物、未决事项、信息差、角色当前状态……整理好之后，更早的原文就不再整段发给模型，省钱也不容易漂移。`));
      return;
    }

    const m = cp.mem;
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

    const last = m.lastRun;
    wrap.append(el('div', { class: 'hint', style: { margin: '14px 2px 6px' } },
      `下面是当前这条线上最新的一份档案（第 1–${m.upTo} 章）。分层模式会按需取用，整包模式会发送全部；改了下一轮生效。` +
      (last ? ` 上次整理：第 ${last.from}–${last.to} 章${last.model ? '，用 ' + last.model : ''}${last.cost ? '，' + fmtMoney(last.cost) : ''}。` : '')));

    if ((m.unsure?.length || 0) + (m.conflicts?.length || 0) > 0) {
      wrap.append(el('div', { class: 'section-title', text: '需要你看一眼' }),
        el('div', { class: 'card notice' },
          el('div', { class: 'hint', style: { marginTop: 0, marginBottom: '8px' }, text: '存档员拿不准的、和设定冲突的，都放在这里，不会发给模型。看过后删掉；确认是对的，就把它挪到下面对应的栏里。' }),
          listArea('unsure', '待确认'), listArea('conflicts', '设定冲突')));
    }

    wrap.append(el('div', { class: 'section-title', text: '剧情' }), el('div', { class: 'card' },
      m.early?.trim() || m.earlyUpTo ? el('div', { class: 'field' }, el('label', { text: `早期概要（第 1–${m.earlyUpTo} 章，摘要太长时自动压缩而来）` }), early) : null,
      ...sums.map(({ x, ta }) => el('div', { class: 'field' }, el('label', { text: `第 ${x.from}–${x.to} 章` }), ta)),
      listArea('irreversible', '不可逆的事（永久保留，不会被压缩）'),
      listArea('corrections', '勘误（和上面冲突时以这里为准）', '改了早期章节的事实、或者发现档案记错了，写在这里。'),
      listArea('items', '物品与信物')));
    wrap.append(el('div', { class: 'section-title', text: '暗线' }), el('div', { class: 'card' },
      listArea('threads', '未决事项、未兑现的承诺、暗线'),
      listArea('knowledge', '信息差：谁知道什么、谁不知道', '防止角色开上帝视角。'),
      listArea('offscreen', '暗处动向：各角色接下来想做什么', '让角色在你不推的时候也会自己出手。'),
      listArea('repeats', '最近反复出现的套路', '下一段会提醒模型换个写法。')));
    if (cardFields.length) {
      wrap.append(el('div', { class: 'section-title', text: '角色（会覆盖角色卡上的这三栏）' }));
      for (const c of cardFields) {
        wrap.append(el('div', { class: 'card' },
          el('div', { style: { fontWeight: 600, marginBottom: '8px' } }, c.name),
          el('div', { class: 'field' }, el('label', { text: '当前状态与称呼' }), c.now),
          el('div', { class: 'field' }, el('label', { text: '变化轨迹' }), c.arc),
          el('div', { class: 'field' }, el('label', { text: '关系档案' }), c.rel)));
      }
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
        onProgress: (t) => { if (running) { running.text = t; if (statusEl && !destroyed) statusEl.textContent = t + '（可以离开这页，整理会在后台继续）'; } },
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
    if (ext) { sawExt = true; if (statusEl) statusEl.textContent = ext.text + '（游玩页在后台整理，完成后这里会自动刷新）'; }
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
    if (n && n.checkpoint !== d.mem) n.checkpoint = d.mem;
  };
  window.addEventListener('moyu:checkpoint', onCheckpoint);
  const onCards = (e) => { if (e.detail?.storyId === story.id && Array.isArray(e.detail.cards)) story.cards = e.detail.cards; };
  window.addEventListener('moyu:cards', onCards);
  const unwatch = watchStory(story, null, PLAY_KEYS);

  draw();
  // 离开这页不打断整理：它会在后台写完，游玩页会收到通知
  return () => { destroyed = true; clearInterval(timer); window.removeEventListener('moyu:checkpoint', onCheckpoint); window.removeEventListener('moyu:cards', onCards); unwatch(); };
}

export { pathTo as memPathTo, latestCheckpoint };
