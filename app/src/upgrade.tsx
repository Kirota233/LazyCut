export { MusicStudio } from './MusicStudio.jsx';
export { GlobalThemePicker, useGlobalTheme } from './GlobalThemes.tsx';
export { ScriptAutomation, useScriptAutomation } from './ScriptAutomation.tsx';
export { WatermarkStudio } from './WatermarkStudio.tsx';
export { UsageGuide } from './UsageGuide.tsx';
export { JianyingStudio } from './JianyingStudio.tsx';
export { SidebarResizer } from './SidebarResizer.tsx';
export { WebAIStudio } from './WebAIStudio.tsx';
export { BatchAnalysis } from './BatchAnalysis.jsx';
export { LocalModels, useLocalProvider } from './LocalModels.jsx';
declare const i: any;

export { BatchNavIcon, JianyingNavIcon, WebAiNavIcon, PetNavIcon, LocalNavIcon, DownloadNavIcon, PlayNavIcon, CheckNavIcon, CloseNavIcon, PauseNavIcon } from './NavigationIcons.jsx';
export { TitleBar } from './TitleBar.tsx';
export { BatchTray } from './BatchTray.tsx';
export { SidebarCredits, AUTHOR_CREDITS, OPEN_SOURCE_PROJECTS } from './SidebarCredits.tsx';

export class AppErrorBoundary extends (typeof i !== 'undefined' && i?.Component ? i.Component : class {}) {
  constructor(props: any) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { error };
  }
  render() {
    const { error } = this.state as { error: any };
    if (!error) return (this.props as any).children;
    const message = error?.message || String(error);
    return (
      <div style={{ padding: '40px 28px', maxWidth: 680, margin: '48px auto', borderRadius: 16, border: '1px solid var(--ui-border, #39403e)', background: 'var(--ui-surface, #161a19)', color: 'var(--ui-text, #e8ecea)', fontFamily: 'system-ui, sans-serif' }}>
        <p style={{ margin: '0 0 8px', fontSize: 12, letterSpacing: '0.12em', color: 'var(--ui-accent, #c5f54f)', fontWeight: 700 }}>LAZYCUT RECOVERY</p>
        <h2 style={{ margin: '0 0 12px', fontSize: 22 }}>页面渲染遇到异常，已自动拦截防止白屏</h2>
        <p style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.7, color: 'var(--ui-muted, #9aa4a0)' }}>你可以先尝试恢复界面；若问题持续出现，请截图或复制下方错误信息反馈。</p>
        <pre style={{ margin: '0 0 18px', padding: 12, borderRadius: 8, background: 'var(--ui-input, #101312)', border: '1px solid var(--ui-border, #2c3330)', fontSize: 12, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{message}</pre>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => this.setState({ error: null })} style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--ui-accent, #c5f54f)', background: 'var(--ui-accent, #c5f54f)', color: 'var(--ui-on-accent, #111)', fontWeight: 700, cursor: 'pointer' }}>重试当前视图</button>
          <button type="button" onClick={() => window.location.reload()} style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--ui-border, #39403e)', background: 'var(--ui-raised, #1f2422)', color: 'var(--ui-text, #e8ecea)', cursor: 'pointer' }}>刷新应用</button>
        </div>
      </div>
    );
  }
}
