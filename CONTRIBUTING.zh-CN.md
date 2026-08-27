<p align="right">
  <a href="CONTRIBUTING.md">English</a> | <a href="CONTRIBUTING.zh-CN.md">简体中文</a>
</p>

# 贡献指南

感谢你关注 Ollmin。Ollmin 是面向 Windows 低性能设备和本地小模型的轻量 Ollama 客户端，贡献应优先保持这个定位：少请求、低资源占用、可解释的等待状态和明确的本地隐私边界。

## 开发环境

- Windows 10/11；
- Node.js 20 或更新版本；
- Rust stable 工具链和 Tauri 2 开发环境；
- 已启动的 Ollama（默认地址为 `127.0.0.1:11434`）。

```powershell
npm ci
npm run tauri -- dev
```

## 提交前检查

在仓库根目录执行：

```powershell
npm run test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

真实 Ollama 测试可以使用本机已安装模型，但不要把某次模型正文或 tok/s 当作稳定的单元测试断言。当前项目没有完整的桌面 Playwright E2E 流程，涉及窗口行为时请在 PR 中说明手工验证步骤。

## 修改边界

- Ollama 请求必须保持在 Rust 后端，并默认只连接本机 `127.0.0.1:11434`；
- 不加入遥测、账号、云端同步、联网搜索、Shell、文件执行、MCP 或模型工具调用；
- 不把模型输出当作 HTML、脚本或命令执行；
- 修改性能档位、流事件、历史裁剪或 SQLite schema 时，同时补充前后端测试；
- 思考内容默认不落盘，除非用户明确开启保存设置；
- 不提交 `node_modules`、构建产物、数据库、环境变量、Graphify 缓存或内部维护文档。

## Pull Request 建议

1. 一个 PR 聚焦一个问题或一个小功能，并在描述中说明动机、影响范围和已执行的检查。
2. UI 变更请附截图或说明验证窗口尺寸；性能变更请给出相同模型、提示词和上下文设置下的对比数据。
3. 不要在 PR 中粘贴真实会话、个人路径、密钥或完整模型输出。
4. CI 失败时请先区分代码失败和本地 Ollama/构建环境问题，再提交可复现信息。
