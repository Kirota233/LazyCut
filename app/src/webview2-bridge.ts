import { createApiService } from '../shared/api-service.mjs';
import { buildJianyingAIRequest } from '../electron/jianying-ai.mjs';
import { webAIScriptPrompt } from '../shared/web-ai-prompts.mjs';
import { webAIProvider, isWebAIPage } from '../shared/web-ai.mjs';
import { webAIPageScript } from '../electron/web-ai-dom.mjs';
import { createWebAnalysis } from '../electron/web-ai-analysis.mjs';
import { validateScoreRequest, parseScoreResponse, materialTexts } from '../shared/script-score.mjs';
import { parseKeywords } from '../shared/library-match.mjs';
import { normalizeSubtitlePunctuation } from '../shared/period-text.mjs';
import { musicFileStem } from '../shared/music-filename.mjs';

declare const window: any;

const wv = window.chrome?.webview;

if (wv && !window.blackObsidian) {
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners: Record<string, Set<(val: any) => void>> = {};

  const onEvent = (channel: string, cb: (val: any) => void) => {
    if (!listeners[channel]) listeners[channel] = new Set();
    listeners[channel].add(cb);
    return () => listeners[channel].delete(cb);
  };

  const emitLocal = (channel: string, value: any) => {
    const set = listeners[channel];
    if (set) for (const fn of set) { try { fn(value); } catch {} }
  };

  const invokeHost = (cmd: string, payload: any = {}): Promise<any> => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      wv.postMessage(JSON.stringify({ id, cmd, payload }));
    });
  };

  wv.addEventListener('message', (event: any) => {
    const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (!msg) return;
    if (msg.event) {
      if (msg.event === 'bos:jianying-ai-request') {
        void handleJianyingAiFromHost(msg.data);
        return;
      }
      emitLocal(msg.event, msg.data);
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.result);
    }
  });

  // Upstream CORS-free fetch via Native C# Host with AbortSignal propagation
  const hostFetch = async (url: string | URL, options: any = {}) => {
    const signal: AbortSignal | undefined = options?.signal;
    if (signal?.aborted) {
      throw signal.reason || new DOMException('已取消', 'AbortError');
    }
    const urlStr = String(url);
    const isLocal = urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost');
    const payload = {
      url: urlStr,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? String(options.body) : '',
      timeoutMs: isLocal ? 720000 : 240000,
    };
    const res = await new Promise<any>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(signal?.reason || new DOMException('已取消', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      invokeHost('http-fetch', payload).then(
        val => {
          if (signal) signal.removeEventListener('abort', onAbort);
          if (!settled) { settled = true; resolve(val); }
        },
        err => {
          if (signal) signal.removeEventListener('abort', onAbort);
          if (!settled) { settled = true; reject(err); }
        }
      );
    });
    return {
      ok: Boolean(res.ok),
      status: Number(res.status) || 0,
      text: async () => String(res.body ?? ''),
      json: async () => JSON.parse(String(res.body || '{}')),
      headers: { get: (k: string) => (res.headers && res.headers[k.toLowerCase()]) || null },
    };
  };

  // Jianying AI Vision bridge when JianYingEngine.exe requests draft scan / AI rename
  let lastJyConnection: any = null;
  function formatProviderLabel(p: any) {
    const rawName = String(p?.name || '').trim();
    if (rawName && rawName !== 'Provider Select') return rawName;
    if (p?.protocol === 'gemini') return 'Gemini AI Studio';
    if (p?.protocol === 'openai') return 'OpenAI 兼容';
    if (p?.protocol === 'anthropic') return 'Anthropic';
    return String(p?.id || 'AI').trim();
  }
  function resolveJyConnection(reqModelKey?: string) {
    try {
      const cached = JSON.parse(
        localStorage.getItem('black-obsidian.providers.v1') ||
        localStorage.getItem('xm.providers.cache') ||
        '[]'
      );
      const savedKey = reqModelKey || localStorage.getItem('xm.jianying.model') || '';
      const models: any[] = [];
      for (const p of (Array.isArray(cached) ? cached : [])) {
        const pName = formatProviderLabel(p);
        const pid = p?.id || pName;
        for (const rawM of (Array.isArray(p?.models) ? p.models : [])) {
          const m = String(rawM || '').trim();
          if (!m) continue;
          models.push({ key: `${pid}::${m}`, provider: p, model: m });
        }
      }
      const matched = (savedKey ? models.find(item => item.key === savedKey) : null) || models[0] || null;
      if (matched?.provider?.apiKey) {
        lastJyConnection = matched;
        return matched;
      }
      if (lastJyConnection?.provider?.apiKey) return lastJyConnection;
      return null;
    } catch {
      return lastJyConnection;
    }
  }
  async function handleJianyingAiFromHost(req: any) {
    try {
      const conn = resolveJyConnection(req?.modelKey);
      if (!conn) throw new Error('请先在主窗口「接口与主题」中配置 Gemini 模型连接');
      const built = buildJianyingAIRequest(conn, { prompt: req.prompt, image: req.image });
      const resp = await hostFetch(built.url.toString(), {
        method: 'POST',
        headers: built.headers,
        body: JSON.stringify(built.body),
      });
      const raw = await resp.text();
      if (!resp.ok) throw new Error(`AI 请求失败 (HTTP ${resp.status})`);
      const parsed = JSON.parse(raw);
      const text =
        conn.provider?.protocol === 'gemini'
          ? (parsed?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('')
          : parsed?.choices?.[0]?.message?.content || '';
      if (!text || !text.trim()) {
        throw new Error('AI 返回内容为空，请检查模型连接');
      }
      await invokeHost('jianying-ai-reply', { id: req.id, token: req.token, text: String(text || '[]') });
    } catch (err: any) {
      await invokeHost('jianying-ai-reply', { id: req.id, token: req.token, error: err?.message || 'AI 识别失败' });
    }
  }

  // Shared API dispatcher + in-renderer WebAI orchestrator
  const apiDispatch = createApiService(hostFetch, (id: string, phase: string) => {
    window.dispatchEvent(new CustomEvent('xm-batch-analysis-stage', { detail: { id, phase } }));
  });

  let webAiVisible = false;
  let webAiProvider = 'deepseek';
  const webAnalysis = createWebAnalysis({
    driver: {
      visible: (id: string) => webAiVisible && webAiProvider === id,
      run: async (id: string, input: any, signal?: AbortSignal) => {
        if (signal?.aborted) throw signal.reason || new DOMException('已取消', 'AbortError');
        const host = webAIProvider(id).host;
        const res = await invokeHost('web-ai-action', {
          id,
          action: 'exec',
          script: webAIPageScript({ ...input, host }),
        });
        if (signal?.aborted) throw signal.reason || new DOMException('已取消', 'AbortError');
        return res?.result || {};
      },
    },
    notify: (task: any) => {
      emitLocal('bos:web-analysis-task', task);
    },
    copy: (text: string) => invokeHost('copy-plain', { text }),
  });

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: any, init?: any) => {
    const urlStr = typeof input === 'string' ? input : input?.url || String(input);
    if (urlStr.startsWith('/api/') || urlStr.startsWith(window.location.origin + '/api/')) {
      const pathname = new URL(urlStr, window.location.origin).pathname;
      try {
        const rawBody = init?.body ? JSON.parse(String(init.body)) : {};
        const { status, body } = await apiDispatch(pathname, rawBody, init?.signal);
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err?.message || 'API 请求失败' }), {
          status: Number(err?.status) || 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return origFetch(input, init);
  };

  window.blackObsidian = {
    layoutWebAI: async (input: any) => {
      if (input?.provider) webAiProvider = input.provider;
      const res = await invokeHost('web-ai-layout', input);
      webAiVisible = Boolean(input?.visible && res && res.visible !== false);
      if (!input?.visible) webAiVisible = false;
      return res;
    },
    webAIAction: async (id: string, action: string) => {
      const info = webAIProvider(id);
      const cmd = action === 'login' ? 'login' : action === 'page-status' ? 'probe' : '';
      const res = await invokeHost('web-ai-action', {
        id,
        action,
        ...(cmd ? { script: webAIPageScript({ command: cmd, host: info.host }) } : {}),
      });
      if (res && typeof res.visible === 'boolean') webAiVisible = res.visible;
      if (res?.result?.state && res.result.state !== 'ready' && res.result.message) {
        res.pageNotice = res.result.message;
      } else if (res?.url && !res.loading && !isWebAIPage(id, res.url)) {
        res.pageNotice = `当前页面不在 ${info.name} 官方域名下，请点击「首页」返回。`;
      }
      return res;
    },
    copyWebAITask: (draft: any, purpose: string) => invokeHost('copy-plain', { text: webAIScriptPrompt(draft, purpose) }),
    analyzeWebScript: (request: any) => webAnalysis.run(request),
    getWebAnalysisTask: async () => webAnalysis.snapshot(),
    webAnalysisAction: (id: string, action: string, value: any) => webAnalysis.action(id, action, value),
    onWebAnalysisTask: (cb: any) => onEvent('bos:web-analysis-task', cb),
    localModelAction: (action: string, model?: string) => invokeHost('local-model-action', { action, model: model || '' }),
    onLocalModelProgress: (cb: any) => onEvent('bos:local-model-progress', cb),

    getWatermarkState: () => invokeHost('watermark:get-state'),
    chooseWatermarkVideos: () => invokeHost('watermark:choose-videos'),
    addWatermarkVideos: (filesOrPaths: any[]) => {
      const paths = (filesOrPaths || []).map((f: any) => (typeof f === 'string' ? f : f?.path || f?.name || '')).filter(Boolean);
      return invokeHost('watermark:add-videos', { paths });
    },
    chooseWatermarkImage: () => invokeHost('watermark:choose-image'),
    chooseWatermarkOutputDir: () => invokeHost('watermark:choose-output-dir'),
    updateWatermarkSettings: (patch: any) => invokeHost('watermark:update-settings', patch),
    removeWatermarkJob: (jobId: string) => invokeHost('watermark:remove-job', { jobId }),
    clearWatermarkJobs: (mode: string) => invokeHost('watermark:clear-jobs', { mode }),
    retryWatermarkJobs: () => invokeHost('watermark:retry-failed'),
    startWatermarkBatch: () => invokeHost('watermark:start'),
    cancelWatermarkBatch: () => invokeHost('watermark:cancel'),
    openWatermarkPath: (targetPath: string) => invokeHost('watermark:open-path', { targetPath }),
    onWatermarkState: (cb: any) => onEvent('bos:watermark-state', cb),

    onTrayNavigate: (cb: any) => onEvent('bos:tray-navigate', cb),
    prepareMusicDrag: (input: any) => invokeHost('prepare-music-drag', input),
    startMusicDrag: (token: string) => { void invokeHost('start-music-drag', { token }); },
    onMusicDragError: (cb: any) => onEvent('bos:music-drag-error', cb),

    getPeriodKeeperStatus: () => invokeHost('period-status'),
    probePeriodKeeper: () => invokeHost('period-probe'),
    setPeriodKeeperEnabled: (enabled: boolean, mode: string) => invokeHost('period-enabled', { enabled, mode }),
    setBatchPunctuationEnabled: (enabled: boolean) => invokeHost('period-enabled', { enabled: Boolean(enabled), mode: 'compatible' }),
    copySubtitleText: (text: string) => invokeHost('period-copy', { text: String(text ?? '') }),

    jianyingAction: (action: string, args: any, connection: any) => {
      if (connection) lastJyConnection = connection;
      return invokeHost('jianying-action', { action, args: args || {} });
    },
    chooseJianyingFiles: () => invokeHost('jianying-files'),
    quickLaunch: (action: string, value: any) => invokeHost('quick-launch', { action, value }),
    chooseDirectory: () => invokeHost('choose-directory'),
    writeCache: (payload: any) => invokeHost('write-cache', payload),
    readCache: (payload: any) => invokeHost('read-cache', payload),
    downloadAudio: (payload: any) => invokeHost('download-audio', payload),
    exportScriptMaterials: async (payload: any) => {
      const job = payload?.job || {};
      const input = validateScoreRequest(job);
      const local = job.source === 'library';
      const score = local ? undefined : parseScoreResponse(JSON.stringify(job.score), input.durationSeconds);
      if (!local) {
        return invokeHost('download-audio', {
          directory: payload.directory,
          url: job.primary?.audioUrl,
          fileName: musicFileStem(score) + '.mp3',
        });
      }
      const analysis = parseKeywords(JSON.stringify(job.analysis));
      const texts = materialTexts({ ...input, source: 'library', score, analysis, localTrack: job.localTrack, matchReason: String(job.matchReason || '') });
      return invokeHost('export-script-materials', {
        directory: payload.directory,
        title: input.title || '剧本配乐',
        localTrackId: job.localTrack?.id,
        texts,
      });
    },
    getMusicLibrary: () => invokeHost('music-library-list'),
    connectMusicLibrary: () => invokeHost('music-library-connect'),
    refreshMusicLibrary: () => invokeHost('music-library-refresh'),
    disconnectMusicLibrary: (id: string) => invokeHost('music-library-disconnect', { id }),

    getUpdaterStatus: () => invokeHost('updater-status'),
    updaterAction: (action: string) => invokeHost('updater-action', { action }),
    onUpdaterState: (cb: any) => onEvent('bos:updater-state', cb),
    setTitleBarTheme: (scheme: string) => invokeHost('titlebar-theme', { scheme }),
    companionAction: (action: string, value: any) => invokeHost('companion-action', { action, value }),
    onCompanionState: (cb: any) => onEvent('bos:companion-state', cb),
    windowControl: (action: string) => invokeHost('window-control', { action }),
  };

  // Mount native window control buttons (Min / Max / Close) and titlebar drag handler ONLY on main window (never on floating companion windows)
  window.addEventListener('DOMContentLoaded', () => {
    if (window.location.pathname.includes('companion')) return;
    let lastSyncedProvidersJson = '';
    const syncProvidersToHost = () => {
      try {
        const raw = localStorage.getItem('black-obsidian.providers.v1') || localStorage.getItem('xm.providers.cache') || '';
        if (raw && raw !== lastSyncedProvidersJson) {
          lastSyncedProvidersJson = raw;
          try { localStorage.setItem('xm.providers.cache', raw); } catch {}
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            void invokeHost('companion-action', { action: 'sync-providers', value: parsed });
          }
        }
      } catch {}
    };
    syncProvidersToHost();
    setInterval(syncProvidersToHost, 1500);
    const bar = document.createElement('div');
    bar.className = 'bos-wv2-window-controls';
    bar.style.cssText = 'position:fixed;top:0;right:0;height:36px;width:138px;z-index:9999;display:grid;grid-template-columns:repeat(3,46px);-webkit-app-region:no-drag;user-select:none;';
    const mkBtn = (label: string, action: string, isClose = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = action === 'min' ? '最小化' : action === 'max' ? '最大化/还原' : '关闭';
      b.style.cssText = 'border:0;background:transparent;color:var(--ui-muted,#a1a8a5);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s;';
      b.onmouseenter = () => { b.style.background = isClose ? '#e81123' : 'rgba(255,255,255,0.08)'; b.style.color = '#fff'; };
      b.onmouseleave = () => { b.style.background = 'transparent'; b.style.color = 'var(--ui-muted,#a1a8a5)'; };
      b.onclick = () => invokeHost('window-control', { action });
      return b;
    };
    bar.append(mkBtn('─', 'min'), mkBtn('□', 'max'), mkBtn('✕', 'close', true));
    document.body.appendChild(bar);

    document.addEventListener('pointerdown', (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('button, a, input, select, textarea, .bos-titlebar-actions, .bos-wv2-window-controls')) return;
      if (target.closest('.bos-titlebar, header')) {
        void invokeHost('window-control', { action: 'drag' });
      }
    });
    document.addEventListener('dblclick', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('.bos-titlebar') && !target.closest('button, .bos-titlebar-actions, .bos-wv2-window-controls')) {
        void invokeHost('window-control', { action: 'max' });
      }
    });
  });
}
