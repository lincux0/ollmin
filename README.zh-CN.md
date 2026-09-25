<p align="right">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

<div align="center">
  <h1>Ollmin</h1>
  <p><strong>让日常 PC 也能轻松运行本地 AI。</strong><br>
  面向 CPU、核显和本地小模型优化的轻量 Ollama 桌面客户端。</p>
  <p>
    <a href="https://github.com/lincux0/ollmin/releases/download/v1.1.0/Ollmin_1.1.0_x64-setup.exe"><strong>下载 Windows 安装包（v1.1.0）</strong></a>
    &nbsp;·&nbsp;
    <a href="https://github.com/lincux0/ollmin/releases">查看全部 Release</a>
  </p>
  <p>Windows 10/11 · 本地运行与隐私保护 · 无需账号 · MIT</p>
</div>

<p align="center">
  <img src="assets/ollmin-ui.png" alt="Ollmin 聊天窗口，展示快速模式选择和实时性能指标" width="1000">
</p>

## 为什么选择 Ollmin？

- 面向低配 PC、CPU、核显和有限内存，保持轻量；
- 为 3B、4B 等本地小模型设计；
- 完全本地：Ollmin 连接本机 Ollama，无需账号；
- 支持本地解析 PDF、DOCX、XLS 和 XLSX 文件并用于问答；
- 展示加载时间、提示词/输出 token 数和每秒 token 数（tok/s）；
- 专注 Windows 桌面体验，尽量减少无关上下文和后台模型请求。

模型速度取决于模型、量化方式、上下文和硬件。性能模式会配置 Ollama 请求，但不保证特定推理速度。

## 功能

- 快速、平衡、推理三种模式，设置受限的上下文和输出预算；
- 单次只运行一个 Ollama 聊天请求，可停止生成，思考与正文分开展示；
- 使用 SQLite 保存本机会话，支持搜索、重命名、恢复、删除和导出；
- 根据当前问题选择文件片段，不会把整份文档发送给模型；
- 清楚展示连接状态、加载、token 和停止原因。

## Ollmin 与通用 AI 客户端

| | Ollmin | 通用 AI 客户端 |
| --- | --- | --- |
| 侧重点 | 本地小模型与日常 PC | 功能覆盖更广 |
| 后端 | Ollama | 根据客户端不同而异，可能支持多个服务商 |
| 账号 | 不需要 | 不同产品不同 |
| 遥测 | 无 | 不同产品不同 |
| 文件处理 | 支持格式在本地解析 | 不同产品不同 |
| 主要目标 | 轻量、可预测的本地聊天 | 功能丰富度 |



## 用户快速开始

1. [下载 Windows 安装包](https://github.com/lincux0/ollmin/releases/download/v1.1.0/Ollmin_1.1.0_x64-setup.exe)并安装 Ollmin。
2. 安装并启动 [Ollama](https://ollama.com/)，确认至少有一个本地模型。例如运行 <code>ollama pull qwen3:4b</code>。
3. 打开 Ollmin，选择本地模型和性能模式，然后开始对话。

使用安装包无需安装 Node.js、Rust 或 Tauri。Ollmin 连接本机的 <code>127.0.0.1:11434</code>。

## 性能模式

| 模式 | Ollama 请求设置 | 适用场景 |
| --- | --- | --- |
| 快速 | 关闭思考、4K 上下文、最多 2,048 个输出 token；按完整轮次裁剪历史 | 简短问题和低配 PC |
| 平衡 | 开启思考、4K 上下文、最多 768 个输出 token | 日常对话 |
| 推理 | 开启思考、8K 上下文、最多 2,048 个输出 token | 需要更多推理的问题 |

这些是请求配置，不是性能承诺。模型加载、量化方式、处理器、内存带宽和提示词长度都会影响生成速度。

## 本地文件支持

一次最多添加三个本地文件，单文件不超过 20 MiB：PDF、DOCX、XLS 或 XLSX。Ollmin 在本地解析支持的文本与表格单元格值，再将有限的相关片段加入发往本机 Ollama 服务的问题中。

- 原始文件不会上传，也不会复制到 Ollmin 的数据目录。
- 为了在会话恢复后还原附件，解析出的片段和附件元数据会保存在本地会话数据库中。
- 扫描件/图片型 PDF 不做 OCR；旧版 Word <code>.doc</code> 不受支持，请先另存为 DOCX。

## Benchmark / 性能

目前尚未发布 Ollmin 的可复现基准测试结果。生成速度会随模型、量化方式、上下文和硬件而变化；目前没有单独测量 Ollmin 的 UI 开销。

## 工作方式

Ollmin 在本机解析所选文件，并在本地保存会话。聊天请求从 Windows 应用发送到同一台 PC 上运行的 Ollama 服务。

    Ollmin 桌面应用
      ├─ 本地文件解析与有限的相关片段选择
      ├─ SQLite 本机会话记录
      └─ HTTP 连接 127.0.0.1:11434
             └─ Ollama 与本地模型

## 隐私与本地数据

- Ollmin 只连接 <code>127.0.0.1:11434</code>；提示词和回答不会由 Ollmin 发送到云服务。
- 无账号、遥测、云同步或后台模型请求。
- 会话和设置保存在 <code>%APPDATA%\com.ollmin.desktop\ollmin.sqlite3</code>。
- 为了恢复会话附件，解析出的片段和元数据会以明文保存在该本地数据库中；不会保存原始文件或源文件路径。
- 思考内容默认不保存，只有在设置中开启后才会保存。只有用户主动操作时才会导出数据。

## 从源码构建

开发环境需要 Windows 10/11、Node.js 20 或更新版本、Rust stable 工具链、Tauri 2 前置环境，以及运行中的本地 Ollama 服务。

    git clone https://github.com/lincux0/ollmin.git
    cd ollmin
    npm ci
    npm run tauri -- dev

运行仓库 CI 使用的检查：

    npm run test
    npm run build
    cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
    cargo test --manifest-path src-tauri/Cargo.toml

v1.1.0 Windows 安装包可在 [GitHub Release](https://github.com/lincux0/ollmin/releases/tag/v1.1.0) 下载。源码构建命令面向开发者。

## 常见问题

### Ollama 显示未连接

启动 Ollama 并检查本机接口：

    Invoke-RestMethod http://127.0.0.1:11434/api/version

Ollmin 只使用这个本机地址，不会自动切换到远程服务器。

### 为什么 Debug 版本会打开终端？

Debug 构建会保留控制台以显示 Rust 日志；Release 构建会隐藏 Windows 控制台。

### 本地数据保存在哪里？

SQLite 数据库位于 <code>%APPDATA%\com.ollmin.desktop\ollmin.sqlite3</code>。为恢复已保存会话中的附件，解析出的文件片段和元数据也会保存在其中。

### 当前有哪些限制？

扫描件 PDF 需要先在其他软件中做 OCR，旧版 <code>.doc</code> 需要先另存为 DOCX。生成速度取决于本地模型与硬件。Ollmin 1.1.0 尚未提供自动更新和完整的桌面端到端测试流程。

## 参与贡献

欢迎提交问题报告和聚焦明确的功能建议。如果 Ollmin 适合你的使用场景，欢迎点亮 Star，让更多人发现它：

- [报告 Bug](https://github.com/lincux0/ollmin/issues/new?template=bug_report.md)
- [提出功能建议](https://github.com/lincux0/ollmin/issues/new?template=feature_request.md)
- [贡献指南](CONTRIBUTING.zh-CN.md)
- [安全政策](SECURITY.zh-CN.md)
- [Pull Request](https://github.com/lincux0/ollmin/pulls)

## 当前状态

最新发布版本为 v1.1.0。此版本未提供安装包签名、自动更新或完整桌面端到端覆盖。新增功能应继续遵循本地优先原则，并避免不必要的模型请求和上下文。

## 许可证

Ollmin 使用 MIT License，详见 [LICENSE](LICENSE)。