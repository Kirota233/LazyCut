declare const i: any;

export interface WatermarkJob {
  id: string;
  inputPath: string;
  fileName: string;
  sizeBytes: number;
  outputPath: string;
  status: 'pending' | 'processing' | 'done' | 'error' | 'cancelled';
  progress: number;
  elapsedMs: number;
  error: string;
}

export interface WatermarkSettings {
  mode: 'text' | 'image';
  watermarkText: string;
  watermarkImage: string;
  position: 'fullscreen' | 'tile' | 'bottom-right' | 'top-right' | 'top-left' | 'bottom-left' | 'center';
  opacity: number;
  scale: number;
  size: 'original' | '1080p' | '720p' | '480p';
  crf: number;
  audioMode?: 'auto' | 'aac';
  outputDir: string;
  suffix: string;
}

export interface WatermarkState {
  engine: string;
  running: boolean;
  totalCount: number;
  completedCount: number;
  errorCount: number;
  overallProgress: number;
  activeJobId: string;
  activeFileName: string;
  settings: WatermarkSettings;
  jobs: WatermarkJob[];
}

export const DEFAULT_WATERMARK_STATE: WatermarkState = {
  engine: 'windows-media-foundation-hw',
  running: false,
  totalCount: 0,
  completedCount: 0,
  errorCount: 0,
  overallProgress: 0,
  activeJobId: '',
  activeFileName: '',
  settings: {
    mode: 'image',
    watermarkText: '内部样片 · 严禁外传',
    watermarkImage: 'builtin',
    position: 'fullscreen',
    opacity: 1,
    scale: 0.28,
    size: 'original',
    crf: 23,
    audioMode: 'auto',
    outputDir: '',
    suffix: '样片',
  },
  jobs: [],
};

const POSITION_OPTIONS: Array<{ id: WatermarkSettings['position']; label: string; desc: string }> = [
  { id: 'fullscreen', label: '原版全画幅覆盖', desc: '1:1 还原 watermarker 红薯样片图层' },
  { id: 'tile', label: '满屏斜纹防盗', desc: '全画幅斜向阵列平铺' },
  { id: 'top-left', label: '左上角标', desc: '左上安全区' },
  { id: 'top-right', label: '右上角标', desc: '右上安全区' },
  { id: 'bottom-left', label: '左下角标', desc: '左下安全区' },
  { id: 'bottom-right', label: '右下角标', desc: '经典角标位置' },
  { id: 'center', label: '画面正中', desc: '强防盗中心醒目' },
];

const TEXT_PRESETS = [
  '内部样片 · 严禁外传',
  '初剪审片 · 禁止商用',
  'XM Studio 样片预览',
  '仅限客户审阅 · 盗用必究',
];

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '本地视频';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatElapsed(ms: number): string {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function baseName(filePath: string): string {
  if (!filePath) return '';
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

export interface WatermarkStudioProps {
  active: boolean;
}

export function WatermarkStudio({ active }: WatermarkStudioProps) {
  const [state, setState] = i.useState<WatermarkState>(DEFAULT_WATERMARK_STATE);
  const [startingBatch, setStartingBatch] = i.useState(false);
  const [dragging, setDragging] = i.useState(false);
  const [notice, setNotice] = i.useState('');
  const [textDraft, setTextDraft] = i.useState(DEFAULT_WATERMARK_STATE.settings.watermarkText);
  const [suffixDraft, setSuffixDraft] = i.useState(DEFAULT_WATERMARK_STATE.settings.suffix);

  const bridge = (globalThis as any).window?.blackObsidian || (globalThis as any).blackObsidian;

  const syncState = (next: WatermarkState | null | undefined) => {
    if (!next || typeof next !== 'object') return;
    setState(next);
    if (next.settings?.watermarkText !== undefined) {
      setTextDraft(next.settings.watermarkText);
    }
    if (next.settings?.suffix !== undefined) {
      setSuffixDraft(next.settings.suffix);
    }
    if (typeof (globalThis as any).window?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      (globalThis as any).window.dispatchEvent(new CustomEvent('bos:watermark-state-sync', { detail: next }));
    }
  };

  i.useEffect(() => {
    let mounted = true;
    bridge?.getWatermarkState?.().then((initial: WatermarkState) => {
      if (mounted && initial) syncState(initial);
    }).catch(() => {});
    const off = bridge?.onWatermarkState?.((next: WatermarkState) => {
      if (mounted && next) syncState(next);
    });
    return () => {
      mounted = false;
      if (typeof off === 'function') off();
    };
  }, [bridge]);

  const updateSettings = async (patch: Partial<WatermarkSettings>) => {
    try {
      const next = await bridge?.updateWatermarkSettings?.(patch);
      if (next) syncState(next);
    } catch (err: any) {
      setNotice(err?.message || '保存水印配置失败');
    }
  };

  const handleChooseVideos = async () => {
    try {
      setNotice('');
      const next = await bridge?.chooseWatermarkVideos?.();
      if (next) syncState(next);
    } catch (err: any) {
      setNotice(err?.message || '添加视频失败');
    }
  };

  const handleChooseImage = async () => {
    try {
      setNotice('');
      const next = await bridge?.chooseWatermarkImage?.();
      if (next) syncState(next);
    } catch (err: any) {
      setNotice(err?.message || '选择水印图片失败');
    }
  };

  const handleChooseOutputDir = async () => {
    try {
      setNotice('');
      const next = await bridge?.chooseWatermarkOutputDir?.();
      if (next) syncState(next);
    } catch (err: any) {
      setNotice(err?.message || '选择输出目录失败');
    }
  };

  const handleDropFiles = async (event: any) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const fileList = Array.from(event.dataTransfer?.files || []) as File[];
    const videoFiles = fileList.filter(f => /\.(mp4|mov|mkv|avi|m4v|webm)$/i.test(f.name));
    if (videoFiles.length === 0) {
      setNotice('请拖入 MP4 / MOV / MKV / AVI 等本地视频文件');
      return;
    }
    try {
      setNotice('');
      const next = await bridge?.addWatermarkVideos?.(videoFiles);
      if (next) syncState(next);
    } catch (err: any) {
      setNotice(err?.message || '拖入视频失败');
    }
  };

  const handleStartBatch = async () => {
    if (startingBatch) return;
    setStartingBatch(true);
    try {
      setNotice('');
      const next = await bridge?.startWatermarkBatch?.();
      if (next) syncState(next);
    } catch (err: any) {
      setNotice(err?.message || '启动批量水印失败');
    } finally {
      setStartingBatch(false);
    }
  };

  const handleCancelBatch = async () => {
    try {
      const next = await bridge?.cancelWatermarkBatch?.();
      if (next) syncState(next);
    } catch (err: any) {
      setNotice(err?.message || '取消任务失败');
    }
  };

  const { settings, jobs, running, totalCount, completedCount, errorCount, overallProgress } = state;
  const pendingCount = jobs.filter(j => j.status === 'pending' || j.status === 'error' || j.status === 'cancelled').length;
  const isBuiltinPng = settings.mode === 'image' && (!settings.watermarkImage || settings.watermarkImage === 'builtin');
  const displayLabel = settings.mode === 'image'
    ? (isBuiltinPng ? '红薯样片 (内置 watermark.png)' : `[图标] ${baseName(settings.watermarkImage)}`)
    : (settings.watermarkText || '内部样片 · 严禁外传');

  return (
    <section className="bos-watermark-native" hidden={!active} aria-label="原生硬件加速样片水印">
      <div className="bos-wm-layout">
        {/* Left Inspector Column */}
        <aside className="bos-wm-inspector">
          {/* Interactive Live Preview Card */}
          <div className="bos-wm-card bos-wm-preview-card">
            <div className="bos-wm-card-head">
              <div>
                <span className="bos-wm-eyebrow">MEDIA FOUNDATION HW</span>
                <h3>实时画面水印预览</h3>
              </div>
              <span className="bos-wm-engine-badge">C# 原生硬件加速</span>
            </div>

            <div
              className={`bos-wm-stage pos-${settings.position}`}
              title="点击画面不同区域可快速切换水印位置"
            >
              <div className="bos-wm-stage-grid" />
              <div className="bos-wm-stage-Safebox">
                <span className="bos-wm-stage-tag">{isBuiltinPng ? '红薯样片原版图层 (watermark.png)' : '样片画幅预览'}</span>
                <span className="bos-wm-stage-res">
                  {(!settings.size || settings.size === 'original') ? '原画分辨率直出' : String(settings.size).toUpperCase()}
                </span>
              </div>

              {/* Watermark Overlay Rendering — strictly built-in watermark.png fullscreen */}
              <img
                src="/watermark.png"
                alt="红薯样片水印预览"
                className="bos-wm-builtin-img"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  objectPosition: 'left top',
                  opacity: 1,
                  pointerEvents: 'none',
                  zIndex: 1,
                }}
              />
            </div>
          </div>

          {/* Watermark Info & Output Directory Controls */}
          <div className="bos-wm-card">
            <div className="bos-wm-field-group">
              <label className="bos-wm-label">水印图层（watermarker 原版全画幅覆盖）</label>
              <div className="bos-wm-input-row">
                <div className="bos-wm-path-box" title="内置 watermark.png（红薯样片全画幅透明水印）">
                  ✓ 内置红薯样片 (watermark.png · 原版全画幅覆盖)
                </div>
              </div>
            </div>

            <div className="bos-wm-field-group">
              <label className="bos-wm-label">输出目录与文件名后缀</label>
              <div className="bos-wm-input-row">
                <div className="bos-wm-path-box" title={settings.outputDir || '默认输出在原视频所在文件夹'}>
                  {settings.outputDir ? settings.outputDir : '原视频同级目录'}
                </div>
                <button type="button" className="bos-wm-btn-subtle" onClick={handleChooseOutputDir}>
                  更改目录
                </button>
                {settings.outputDir && (
                  <button
                    type="button"
                    className="bos-wm-btn-subtle"
                    onClick={() => updateSettings({ outputDir: '' })}
                    title="恢复为原视频同级目录"
                  >
                    重置
                  </button>
                )}
              </div>
              <div className="bos-wm-input-row" style={{ marginTop: '8px' }}>
                <input
                  type="text"
                  className="bos-wm-input"
                  value={suffixDraft}
                  placeholder="输出文件后缀，默认 样片"
                  onChange={(e: any) => setSuffixDraft(e.target.value)}
                  onBlur={() => updateSettings({ suffix: suffixDraft.trim() || '样片' })}
                />
              </div>
            </div>
          </div>
        </aside>

        {/* Right Batch Queue Column */}
        <div
          className={`bos-wm-queue-panel ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(e: any) => {
            e.preventDefault();
            if (!dragging) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDropFiles}
        >
          {/* Queue Header & Primary Batch Controls */}
          <div className="bos-wm-queue-head">
            <div className="bos-wm-queue-title">
              <h2>批量视频处理队列</h2>
              <p>
                基于 Windows Media Foundation 硬件解码与稀疏像素合成引擎，无需打开浏览器即可后台高速批处理。
              </p>
            </div>
            <div className="bos-wm-queue-actions">
              <button type="button" className="bos-wm-btn-secondary" onClick={handleChooseVideos}>
                + 添加本地视频
              </button>
              {running ? (
                <button type="button" className="bos-wm-btn-danger" onClick={handleCancelBatch}>
                  停止批量任务 ({overallProgress}%)
                </button>
              ) : (
                <button
                  type="button"
                  className={`bos-wm-btn-primary${startingBatch ? ' is-loading' : ''}`}
                  disabled={pendingCount === 0 || startingBatch}
                  onClick={handleStartBatch}
                >
                  {startingBatch && <span className="bos-btn-spinner" aria-hidden="true" />}
                  {startingBatch ? '正在启动引擎…' : `开始硬件加速合成 (${pendingCount})`}
                </button>
              )}
            </div>
          </div>

          {notice && (
            <div className="bos-wm-notice" role="status">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice('')}>关闭</button>
            </div>
          )}

          {/* Aggregate Progress Strip */}
          {totalCount > 0 && (
            <div className="bos-wm-summary-strip">
              <div className="bos-wm-summary-metrics">
                <span>总计 <strong>{totalCount}</strong> 个视频</span>
                <span>已完成 <strong>{completedCount}</strong></span>
                {errorCount > 0 && <span className="is-err">异常 <strong>{errorCount}</strong></span>}
                <span>总进度 <strong>{overallProgress}%</strong></span>
              </div>
              <div className="bos-wm-summary-links">
                {errorCount > 0 && !running && (
                  <button type="button" onClick={() => bridge?.retryWatermarkJobs?.().then(syncState)}>
                    重试失败项
                  </button>
                )}
                {completedCount > 0 && (
                  <button type="button" onClick={() => bridge?.clearWatermarkJobs?.('completed').then(syncState)}>
                    清理已完成
                  </button>
                )}
                {!running && (
                  <button type="button" onClick={() => bridge?.clearWatermarkJobs?.('all').then(syncState)}>
                    清空列表
                  </button>
                )}
              </div>
              <div className="bos-wm-progress-track">
                <div className="bos-wm-progress-fill" style={{ width: `${overallProgress}%` }} />
              </div>
            </div>
          )}

          {/* Job List or Empty Dropzone */}
          {jobs.length === 0 ? (
            <div className="bos-wm-empty-dropzone" onClick={handleChooseVideos}>
              <div className="bos-wm-empty-icon">⚡</div>
              <h3>拖入多个本地视频，或点击此处批量选择</h3>
              <p>
                支持 MP4 / MOV / MKV / AVI · 原生 C# 硬件加速直出 · 执行期间可通过右下角全局任务托盘随时查看进度
              </p>
              <button type="button" className="bos-wm-btn-primary">
                选择本地视频素材
              </button>
            </div>
          ) : (
            <div className="bos-wm-job-list" role="list">
              {jobs.map(job => (
                <div key={job.id} className={`bos-wm-job-row status-${job.status}`} role="listitem">
                  <div className="bos-wm-job-main">
                    <div className="bos-wm-job-title-row">
                      <strong className="bos-wm-job-name" title={job.inputPath}>
                        {job.fileName}
                      </strong>
                      <span className="bos-wm-job-size">{formatBytes(job.sizeBytes)}</span>
                      <span className={`bos-wm-status-pill pill-${job.status}`}>
                        {job.status === 'pending' && '排队中'}
                        {job.status === 'processing' && `合成中 ${job.progress}%`}
                        {job.status === 'done' && `已完成 ${formatElapsed(job.elapsedMs)}`}
                        {job.status === 'error' && '失败'}
                        {job.status === 'cancelled' && '已取消'}
                      </span>
                    </div>
                    <div className="bos-wm-job-sub" title={job.outputPath}>
                      输出至: {job.outputPath}
                    </div>
                    {job.error && <div className="bos-wm-job-error">{job.error}</div>}
                    {(job.status === 'processing' || job.status === 'done') && (
                      <div className="bos-wm-job-bar">
                        <div
                          className="bos-wm-job-bar-fill"
                          style={{ width: `${job.status === 'done' ? 100 : job.progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <div className="bos-wm-job-ops">
                    {job.status === 'done' && (
                      <button
                        type="button"
                        className="bos-wm-btn-subtle"
                        onClick={() => bridge?.openWatermarkPath?.(job.outputPath)}
                      >
                        定位成片
                      </button>
                    )}
                    {job.status !== 'processing' && (
                      <button
                        type="button"
                        className="bos-wm-btn-icon"
                        title="从队列移除"
                        onClick={() => bridge?.removeWatermarkJob?.(job.id).then(syncState)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
