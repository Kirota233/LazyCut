import { MusicDragButton } from './MusicDragButton.jsx';
import { connectScriptQueue } from './ScriptQueueBridge.mjs';
import { SCRIPT_LIMIT, splitScript, isScriptAnalysisModel, isSunoModel } from '../shared/script-score.mjs';
import { QUEUE_KEY, createScriptQueue } from '../shared/script-queue.mjs';
import { importScriptScore, syncScriptMusic } from './MusicStudio.jsx';
import { MusicLibrary, clearCurrentLibraryMatch } from './MusicLibrary.tsx';
import { usePanelCollapsed } from './PanelState.jsx';
import { useScriptProjects } from './ScriptProjects.jsx';
import { PeriodKeeper, copySubtitleText } from './PeriodKeeper.tsx';
import { findSegmentJob } from '../shared/segment-shortcut.mjs';
import { installMusicPlayback } from './music-playback.mjs';
import { WEB_ANALYZERS, webAnalyzer, analysisName, analysisReady, openWebAnalyzer } from '../shared/script-analyzers.mjs';
import { requestScriptAnalysis } from './AnalysisRequest.mjs';
import { splitDramaEpisodes, extractTextFromDocxArrayBuffer } from '../shared/drama-episodes.mjs';
import type { ModelOption, ProviderConfig, SubtitleLine, WorkspaceTab } from './types.ts';

declare const i: any;

const DRAFT = 'black-obsidian.script-draft.v1';
const SETTINGS = 'black-obsidian.script-settings.v1';
let runtime: any;
let providersNow: ProviderConfig[] = [];

const read = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) as string) ?? fallback;
  } catch {
    return fallback;
  }
};

function getRuntime() {
  if (runtime) return runtime;
  let saved: any[] = [];
  let loadError = '';
  try {
    saved = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    loadError = '任务缓存无法读取。请保留现有缓存，修复后再提交。';
  }
  const options = {
    initial: saved,
    save: (jobs: any[]) => {
      if (loadError) throw new Error(loadError);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(jobs));
    },
    getProvider: (id: string) => providersNow.find(p => p.id === id),
    request: async (url: string, body: any) => {
      if (url === '/api/script/score') {
        return requestScriptAnalysis('score', body, webAnalyzer(body.provider) ? undefined : AbortSignal.timeout(body.provider?.protocol === 'ollama' ? 720000 : 135000));
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(url.endsWith('generate') ? 195000 : 135000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `请求失败（HTTP ${response.status}）`);
      return result;
    },
    exportMaterials: (payload: any) => {
      if (!(globalThis as any).blackObsidian?.exportScriptMaterials) {
        throw new Error('导出本地素材需要使用更新后的桌面程序。');
      }
      return (globalThis as any).blackObsidian.exportScriptMaterials(payload);
    },
    onComplete: syncScriptMusic,
    onArchive: syncScriptMusic,
  };
  try {
    runtime = createScriptQueue(options);
  } catch (error: any) {
    loadError = error.message;
    runtime = createScriptQueue({ ...options, initial: [] });
  }
  runtime.loadError = loadError;
  connectScriptQueue(runtime);
  return runtime;
}

export function useScriptAutomation(providers: ProviderConfig[]) {
  providersNow = providers;
  try {
    if (typeof localStorage !== 'undefined' && Array.isArray(providers)) {
      localStorage.setItem('xm.providers.cache', JSON.stringify(providers));
    }
  } catch {
    /* ignore */
  }
  const queue = getRuntime();
  const state = i.useSyncExternalStore(queue.subscribe, queue.snapshot);
  i.useEffect(() => {
    for (const job of queue.snapshot().jobs) {
      if (job.archived || (job.status === 'complete' && job.primary && (job.score || job.source === 'library'))) {
        try {
          syncScriptMusic(job);
        } catch {
          /* Queue remains durable. */
        }
      }
    }
    const timer = setInterval(() => {
      void queue.tick();
    }, 1000);
    const disposePlayback = installMusicPlayback(document);
    return () => {
      clearInterval(timer);
      disposePlayback();
    };
  }, [queue]);
  return { queue, ...state };
}

const labels: Record<string, string> = {
  queued: '等待处理',
  planning: '模型策划中',
  ready: '提示词就绪',
  submitting: '提交 Suno 中',
  pending: '配乐生成中',
  complete: '配乐已完成',
  uncertain: '待核对提交',
  pausedQuery: '查询已暂停',
  error: '需要处理',
};

export interface ScriptAutomationProps {
  providers: ProviderConfig[];
  automation: any;
  onNavigate: (tab: WorkspaceTab) => void;
}

export function ScriptAutomation({ providers, automation, onNavigate }: ScriptAutomationProps) {
  const { queue, running, notice } = automation;
  const jobs: any[] = automation.jobs.filter((job: any) => !job.archived);
  const projects = useScriptProjects();
  const draft = projects.project.draft;
  const [directory, setDirectory] = i.useState(
    () => read<any>(SETTINGS, {}).directory || read<any>('black-obsidian.music-settings.v1', {}).downloadDirectory || ''
  );
  const [localDirectory, setLocalDirectory] = i.useState(
    () => read<any>(SETTINGS, {}).localDirectory ?? read<any>(SETTINGS, {}).directory ?? ''
  );
  const [error, setError] = i.useState('');
  const [message, setMessage] = i.useState('');
  const [collapsed, toggleCollapsed] = usePanelCollapsed('script');
  const [linesCollapsed, toggleLinesCollapsed] = usePanelCollapsed('english-lines');
  const [recovery, setRecovery] = i.useState<Record<string, string>>({});
  const [confirm, setConfirm] = i.useState('');
  const [opened, setOpened] = i.useState('');
  const [viewMode, setViewMode] = i.useState<'script' | 'library' | 'queue'>('script');
  const [splittingEpisodes, setSplittingEpisodes] = i.useState(false);
  const dramaFileRef = i.useRef(null as HTMLInputElement | null);
  const tabsScrollRef = i.useRef(null as HTMLDivElement | null);

  const models: ModelOption[] = providers.flatMap(provider =>
    (provider.models || []).map(model => ({
      key: `${provider.id}::${model}`,
      providerId: provider.id,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      provider,
      model,
    }))
  );
  const geminis: ModelOption[] = [...models.filter(m => isScriptAnalysisModel(m.provider, m.model)), ...(WEB_ANALYZERS as ModelOption[])];
  const sunos: ModelOption[] = models.filter(m => isSunoModel(m.provider, m.model));
  const gemini = geminis.find(m => m.key === draft.geminiKey) || geminis[0];
  const libraryGemini = geminis.find(m => m.key === draft.libraryGeminiKey) || geminis[0];
  const libraryAnalyzerName = analysisName(libraryGemini);
  const analyzerName = analysisName(gemini);
  const stages = ['提取字幕', 'AI 分析剧本', '选择或生成音乐', '剪映素材'];
  const suno = sunos.find(m => m.key === draft.sunoKey) || sunos[0];

  const extraction = i.useMemo(() => {
    try {
      return {
        lines: draft.script.trim() ? splitScript(draft.script, draft.subtitleLanguage || 'auto') : [],
        error: '',
      };
    } catch (err: any) {
      return { lines: [], error: err.message };
    }
  }, [draft.script, draft.subtitleLanguage]);

  const subtitleLines: SubtitleLine[] = extraction.lines;
  const change = (values: Record<string, any>) => {
    projects.change(values);
    setError('');
  };

  const perform = async (fn: () => any) => {
    setError('');
    try {
      await fn();
    } catch (err: any) {
      setError(err.message || '操作失败。');
    }
  };

  const clearCurrent = () =>
    perform(() => {
      queue.clear();
      clearCurrentLibraryMatch(projects.project.id, draft);
      projects.clearCurrent();
      setError('');
      setMessage('已清空当前内容和配乐任务，作品历史保留在「音乐 → 我的作品」。');
    });

  const enqueue = (start: boolean) =>
    perform(() => {
      if (!gemini || !suno) throw new Error('请选择剧本分析模型，并配置 Suno 音乐模型。');
      if (!analysisReady(gemini) || !suno.provider.apiKey?.trim()) {
        throw new Error('所选 API 连接缺少密钥，请先补充；网页版分析需先登录账号。');
      }
      if (extraction.error) throw new Error(extraction.error);
      const lines = subtitleLines;
      const id = queue.add({ ...draft, lines }, gemini, suno, directory);
      setOpened(id);
      change({ script: '', title: '' });
      setMessage(
        draft.segmented
          ? `剧本已加入分段配乐队列；${analyzerName} 完成策划后将展开为多个独立音乐任务。`
          : '剧本已加入队列；可继续粘贴下一份剧本。'
      );
      if (start) queue.start();
    });

  const chooseDirectory = (local = false) =>
    perform(async () => {
      if (!(globalThis as any).blackObsidian?.chooseDirectory) throw new Error('请在桌面程序中选择保存目录。');
      const selected = await (globalThis as any).blackObsidian.chooseDirectory();
      if (selected) {
        localStorage.setItem(
          SETTINGS,
          JSON.stringify({ ...read<any>(SETTINGS, {}), [local ? 'localDirectory' : 'directory']: selected })
        );
        (local ? setLocalDirectory : setDirectory)(selected);
      }
    });

  const exportLines = () =>
    perform(() => {
      const url = URL.createObjectURL(
        new Blob([subtitleLines.map(l => l.text).join('\n')], { type: 'text/plain;charset=utf-8' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = '逐行字幕.txt';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

  const copyLines = () =>
    perform(async () => {
      const result = await copySubtitleText(subtitleLines.map(line => line.text).join('\n'));
      setMessage(
        result.clipboardProtected
          ? `已完整复制 ${result.copiedLines} 行台词，已按原工具保护标点，可粘贴到剪映。`
          : '已复制字幕台词，使用标准英文标点。'
      );
    });

  const useLocalMusic = (track: any, analysis: any, reason: string, lines: SubtitleLine[], segment?: any) => {
    if (extraction.error) throw new Error(extraction.error);
    const id = queue.addLocal(
      { ...draft, lines, title: segment ? `${draft.title.slice(0, 45)} · ${segment.title}` : draft.title },
      track,
      analysis,
      reason,
      localDirectory,
      window.location.origin
    );
    setOpened(id);
    setMessage(localDirectory ? '已选用本地音乐，正在准备导出素材。' : '已选用本地音乐。选择素材文件夹后，可从下方任务导出。');
  };

  const segmentJob = (segment: any) => {
    try {
      return findSegmentJob(automation.jobs, { ...draft, lines: subtitleLines }, segment, projects.project.id);
    } catch {
      return null;
    }
  };

  const viewSegmentJob = (job: any) => {
    if (job.archived) {
      onNavigate('music');
      return;
    }
    setOpened(job.id);
    if (collapsed) toggleCollapsed();
    if (viewMode !== 'all' && viewMode !== 'queue') setViewMode('queue');
    setTimeout(() => document.getElementById('bos-script-queue-body')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  const generateSegment = (segment: any) => {
    if (queue.loadError) throw new Error(queue.loadError);
    if (!analysisReady(gemini) || !suno?.provider.apiKey?.trim()) {
      throw new Error('请选择可用的剧本分析模型，并配置 Suno 模型及 API 密钥。');
    }
    if (extraction.error) throw new Error(extraction.error);
    const id = queue.addSegment({ ...draft, lines: subtitleLines }, segment, projects.project.id, gemini, suno, directory);
    queue.startOnly(id);
    setOpened(id);
    setMessage('已为「' + segment.title + '」启动配乐任务，当前剧本和其他情节推荐已保留。');
  };

  const complete = jobs.filter(j => j.status === 'complete').length;
  const selectModel = (label: string, list: ModelOption[], selected: ModelOption | undefined, key: string) => (
    <label>
      <span>{label}</span>
      <select aria-label={label} value={selected?.key || ''} onChange={(e: any) => change({ [key]: e.target.value })}>
        {!list.length && <option value="">先添加模型与连接</option>}
        {list.map(m => (
          <option key={m.key} value={m.key} title={m.model}>
            {m.label || `${m.model} · ${m.provider.protocol === 'ollama' ? '本地部署' : m.provider.name}`}
          </option>
        ))}
      </select>
    </label>
  );

  const localSettings = (
    <div className="bos-local-match-settings">
      <div className="bos-script-section-title">
        <h4>本地音乐匹配</h4>
        <button type="button" onClick={() => onNavigate('providers')}>
          管理连接 ↗
        </button>
      </div>
      <div className="bos-local-match-grid">
        <div>
          {selectModel('本地匹配分析模型', geminis, libraryGemini, 'libraryGeminiKey')}
          {webAnalyzer(libraryGemini) && (
            <button type="button" onClick={() => openWebAnalyzer(libraryGemini)}>
              打开 {libraryAnalyzerName} 登录
            </button>
          )}
        </div>
        <label>
          <span>匹配方式</span>
          <select
            aria-label="本地音乐匹配方式"
            value={draft.segmented ? 'segments' : 'whole'}
            onChange={(event: any) => change({ segmented: event.target.value === 'segments' })}
          >
            <option value="whole">整篇剧本统一配乐</option>
            <option value="segments">按情节分段配乐</option>
          </select>
        </label>
        {draft.segmented && (
          <label>
            <span>最多情节段数</span>
            <select
              aria-label="本地匹配最多情节段数"
              value={draft.segmentCount || 3}
              onChange={(event: any) => change({ segmentCount: Number(event.target.value) })}
            >
              {[2, 3, 4, 5, 6].map(count => (
                <option value={count} key={count}>
                  {count} 段
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>剪映素材文件夹</span>
          <div className="bos-script-folder">
            <input
              aria-label="剪映素材文件夹"
              readOnly
              value={localDirectory}
              placeholder="选择后自动导出素材"
            />
            <button type="button" onClick={() => chooseDirectory(true)}>
              选择
            </button>
          </div>
        </label>
      </div>
    </div>
  );

  return (
    <section className="bos-script" data-view-mode={viewMode} aria-labelledby="bos-script-title">
      {/* Top-Level Prominent 3-Stage Navigation Bar */}
      <nav className="bos-top-stage-bar" role="tablist" aria-label="剧本与配乐核心工作台分栏">
        <button
          type="button"
          role="tab"
          className={`bos-stage-tab ${viewMode === 'script' ? 'is-active' : ''}`}
          aria-selected={viewMode === 'script'}
          onClick={() => setViewMode('script')}
        >
          <span className="bos-stage-num">01</span>
          <div className="bos-stage-text">
            <strong>字幕与生成</strong>
            <small>提取对白字幕 · AI 分析剧本与生成配乐</small>
          </div>
        </button>

        <button
          type="button"
          role="tab"
          className={`bos-stage-tab ${viewMode === 'library' ? 'is-active' : ''}`}
          aria-selected={viewMode === 'library'}
          onClick={() => setViewMode('library')}
        >
          <span className="bos-stage-num">02</span>
          <div className="bos-stage-text">
            <strong>本地曲库</strong>
            <small>本地音乐索引 · 剧情关键词匹配与直拖剪映</small>
          </div>
        </button>

        <button
          type="button"
          role="tab"
          className={`bos-stage-tab ${viewMode === 'queue' ? 'is-active' : ''}`}
          aria-selected={viewMode === 'queue'}
          onClick={() => setViewMode('queue')}
        >
          <span className="bos-stage-num">03</span>
          <div className="bos-stage-text">
            <strong>任务队列 ({jobs.length})</strong>
            <small>{running ? '配乐队列运行中' : `已完成 ${complete}/${jobs.length} 项 · 剪映素材导出`}</small>
          </div>
        </button>
      </nav>

      <div className="bos-script-group bos-view-section bos-view-script">
        <header className="bos-script-heading">
          <div>
            <span className="bos-script-eyebrow">SCRIPT TO SOUND</span>
            <h2 id="bos-script-title">剧本与智能配乐工作台</h2>
            <p>自动提取对白字幕 · AI 剧情拆解 · 本地曲库匹配与 Suno 生成</p>
          </div>
          <div className="bos-panel-heading-actions">
            <span className="bos-script-badge">{running ? '队列运行中' : '就绪'}</span>
            <button
              type="button"
              className="bos-panel-toggle"
              onClick={clearCurrent}
              disabled={!draft.script && !draft.hint && !draft.customKeywords && !projects.project.recommendation && !jobs.length}
              title="清空当前内容和配乐任务列表"
            >
              清空当前内容
            </button>
            <button
              type="button"
              className="bos-panel-toggle"
              aria-expanded={!collapsed}
              aria-controls="bos-script-body bos-script-queue-body"
              onClick={toggleCollapsed}
            >
              {collapsed ? '展开工作台' : '收起工作台'} <span aria-hidden="true">{collapsed ? '⌄' : '⌃'}</span>
            </button>
          </div>
        </header>

        <div id="bos-script-body" hidden={collapsed}>
          {(error || queue.loadError || projects.storageError) && (
            <div className="bos-script-alert" role="alert">
              {error || queue.loadError || projects.storageError}
            </div>
          )}
          <div className="bos-project-bar">
            <div
              className="bos-project-tabs"
              role="tablist"
              aria-label="选择剧本或分集"
              ref={tabsScrollRef}
              onWheel={(e: any) => {
                if (tabsScrollRef.current && e.deltaY !== 0) {
                  tabsScrollRef.current.scrollLeft += e.deltaY;
                }
              }}
            >
              {projects.projects.map((p: any, index: number) => (
                <div className="bos-project-tab" key={p.id}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={p.id === projects.project.id}
                    title={p.draft.title}
                    onClick={() => projects.select(p.id)}
                  >
                    {p.draft.episodeLabel || `剧本 ${index + 1}`}
                    {p.recommendation && <span aria-label="已有推荐"> ·</span>}
                  </button>
                  <button
                    type="button"
                    className="bos-project-close"
                    aria-label={`关闭剧本 ${index + 1}`}
                    title="关闭并存入历史"
                    onClick={() => projects.close(p.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="bos-project-tools">
              <input
                ref={dramaFileRef}
                type="file"
                accept=".txt,.md,.srt,.docx"
                hidden
                onChange={async (e: any) => {
                  const file = e.target?.files?.[0];
                  if (e.target) e.target.value = '';
                  if (!file) return;
                  setSplittingEpisodes(true);
                  setError('');
                  try {
                    let rawText = '';
                    if (/\.docx$/i.test(file.name)) {
                      const buf = await file.arrayBuffer();
                      rawText = await extractTextFromDocxArrayBuffer(buf);
                    } else {
                      rawText = await file.text();
                    }
                    const episodes = splitDramaEpisodes(rawText);
                    const count = projects.importEpisodes(episodes);
                    setMessage(`已将「${file.name}」智能切分为 ${count} 集剧本（可在左侧分集栏左右滑动切换）。`);
                  } catch (err: any) {
                    setError(err?.message || '剧本分集解析失败。');
                  } finally {
                    setSplittingEpisodes(false);
                  }
                }}
              />
              <button
                type="button"
                className={splittingEpisodes ? 'is-loading' : ''}
                disabled={splittingEpisodes}
                title="上传整部剧完整剧本 (.txt / .md / .docx)，自动按集切分为列表"
                onClick={() => {
                  if (dramaFileRef.current) {
                    dramaFileRef.current.click();
                  } else if (draft.script.trim()) {
                    perform(() => {
                      const episodes = splitDramaEpisodes(draft.script);
                      const count = projects.importEpisodes(episodes);
                      setMessage(`已将当前完整剧本切分为 ${count} 集。`);
                    });
                  }
                }}
              >
                {splittingEpisodes && <span className="bos-btn-spinner" aria-hidden="true" />}
                {splittingEpisodes ? '正在切分剧集…' : '📂 上传整部剧本'}
              </button>
              {draft.script.trim().length > 120 && splitDramaEpisodes(draft.script).length >= 2 && (
                <button
                  type="button"
                  title="将当前输入框中的多集完整剧本自动按集切分"
                  onClick={() =>
                    perform(() => {
                      const episodes = splitDramaEpisodes(draft.script);
                      const count = projects.importEpisodes(episodes);
                      setMessage(`已将当前完整剧本智能切分为 ${count} 集（可左右滑动切换）。`);
                    })
                  }
                >
                  ✂️ 按集切分 ({splitDramaEpisodes(draft.script).length}集)
                </button>
              )}
              <button type="button" onClick={() => perform(projects.add)}>
                ＋ 新建剧本
              </button>
              <label>
                <span className="bos-visually-hidden">历史剧本</span>
                <select
                  aria-label="历史剧本"
                  value=""
                  onChange={(e: any) => perform(() => projects.restore(e.target.value))}
                >
                  <option value="">历史剧本 · {projects.history.length} / 5</option>
                  {projects.history.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.draft.title} · {p.recommendation ? '查看历史推荐' : '查看原文'}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!projects.history.length}
                onClick={() =>
                  perform(() => {
                    projects.clearHistory();
                    setMessage('历史剧本及其推荐已清空。');
                  })
                }
              >
                清空历史
              </button>
            </div>
          </div>

          <div className="bos-script-layout">
            <div className="bos-script-panel">
              <div className="bos-script-section-title">
                <h3>01 / 剧本与字幕</h3>
                <span>粘贴后自动提取</span>
              </div>
              <label>
                <span>
                  粘贴完整剧本 <small>{draft.script.length} / {SCRIPT_LIMIT.toLocaleString()}</small>
                </span>
                <textarea
                  className="bos-script-input"
                  rows={7}
                  maxLength={SCRIPT_LIMIT}
                  value={draft.script}
                  onPaste={(e: any) => {
                    const pasted = e.clipboardData?.getData?.('text/plain') || '';
                    if (pasted.trim().length > 60) {
                      const episodes = splitDramaEpisodes(pasted);
                      if (episodes.length >= 2) {
                        e.preventDefault();
                        perform(() => {
                          const count = projects.importEpisodes(episodes);
                          setMessage(`已自动识别并切分为 ${count} 集剧本（可在上方分集栏左右滑动切换）。`);
                        });
                      }
                    }
                  }}
                  onChange={(e: any) => {
                    const nextVal = e.target.value;
                    if (nextVal.length - draft.script.length > 60) {
                      const episodes = splitDramaEpisodes(nextVal);
                      if (episodes.length >= 2) {
                        perform(() => {
                          const count = projects.importEpisodes(episodes);
                          setMessage(`已自动识别并切分为 ${count} 集剧本（可在上方分集栏左右滑动切换）。`);
                        });
                        return;
                      }
                    }
                    change({ script: nextVal });
                  }}
                  placeholder={
                    '3-1 日 外 银泉庄园大门\n守卫甲：你好，请问二位有请柬吗？\n[EN] GUARD A: Good day. May I see your invitation?\n△ 车窗缓缓降下。\n凯尔：我来见我的家人。\n[EN] KYLE: I came to see my family.'
                  }
                />
              </label>
              <label>
                <span>字幕语言</span>
                <select
                  aria-label="字幕语言"
                  value={draft.subtitleLanguage || 'auto'}
                  onChange={(event: any) => change({ subtitleLanguage: event.target.value })}
                >
                  <option value="auto">自动识别英文 / 西语（保留原文顺序）</option>
                  <option value="en">仅英文 [EN]</option>
                  <option value="es">仅西语 [ES]</option>
                  <option value="zh">仅中文（角色：台词）</option>
                </select>
              </label>
              <div className="bos-script-lines">
                <div className="bos-script-section-title">
                  <strong>字幕台词 · {subtitleLines.length} 行</strong>
                  <div className="bos-script-actions">
                    <button type="button" disabled={!subtitleLines.length} onClick={copyLines}>
                      复制全部
                    </button>
                    <button type="button" disabled={!subtitleLines.length} onClick={exportLines}>
                      导出台词 TXT
                    </button>
                    <button
                      type="button"
                      className="bos-lines-toggle"
                      aria-label={linesCollapsed ? '展开台词框' : '收起台词框'}
                      title={linesCollapsed ? '展开台词框' : '收起台词框'}
                      aria-expanded={!linesCollapsed}
                      aria-controls="bos-english-body"
                      onClick={toggleLinesCollapsed}
                    >
                      {linesCollapsed ? '⌄' : '⌃'}
                    </button>
                  </div>
                </div>
                <PeriodKeeper text={subtitleLines.map(line => line.text).join('\n')} />
                <div id="bos-english-body" hidden={linesCollapsed}>
                  {extraction.error && <p className="bos-script-warning">{extraction.error}</p>}
                  {!subtitleLines.length && (
                    <p className="bos-english-empty">
                      {draft.script.trim()
                        ? draft.subtitleLanguage === 'zh'
                          ? '未找到中文角色台词。请使用“角色：台词”或“[ZH] 角色：台词”格式。'
                          : '未找到所选语言的字幕。请使用 [EN] 或 [ES] 标记，或切换为“仅中文”。'
                        : '粘贴剧本后，自动提取的对白字幕将显示于此。'}
                    </p>
                  )}
                  <div className="bos-english-lines" aria-label="提取的字幕台词">
                    {subtitleLines.map(line => (
                      <p key={line.id} lang={line.language || 'en'}>
                        {line.text}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="bos-script-panel bos-script-config">
              <div className="bos-script-section-title">
                <h3>02 / Suno 生成配乐</h3>
                <button type="button" onClick={() => onNavigate('providers')}>
                  管理连接 ↗
                </button>
              </div>
              {selectModel('剧本分析模型', geminis, gemini, 'geminiKey')}
              {webAnalyzer(gemini) && (
                <div className="bos-web-analyzer-note">
                  <p>{analyzerName} 内嵌网页免 Key 分析</p>
                  <button type="button" onClick={() => openWebAnalyzer(gemini)}>
                    打开 {analyzerName} 登录
                  </button>
                </div>
              )}
              <div className="bos-segment-settings">
                <label>
                  <span>配乐方式</span>
                  <select
                    aria-label="配乐方式"
                    value={draft.segmented ? 'segments' : 'whole'}
                    onChange={(event: any) => change({ segmented: event.target.value === 'segments' })}
                  >
                    <option value="whole">整篇剧本统一配乐</option>
                    <option value="segments">按情节分段配乐</option>
                  </select>
                </label>
                {draft.segmented && (
                  <label>
                    <span>最多情节段数</span>
                    <select
                      aria-label="最多情节段数"
                      value={draft.segmentCount || 3}
                      onChange={(event: any) => change({ segmentCount: Number(event.target.value) })}
                    >
                      {[2, 3, 4, 5, 6].map(count => (
                        <option value={count} key={count}>
                          {count} 段
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {selectModel('Suno 音乐模型', sunos, suno, 'sunoKey')}
              <label>
                <span>{draft.segmented ? '每段目标时长 / 秒' : '目标时长 / 秒'}</span>
                <input
                  type="number"
                  min={15}
                  max={480}
                  value={draft.durationSeconds}
                  onChange={(e: any) => change({ durationSeconds: e.target.value })}
                />
              </label>
              <label>
                <span>音乐保存目录</span>
                <div className="bos-script-folder">
                  <input
                    aria-label="音乐保存目录"
                    readOnly
                    value={directory}
                    placeholder="生成完成后自动归档目录"
                  />
                  <button type="button" onClick={() => chooseDirectory()}>
                    选择
                  </button>
                </div>
              </label>
              <div className="bos-script-submit">
                <button
                  type="button"
                  onClick={() => enqueue(false)}
                  disabled={!draft.script.trim() || !!queue.loadError}
                >
                  加入队列
                </button>
                <button
                  type="button"
                  className="bos-script-primary"
                  onClick={() => enqueue(true)}
                  disabled={!draft.script.trim() || !!queue.loadError}
                >
                  {draft.segmented ? '一键生成多段配乐 ↗' : '一键生成配乐 ↗'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="bos-view-section bos-view-library">
        <MusicLibrary
          key={projects.project.id}
          input={draft}
          projectId={projects.project.id}
          savedRecommendation={projects.project.recommendation}
          onAnalysis={projects.remember}
          onChange={change}
          lines={subtitleLines}
          gemini={libraryGemini}
          generationAnalyzer={gemini}
          settings={localSettings}
          onUse={useLocalMusic}
          onGenerate={generateSegment}
          segmentJob={segmentJob}
          onViewJob={viewSegmentJob}
        />
      </div>

      <div id="bos-script-queue-body" className="bos-view-section bos-view-queue" hidden={collapsed}>
        {(message || notice) && (
          <p role="status" className="bos-script-message">
            {notice || message}
          </p>
        )}
        <section className="bos-script-queue" aria-label="剧本配乐任务队列">
          <div className="bos-script-queue-heading">
            <div>
              <span className="bos-script-eyebrow">PRODUCTION QUEUE</span>
              <h3>
                配乐任务 <small>{complete} / {jobs.length} 已完成</small>
              </h3>
            </div>
            <div className="bos-script-actions">
              <button type="button" disabled={!jobs.length} onClick={() => perform(queue.clear)}>
                清空任务
              </button>
              {running ? (
                <button type="button" onClick={queue.pause}>
                  暂停后续提交
                </button>
              ) : (
                <button
                  type="button"
                  className="bos-script-primary"
                  disabled={!jobs.some(j => ['queued', 'ready'].includes(j.status)) || !!queue.loadError}
                  onClick={() => perform(queue.start)}
                >
                  开始队列
                </button>
              )}
              <span>{running ? '运行中' : '待命'}</span>
            </div>
          </div>
          {!jobs.length && (
            <div className="bos-script-empty">
              <span>♫</span>
              <strong>暂无配乐任务</strong>
              <p>提交剧本或选用曲库配乐后，生成进度与剪映素材将在此汇总。</p>
            </div>
          )}
          {jobs.map((job, index) => (
            <article key={job.id} className="bos-script-job" data-status={job.status}>
              <div className="bos-script-job-heading">
                <div className="bos-script-job-number">{String(index + 1).padStart(2, '0')}</div>
                <div>
                  <h4>{job.title}</h4>
                  <small>
                    {job.lines.filter((l: any) => l.kind !== 'scene').length} 行台词 ·{' '}
                    {job.source === 'library'
                      ? `本地音乐 · ${job.localTrack.title}`
                      : `目标 ${job.durationSeconds} 秒 · ${job.suno.model}`}
                  </small>
                </div>
                <span className="bos-script-state">
                  {job.source === 'library'
                    ? '已选用本地音乐'
                    : job.status === 'planning'
                      ? `${analysisName(job.gemini)} 策划中`
                      : labels[job.status] || job.status}
                </span>
              </div>
              {job.segment && (
                <p className="bos-script-footnote">
                  情节：{job.segment.title} · 第 {job.segment.startLine}–{job.segment.endLine} 行 · {job.segment.summary}
                </p>
              )}
              {job.error && <p className="bos-script-warning">{job.error}</p>}
              {!!job.taskIds.length && <p className="bos-script-ids">任务 ID：{job.taskIds.join('、')}</p>}
              {job.primary && (
                <>
                  <audio controls preload="none" src={job.primary.audioUrl} aria-label={`${job.title} 配乐试听`} />
                  <MusicDragButton
                    libraryId={job.source === 'library' ? job.localTrack.id : ''}
                    url={job.primary.audioUrl}
                    filePath={job.source === 'library' ? '' : job.exportPath}
                  />
                </>
              )}
              {job.source === 'library' && (
                <details>
                  <summary>查看匹配理由与字幕台词</summary>
                  <p>{job.analysis.summary}</p>
                  <p>{job.analysis.keywords.join(' · ')}</p>
                  <p>{job.matchReason}</p>
                  <pre>{job.lines.map((line: any) => line.text).join('\n')}</pre>
                </details>
              )}
              {job.score && (
                <details
                  open={opened === job.id}
                  onToggle={(e: any) => {
                    if (e.currentTarget.open) setOpened(job.id);
                    else if (opened === job.id) setOpened('');
                  }}
                >
                  <summary>查看 {analysisName(job.gemini)} 配乐方案与台词</summary>
                  <p>{job.score.summary}</p>
                  <div className="bos-script-score">
                    <div>
                      <strong>音乐风格</strong>
                      <p>{job.score.style}</p>
                    </div>
                    <div>
                      <strong>音乐结构</strong>
                      <pre>{job.score.prompt}</pre>
                    </div>
                  </div>
                  <details>
                    <summary>查看整理后的 {job.lines.length} 行文本</summary>
                    <pre>
                      {job.lines
                        .map((l: any) => `${l.kind === 'scene' ? '【场景】' : l.speaker ? l.speaker + '：' : ''}${l.text}`)
                        .join('\n')}
                    </pre>
                  </details>
                  <button
                    type="button"
                    onClick={() =>
                      perform(() => {
                        importScriptScore(job);
                        onNavigate('music');
                      })
                    }
                  >
                    导入音乐页继续编辑
                  </button>
                </details>
              )}
              {job.status === 'uncertain' && (
                <div className="bos-script-recovery">
                  <label>
                    <span>从服务商记录找回任务 ID</span>
                    <input
                      aria-label={`恢复任务 ${job.title}`}
                      value={recovery[job.id] || ''}
                      onChange={(e: any) => setRecovery((r: any) => ({ ...r, [job.id]: e.target.value }))}
                      placeholder="多个 ID 用逗号分隔"
                    />
                  </label>
                  <button type="button" onClick={() => perform(() => queue.recover(job.id, recovery[job.id]))}>
                    恢复查询
                  </button>
                  <button type="button" onClick={() => setConfirm(job.id)}>
                    服务商未收到任务
                  </button>
                  {confirm === job.id && (
                    <div className="bos-script-warning">
                      <p>确认服务商无此记录后可重试提交。</p>
                      <button
                        type="button"
                        onClick={() =>
                          perform(() => {
                            queue.confirmNotSubmitted(job.id);
                            setConfirm('');
                          })
                        }
                      >
                        已核对未提交，允许重试
                      </button>
                      <button type="button" onClick={() => setConfirm('')}>
                        取消
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="bos-script-job-actions">
                {job.status === 'pausedQuery' && (
                  <button type="button" onClick={() => perform(() => queue.recover(job.id))}>
                    继续查询原任务
                  </button>
                )}
                {job.status === 'error' && job.phase !== 'music' && (
                  <button type="button" onClick={() => perform(() => queue.retryPlan(job.id))}>
                    修复后重新排队
                  </button>
                )}
                {job.status === 'complete' && (
                  <button
                    type="button"
                    disabled={job.exportState === 'exporting'}
                    onClick={() =>
                      perform(() => queue.export(job.id, job.source === 'library' ? localDirectory : directory))
                    }
                  >
                    {job.exportState === 'exporting'
                      ? '正在保存…'
                      : job.source === 'library'
                        ? job.exportState === 'done'
                          ? '再次导出素材'
                          : '导出剪映素材'
                        : job.exportState === 'done'
                          ? '再次保存音乐'
                          : '保存音乐'}
                  </button>
                )}
                {['queued', 'ready', 'error', 'complete'].includes(job.status) && (
                  <button
                    type="button"
                    disabled={job.exportState === 'exporting'}
                    onClick={() => perform(() => queue.remove(job.id))}
                  >
                    移除记录
                  </button>
                )}
              </div>
              {job.exportPath && <p className="bos-script-export">已保存：{job.exportPath}</p>}
              {job.exportError && <p className="bos-script-warning">保存失败：{job.exportError}</p>}
            </article>
          ))}
        </section>
      </div>
    </section>
  );
}
