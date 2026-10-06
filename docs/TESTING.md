# 测试与验证

在仓库根目录 `D:\ollmin` 执行 Ollmin 检查：

```powershell
npm run test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

根目录 `npm run test` 运行 Ollmin 的 Vitest 单元测试。Tauri 可执行文件构建命令见 [DEVELOPMENT.md](DEVELOPMENT.md)。

dsh UI重构的合成截图、原生窗口探测入口和本次实际结果见 [UI重构实施与验证](UI-REFACTOR-VALIDATION.md)。`scripts/capture-ollmin-ui.cjs` 只由现有Playwright MCP加载，在浏览器拦截测试入口；`scripts/measure-ollmin-shell.ps1` 逐轮启动并关闭指定Ollmin exe。浏览器IPC mock、原生窗口系统命令与完整桌面E2E应分别报告。

阶段2使用同一MCP浏览器先设置 `page.__capturePhase='dsh-phase2'`，通过 `browser_run_code_unsafe` 的 `filename` 加载 `D:/ollmin/scripts/capture-ollmin-ui.cjs`，再加载 `D:/ollmin/scripts/verify-ollmin-phase2.cjs`。前者仅在合成测试入口首次访问清理该浏览器的UI偏好并采集浅深色四宽截图，后者验证折叠/拖宽/恢复、localStorage拒绝、搜索竞态/重试、菜单/模态焦点、草稿和IME。不要把这些脚本直接用Node运行，或接到生产入口；不产生真实生成请求。结果位于忽略的 `output/playwright/dsh-phase2/`，测试后关闭页面及本次Vite进程。

原生探测脚本含中文UI Automation按钮名，应从PowerShell 7直接调用；Windows PowerShell 5读取无BOM UTF-8脚本可能乱码并造成按钮名匹配失败。原生按钮成功不能替代侧栏指针、真实会话和DPI全矩阵验收。本地存在隔离 worktree 时，可额外排除 `.worktrees/**`，避免重复运行其他工作树中的测试。

## 桌面冒烟

定点UI优化使用现有MCP先加载 `capture-ollmin-phase45.cjs` 再运行 `verify-ollmin-ui-points.cjs`，当前17项检查覆盖间距/圆角/控件精简/顶部搜索与外部收起/透明拖宽/设置字重/10字横向摘要；只操作合成数据。根TurnNavigator测试覆盖超过10字截断、恰好10字及emoji不拆分。阶段3回归通过右侧模型菜单修改性能档位，并检查别名隐藏原名且仍支持原名搜索。

阶段5复用同一MCP页面：先运行 `capture-ollmin-phase45.cjs`，再运行 `verify-ollmin-phase4.cjs` 和 `verify-ollmin-phase5.cjs`。设置检查覆盖八组几何、焦点闭环、预览/放弃、保存防重/失败/重试与字号回滚、危险操作及服务刷新。阶段2/3原有脚本已适配分类入口，resize/关闭焦点检查等待实际状态，不用固定延迟掩盖竞态。独立工作树位于仓库内时使用 `npm run test -- --exclude '.worktrees/**'`，避免重复执行其他工作树中的测试。

`node scripts/check-local-ollama.cjs` 仅测试固定本机地址的真实HTTP流、取消后重发和缺失模型404；不是Tauri调度/SQLite联调。`measure-ollmin-shell.ps1 -ProcessTree` 可采集本次exe及WebView2后代私有内存快照；CPU仍只测主进程，窗口句柄可用时间不是首屏绘制时间。脚本退出时关闭自己启动的exe；浏览器验证结束后关闭页面与本轮Vite，再构建Debug/Release无bundle产物。

阶段4通过同一Playwright MCP依次加载 `scripts/capture-ollmin-phase45.cjs` 与 `scripts/verify-ollmin-phase4.cjs`，前者提供匿名12回合及剪贴板fixture，后者检查回合锚点、输入/宽度/思考高度变化、用户/思考/代码复制、安全代码和流中手动披露。结果放 `output/playwright/dsh-phase45/`，不操作真实会话或系统剪贴板。运行原生构建前关闭本轮Vite，避免目标exe被watch导致EBUSY；不以修改产品代码处理这类环境错误。

阶段3在同一现有Playwright MCP浏览器依次通过 `browser_run_code_unsafe` 的 `filename` 加载 `D:/ollmin/scripts/capture-ollmin-phase3.cjs` 和 `D:/ollmin/scripts/verify-ollmin-phase3.cjs`。需要本机Vite `127.0.0.1:1420`；前者注入合成IPC并采集浅深色四宽Hero，后者检查41项输入、模型菜单、附件、生成/停止状态。高度检查等待实际resize结果，不依赖固定即时取样。脚本不接生产入口、不直接用Node运行。

合成检查记录两次 `start_chat` mock，不发送真实Ollama请求；附件解析与事件也由fixture提供。模拟composition/229不能证明原生中文输入法行为，停止mock不能证明真实Rust调度锁释放时序。原生输入法、真实文件和Ollama停止重发仍需独立联调。结果及截图位于忽略的 `output/playwright/dsh-phase3/`，测试后关闭页面和本次服务器。

```powershell
npm run tauri -- build --debug
npm run tauri -- build
```

可启动对应 exe，确认窗口持续运行、会话和设置能读取；若 Ollama 已运行，再验证本机模型列表及 `/api/chat` 流。真实模型输出不作为单元测试断言。当前项目没有完整的原生桌面 Playwright E2E 流程，不应将浏览器预览或 IPC mock 描述为桌面 E2E。

## 性能测试资料

- [运行基准测试协议](tests/benchmark-protocol.md)：固定条件并记录 Ollama 指标。
- [用户感知性能测试方案](tests/user-perceived-benchmark-plan.md)：对比 Release 客户端、CLI 和原生 API。
- [测试资料目录索引](tests/README.md)：人工流程、历史联调报告和原始结果。
