import { useRef, useState } from "react";
import type { AppSettings, ThemeMode } from "../../contracts/ipc";
import {
  CONTEXT_SIZE_OPTIONS,
  OUTPUT_TOKEN_LIMIT_OPTIONS,
  PERFORMANCE_PROFILES,
  REASONING_TOKEN_LIMIT_OPTIONS,
  type ContextSize,
  type OutputTokenLimit,
  type PerformanceMode,
  type ReasoningTokenLimit,
} from "../../lib/performance";
import Modal from "../../components/ui/Modal";
import { modelAliasFor } from "../models/helpers";
import { type UiFontSize } from "./uiFontSize";
import "./settings.css";

export interface SettingsDialogProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  uiFontSize: UiFontSize;
  onUiFontSizeChange: (size: UiFontSize) => void;
  models: string[];
  appVersion: string;
  serviceStatus: string;
  currentConversationId: string | null;
  busy: boolean;
  onRefreshConnection: () => void;
  onWarmup: () => Promise<void>;
  onExport: (format: "markdown" | "json") => Promise<void>;
  onClearConversations: () => Promise<void>;
  onRequestClose: () => void;
  onSave: (settings: AppSettings, uiFontSize: UiFontSize) => Promise<void>;
  onSavedClose: () => void;
}

type Section = "appearance" | "model" | "privacy" | "service";
const sections: Array<{ id: Section; title: string }> = [
  { id: "appearance", title: "外观" },
  { id: "model", title: "模型与性能" },
  { id: "privacy", title: "会话与隐私" },
  { id: "service", title: "本机服务与关于" },
];

export default function SettingsDialog(props: SettingsDialogProps) {
  const [section, setSection] = useState<Section>("appearance");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const [aliasesOpen, setAliasesOpen] = useState(false);

  async function save() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await props.onSave(props.settings, props.uiFontSize);
      props.onSavedClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const close = () => { if (!savingRef.current) props.onRequestClose(); };
  const update = (changes: Partial<AppSettings>) => props.onSettingsChange({ ...props.settings, ...changes });

  return <Modal onClose={close} labelledBy="settings-title" className="settings-dialog" backdropClassName="modal-backdrop settings-dialog-backdrop">
    <header className="settings-dialog-header">
      <div><p className="settings-dialog-kicker">本地设置</p><h2 id="settings-title">Ollmin 设置</h2></div>
      <button type="button" className="settings-dialog-close" aria-label="关闭设置" onClick={close} disabled={saving}>×</button>
    </header>
    <div className="settings-dialog-body">
      <nav className="settings-dialog-nav" aria-label="设置分类">
        {sections.map((item) => <button key={item.id} type="button" className={section === item.id ? "active" : ""} aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)} disabled={saving}>{item.title}</button>)}
      </nav>
      <div className="settings-dialog-content" key={section}>
        {section === "appearance" ? <section aria-labelledby="settings-appearance">
          <h3 id="settings-appearance">外观</h3>
          <p className="settings-dialog-subtitle">调整应用主题和阅读字号。</p>
          <div className="settings-dialog-fields">
            <label>主题<select aria-label="主题" disabled={saving} value={props.settings.theme} onChange={(event) => update({ theme: event.target.value as ThemeMode })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
            <label>会话字号<select aria-label="会话字号" disabled={saving} value={props.uiFontSize} onChange={(event) => props.onUiFontSizeChange(Number(event.target.value) as UiFontSize)}>{Array.from({ length: 11 }, (_, i) => i + 12).map((size) => <option key={size} value={size}>{size}px</option>)}</select></label>
          </div>
          <p className="settings-dialog-note">主题会即时预览；字号在保存时写入此设备。</p>
        </section> : null}
        {section === "model" ? <section aria-labelledby="settings-model-performance">
          <h3 id="settings-model-performance">模型与性能</h3>
          <p className="settings-dialog-subtitle">为新会话选择默认模型和请求预算。</p>
          <div className="settings-dialog-fields">
            <label>新会话模型<select aria-label="新会话模型" disabled={saving} value={props.settings.defaultModel} onChange={(event) => update({ defaultModel: event.target.value })}><option value="">自动选择第一个可用模型</option>{props.models.map((name) => <option key={name} value={name}>{modelAliasFor(props.settings.modelAliases, name)}</option>)}</select></label>
            <label>默认性能模式<select aria-label="默认性能模式" disabled={saving} value={props.settings.defaultMode} onChange={(event) => update({ defaultMode: event.target.value as PerformanceMode })}>{Object.values(PERFORMANCE_PROFILES).map((item) => <option key={item.mode} value={item.mode}>{item.label}</option>)}</select></label>
            <label>上下文大小<select aria-label="上下文大小" disabled={saving} value={props.settings.contextSize} onChange={(event) => update({ contextSize: Number(event.target.value) as ContextSize })}>{CONTEXT_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size / 1024}K</option>)}</select></label>
            <label>输出消息 token 上限<select aria-label="输出消息 token 上限" disabled={saving} value={props.settings.outputTokenLimit} onChange={(event) => update({ outputTokenLimit: Number(event.target.value) as OutputTokenLimit })}>{OUTPUT_TOKEN_LIMIT_OPTIONS.map((limit) => <option key={limit} value={limit}>{limit / 1024}K</option>)}</select></label>
            <label>推理 token 上限<select aria-label="推理 token 上限" disabled={saving} value={props.settings.reasoningTokenLimit} onChange={(event) => update({ reasoningTokenLimit: Number(event.target.value) as ReasoningTokenLimit })}>{REASONING_TOKEN_LIMIT_OPTIONS.map((limit) => <option key={limit} value={limit}>{limit === 0 ? "自动（硬上限 16K）" : `${limit / 1024}K`}</option>)}</select></label>
          </div>
          <p className="settings-dialog-note">快速模式关闭思考。推理预算仅在开启思考时生效；自动模式受 16K token 安全上限约束，等待和内存占用可能增加。</p>
          <button type="button" className="settings-dialog-disclosure" aria-expanded={aliasesOpen} onClick={() => setAliasesOpen((value) => !value)} disabled={saving}>模型别名 <span>{aliasesOpen ? "−" : "+"}</span></button>
          {aliasesOpen ? <div className="settings-dialog-aliases">{props.models.length === 0 ? <p className="settings-dialog-note">暂无可用模型，请先刷新连接。</p> : props.models.map((name) => <label key={name}><span title={name}>{name}</span><input disabled={saving} aria-label={`${name} 的别名`} maxLength={80} placeholder="使用原名" value={props.settings.modelAliases[name] ?? ""} onChange={(event) => update({ modelAliases: { ...props.settings.modelAliases, [name]: event.target.value } })} /></label>)}</div> : null}
        </section> : null}
        {section === "privacy" ? <section aria-labelledby="settings-session-privacy">
          <h3 id="settings-session-privacy">会话与隐私</h3>
          <p className="settings-dialog-subtitle">会话与消息保存在本机应用数据目录。</p>
          <label className="settings-dialog-check"><input type="checkbox" disabled={saving} checked={props.settings.saveThinking} onChange={(event) => update({ saveThinking: event.target.checked })} />允许把思考内容保存到本地会话</label>
          <p className="settings-dialog-note">默认关闭。关闭后，新保存的消息只保留正文；已保存的思考内容不会自动删除。</p>
          <h4>导出当前会话</h4>
          <div className="settings-dialog-actions"><button type="button" onClick={() => void props.onExport("markdown")} disabled={!props.currentConversationId || props.busy || saving}>导出 Markdown</button><button type="button" onClick={() => void props.onExport("json")} disabled={!props.currentConversationId || props.busy || saving}>导出 JSON</button></div>
          <h4 className="settings-dialog-danger-title">清除本地数据</h4>
          <button type="button" className="settings-dialog-danger" onClick={() => void props.onClearConversations()} disabled={props.busy || saving}>清空所有本地会话</button>
        </section> : null}
        {section === "service" ? <section aria-labelledby="settings-local-service">
          <h3 id="settings-local-service">本机服务与关于</h3>
          <p className="settings-dialog-subtitle">Ollmin 只连接本机 Ollama 服务。</p>
          <div className="settings-dialog-service"><span>服务地址</span><strong>http://127.0.0.1:11434</strong></div>
          <div className="settings-dialog-service"><span>连接状态</span><strong>{props.serviceStatus}</strong></div>
          <div className="settings-dialog-actions"><button type="button" onClick={props.onRefreshConnection} disabled={props.busy || saving}>刷新连接与模型</button><button type="button" onClick={() => void props.onWarmup()} disabled={props.busy || saving || props.models.length === 0}>预热当前模型</button></div>
          <div className="settings-dialog-service"><span>版本</span><strong>{props.appVersion}</strong></div>
        </section> : null}
        {error ? <p className="settings-dialog-error" role="alert">保存失败：{error}</p> : null}
      </div>
    </div>
    <footer className="settings-dialog-footer">
      <button type="button" className="settings-dialog-secondary" onClick={close} disabled={saving}>取消</button>
      <button type="button" className="settings-dialog-primary" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存设置"}</button>
    </footer>
  </Modal>;
}
