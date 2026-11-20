// 保存请求的接回凭据，直到调用方把结果写进档案或草稿。
import { db } from './db.js';
import { guessFormat, streamWithRetry } from './api.js';

export async function memoryRequest(key, conn, options, metadata = {}) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([options.system, options.messages])));
  const signature = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
  let task = await db.kvGet(key, null);
  if (task && task.signature !== signature) {
    await db.del('kv', key);
    throw Error('本批原文或设定已变更，旧结果已跳过。请按当前内容重新整理。');
  }
  if (task?.result) return task.result;
  if (!task?.job) task = { ...metadata, signature, format: conn.format === 'vertex' ? 'openai' : guessFormat(conn), stream: conn.stream !== false, model: conn.model };
  await db.kvSet(key, task);
  for (;;) {
    const ctrl = new AbortController();
    const stop = () => ctrl.abort(options.signal.reason);
    const reconnect = () => {
      if (task.job && document.visibilityState === 'visible') ctrl.abort('reconnect');
    };
    if (options.signal?.aborted) stop();
    options.signal?.addEventListener('abort', stop, {once:true});
    document.addEventListener('visibilitychange', reconnect);
    try {
      const source = task.job ? { ...conn, format: task.format, stream: task.stream, model: task.model } : conn;
      const result = await streamWithRetry(source, { ...options, signal:ctrl.signal, resumeJob:task.job, relayServer:task.server,
        onJob: async (job, server) => {
          Object.assign(task, {job, server});
          await db.kvSet(key, task);
        },
      }, {retries:0});
      await db.kvSet(key, {...task, result});
      return result;
    } catch (e) {
      if (ctrl.signal.reason === 'reconnect' && !options.signal?.aborted) continue;
      if (task.job && options.signal?.reason === 'leave') throw e;
      if (!task.job || options.signal?.aborted || !['relay_network','relay_auth','relay_config','network','timeout'].includes(e.kind)) {
        await db.del('kv', key);
      }
      throw e;
    } finally {
      options.signal?.removeEventListener('abort', stop);
      document.removeEventListener('visibilitychange', reconnect);
    }
  }
}
