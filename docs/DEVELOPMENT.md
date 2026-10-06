# 开发与构建

## 环境

- Windows 10/11；Node.js 20 或更高版本；Rust stable 工具链。
- 按 Tauri 2 官方 Windows 要求安装构建工具和 WebView2。
- 本地运行 Ollmin 功能需要 Ollama 服务监听 `127.0.0.1:11434`；纯前端构建不需要启动 Ollama。

## 安装与运行

```powershell
npm ci
npm run tauri -- dev
```

也可用 `npm run dev` 预览静态前端；浏览器没有 Tauri IPC，聊天、数据库和原生窗口功能不可用。

## 构建

```powershell
npm run build
npm run tauri -- build --debug
npm run tauri -- build
```

- Debug 可执行文件：`src-tauri/target/debug/ollmin.exe`，保留控制台以查看日志。
- Release 可执行文件：`src-tauri/target/release/ollmin.exe`，隐藏控制台。
- `src-tauri/tauri.conf.json` 中 `bundle.active` 当前为 `false`，普通构建只生成可执行文件。需要安装包时显式运行 `npm run tauri -- build --bundles nsis`。

## 本地数据

Ollmin SQLite 数据库默认位于 `%APPDATA%\com.ollmin.desktop\ollmin.sqlite3`。调试时应使用测试数据；导出和附件解析数据由用户显式操作生成。

依赖安装、测试和运行冒烟说明见 [TESTING.md](TESTING.md)。
