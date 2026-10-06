# Ollmin UI 重构计划：参照 dsh-desktop

> 编制日期：2026-09-30；同日完成全仓 UI 重新评估。状态：阶段1–5开发与指定验证完成；阶段0匿名参考截图与阶段5全量原生验收仍有缺口，阶段6尚未实施。浏览器合成验证不替代原生输入法和真实Tauri/Ollama联调。
> 目标：在 Ollmin 本地、轻量、小模型的产品边界内，尽可能复刻 dsh-desktop Windows 版的视觉、布局和常用聊天体验，而不是继续对当前暖色界面做局部润色。

## 1. 依据、范围与事实边界

### 1.1 源码快照与运行参考

最初入口为 [deepseek-harness/apps/desktop](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/desktop)，本次按用户要求扩大至 [deepseek-harness 全仓](https://github.com/deepseek-ai/deepseek-harness)，覆盖客户端启动装配、共享 UI、会话/工作区控制器接口、样式规范及相关测试。重新查询 `master` 后仍为 [`639ed015397290b3745d163aafe02ffee4aa3f84`](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84)，因此保持同一快照，修订依据是补充源码范围而非版本变化。该快照中桌面包声明版本为 `0.2.0-rc.2`；这不等同于已验证公开发布安装包版本。

2026-09-30用户允许使用本机已安装dsh作为运行参考，接受小版本差异，不要求clone或对齐最新构建提交。源码快照继续用于可追溯的参数依据；实机单独记录版本和差异，不再以二进制SHA完全一致作为实施前置条件。本机安装版实测为0.2.0-rc.2，运行观察和隐私限制见 [验证记录](UI-REFACTOR-VALIDATION.md)。

`apps/desktop` 主要是 Electron 壳，这一判断仍成立。更完整的设计依据是：Web/Desktop 共用客户端启动与 UI 装配路径；插件组合决定哪些会话视图、导航和控件实际存在，控制器决定搜索、归档与输入调度的真实语义。上轮虽已阅读 `packages/client` 的主要组件，但对装配清单、共用基件和跨组件交互覆盖不足，本次补齐这些部分。

| 参考区域 | 已核对的上游源码（均相对该固定提交） | 对 Ollmin 的作用 |
| --- | --- | --- |
| Windows 桌面壳 | `apps/desktop/src/windows-layout.ts`、`preload-windows.ts`、`preload-theme.ts` | 标题栏尺寸、主题同步与交互适配 |
| 应用布局 | `packages/client/ui-layout/src/client/AppFrame.tsx`、`AppFrame.module.css`、`columns.ts` | 左栏伸缩、主表面、窗口断点 |
| 左侧栏 | `packages/client/ui-sidebar/src/client/SidebarRoot.tsx`、`SidebarRoot.module.css`、`HeaderLeadingControls.tsx` | 导航密度、折叠动作、新建入口 |
| 会话主区 | `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css`、`ConversationWidthControls.tsx`、`HeroShell.module.css` | 空态、内容宽度、输入与正文同轴 |
| 输入区 | 同目录的 `InputBar.tsx`、`InputBar.module.css`；`input/editor/` | 圆角卡片、自动增高、工具行、中文输入 |
| 消息与思考 | `packages/client/ui-chat/src/client/chat/ChatView.module.css`、`MessageItem.tsx`、`MessageItem.module.css`、`ReasoningRow.tsx`、`ReasoningRow.module.css` | 用户气泡、助手正文、思考行与流式状态 |
| 消息操作与导航 | 同目录的 `MessageIconActions.tsx`、`TurnNavigator.tsx`、`RunningStatus.tsx` | 复制反馈、回合导航、生成反馈 |
| 设置 | `packages/client/ui-settings-general/src/client/SettingsRoot.tsx`、`SettingsRoot.module.css`、`chrome.tsx` | 双栏设置弹窗、分类导航、关闭与焦点语义 |
| 主题与 Markdown | `packages/client/ui-theme/src/styles/{base,design-platform,corner-shape}.css`；`packages/client/ui-primitives/src/markdown/`、`package.json` | 浅深色令牌、排版、代码块和渲染成本 |
| 启动与实际组合 | `apps/web/src/main.ts`、`packages/client/web/src/{boot,mount}.ts`、`packages/bundle/web-app/cordis.patch.yml`、`packages/client/ui-renderer/src/client/app.tsx` | 确认共用入口、实际功能组合和唯一 root 渲染 |
| 跨组件契约 | `docs/subsystems/{web-client,slots,conversation}.zh.md`、`ui-conversation/src/client/skeleton/ConversationMainPanel.tsx`、`ConversationContent.tsx`、`ConversationSession.tsx` | 常驻输入/滚动容器、会话标题与条件视图标签 |
| 设计系统规范 | `docs/web-styling.zh.md`、`docs/ui-radius.zh.md`、`ui-primitives/src/` | 表面材质、菜单、控件、浮层、焦点与圆角嵌套 |
| 模型选择 | `packages/client/ui-model-selection/src/client/{ModelSelect.tsx,ModelSelect.module.css,index.ts}` | 搜索、分层选择、加载/失败与输入工具行收缩 |
| 导航与搜索动作 | `packages/client/ui-workspace/src/client/{shortcuts.ts,navigation.ts,rows/WorkspaceBrowser.tsx,session-actions/ArchiveSession.tsx}` | 实际快捷键、搜索竞态、排序与可恢复归档 |
| 回合定位链 | `packages/client/ui-chat/src/client/chat/{turn-rail-items.ts,use-chat-navigation.ts,use-chat-reading.ts,TurnNavigator.tsx}` | 回合锚点、读取窗口、跳转/跟随仲裁 |
| 共用基件与偏好 | `packages/client/ui-primitives/src/{Menu.tsx,MenuSurface.tsx,Tooltip.tsx,Toast.tsx,Modal.tsx,useModalLayer.ts,focus.ts}`；`ui-theme/src/{boot-theme.ts,theme-settings.ts,client/index.ts,styles/scrollbar.css}` | 菜单键盘、层级焦点、反馈生命周期、启动主题与系统变化 |

本次未安装或启动 dsh-desktop，未采集两款应用的原生截图，也未测量资源消耗。因此：本文的“上游尺寸/颜色”是源码事实；“Ollmin 实施方案”是建议；“验收阈值”是拟定目标，均不能写成已实现或已达成的成效。上游条件样式、实际字体、平台标记、插槽组合及 Electron/WebView2 差异，必须在阶段 0 的运行对照中确认。

Ollmin 基线是本地提交 `37fcb14`，本轮开始时工作区干净。当前事实以根应用 `src/` 和 [ARCHITECTURE.md](ARCHITECTURE.md) 为准。所有实现判断均回到 Ollmin 源码核对。

### 1.1.1 实际组合路径与可移植边界

已核实主入口链：`apps/web/src/main.ts` → `AppWebEntry`（`client/web/src/boot.ts`）→ boot/module graph → `mountClient` → `ui-renderer` → 唯一 `renderSlot('root')`。`packages/bundle/web-app/cordis.patch.yml` 组合 theme、layout、sidebar、conversation、chat、workspace、model-selection、settings、shortcuts，并包含有独立权限和数据要求的右栏/工具/审批/反馈等模块；Agent presets 再决定具体 Agent 能力。不能将某个通用组件目录中的所有功能都当成 Windows 默认首屏，也不能把 `minimal` Agent preset 当作一套独立的极简 UI。

```text
Desktop host/注入 ─┐
                  ├─ apps/web → client/web → ui-renderer(root)
Web server/boot ───┘                        ├─ ui-layout / ui-sidebar / ui-workspace
                                           ├─ ui-conversation → ui-chat 等实际注册视图
                                           ├─ ui-model-selection / ui-attachment
                                           └─ ui-settings-general / ui-theme / ui-primitives
```

Ollmin移植的是最终可见结构、共用控件的规则和交互反馈，不移植 module-loader、Host API Gateway、Cordis或插件注册系统。明确保留“数据/请求由现有API与后端拥有、组件只展示和调用动作”的依赖方向。需新业务语义的UI另列决策，不能借一次全面UI参考扩大文件/网络/执行权限。

### 1.2 复刻分级

| 级别 | 本计划的处理方式 | 内容 |
| --- | --- | --- |
| A：直接复刻 | 尽量沿用上游视觉参数和交互次序 | 冷中性色浅深主题、Windows 壳层、侧栏密度、输入卡片、气泡、助手排版、思考折叠、复制反馈、设置双栏 |
| B：等效适配 | 外观接近，底层保持 Ollmin 契约 | 模型选择映射本机 Ollama；Agent 模式位置映射快速/平衡/推理；文件入口映射既有本地附件；状态映射本地生成阶段；项目/会话导航映射本地会话 |
| C：按产品边界省略 | 移除相应插槽和占位，不做空壳入口 | 账号/额度/云模型、联网搜索、MCP、Shell、浏览器/终端、插件市场、多 Agent、Agent 队列、工作区执行与自动更新服务 |
| D：单独决策 | 列出实现方式、代价和前置条件 | 完整 GFM、代码高亮和公式渲染；额外字体资源；更小原生窗口下限 |

全仓评估后增加：模型搜索选择、会话快速搜索、回合导航、短反馈和浮层规范属于核心UI；置顶/归档/持久排序属于带数据语义的后续决策；Chat/Trajectory多视图、审批、队列和产物工作流不能只复制标签。主区只有聊天视图时不显示空的标签栏，也不为对齐76px双行头部而保留无意义留白。

保留 Ollmin 名称、图标和本地文案。复刻上游的结构、配色、控件和节奏，不把 DeepSeek 商标、鲸鱼品牌、账号引导或 Preview 标记变成 Ollmin 身份。既有暖色主题不再作为默认视觉方向；历史 P0/P1/P2 中正确的性能、可访问性和业务实现继续复用。

## 2. 当前差距与重构策略

当前 `src/App.tsx` 约 1140 行，集中拥有流式请求、会话加载、设置草稿、附件资源以及视图；`src/index.css` 约 316 行。已有 React 19、Tauri 2、TypeScript/Vite、Vitest，生产依赖没有通用 UI 框架或 Markdown 引擎。相比上游，差距如下。

| 区域 | Ollmin 当前状态 | 目标与影响范围 |
| --- | --- | --- |
| 壳层 | 44px 自绘标题栏、约 248px 固定左栏、全宽分隔线 | 40px 标题带，冷色侧栏，聊天表面左上 16px 圆角；左栏可折叠/调整 |
| 主题 | 暖白底、棕色强调、正文列上限 880px | 上游冷灰/蓝色语义体系、浅深色一一对应、共享宽度轴 |
| 空会话 | 中央图标提示，输入仍在底部 | 欢迎标题与输入卡片组成居中 Hero，首轮后输入回到底部 |
| 输入 | 两行 textarea、普通边框、独立停止/发送按钮 | 28px 圆角输入面、14 行高度上限、分组工具行、圆形发送/停止主动作 |
| 消息 | 用户气泡为白色描边/阴影，助手带顶部标识；15px 正文 | 淡蓝用户气泡、14px/22px 基础排版、助手无卡片、紧凑操作行 |
| 思考 | 黄色 `<details>`，流式默认展开 | 紧凑披露行、单行摘要、稳定的展开/收起控制与正文分离 |
| 设置 | 620px 单栏弹窗、末尾保存/取消、复杂设置折叠 | 800px 双栏分类弹窗，188px 导航，保留可靠的保存/取消语义 |
| 菜单/键盘 | 右键删除、prompt 重命名、confirm 删除；输入未检查 `isComposing` | 统一菜单/对话框、中文输入不误发、焦点闭环和可见操作入口 |
| 滚动 | 距底部 72px 内跟随，按帧更新 | 保留跟随规则，补回到底部入口、展开思考/输入增高时位置稳定 |
| 富文本 | 安全 Markdown 子集，代码/公式保持文本 | 先复刻排版与代码块外观；完整语法放入单独有性能门槛的阶段 |

实施顺序是“保留行为，替换表现”。先把已有 JSX 区块变成可控的展示组件，继续由 `App` 持有聊天和持久化生命周期，不同时更换状态库、IPC、数据库或 Runtime。后续只按实际需要提取侧栏、输入区和设置局部状态。

## 3. 目标视觉与布局规格

### 3.1 主题令牌

以下由上游 `design-platform.css` 和 `base.css` 核实；实现时转成 Ollmin 自己的语义变量，避免搬入数百个未用令牌。上游 `brand-primary` 是墨色，发送按钮使用信息蓝色，不能把所有按钮统一染蓝。

| 用途 | 浅色 | 深色 |
| --- | --- | --- |
| 主文字 | `#0f1115` | `#f9fafb` |
| 次文字 | `#61666b` | `#cfd3d6` |
| 第三级文字 | `#81858c` | `#adb2b8` |
| 左栏 | `#f9fafb` | `#1b1b1c` |
| 用户气泡 | `#edf3fe` | `#2c2c2e` |
| 信息按钮填充 | `#4176e6` | `#7aaaff` |

主背景、输入面、菜单、设置、描边、阴影、悬停和危险态继续按各自的上游语义令牌提取，禁止通过简单反色生成深色。圆角阶梯为 `4/8/12/16/20/28px`；标准动效为 `100/200/300ms`、`cubic-bezier(0.4,0,0.2,1)`。圆角 `corner-shape` 属于增强效果，WebView2 不支持时使用普通 `border-radius`；不通过引入渲染库补齐。

正文基准 14px/22px，次级文本 13px。上游部分代码条标题为 11px，Ollmin 默认仍以 12px 为辅助信息下限，作为明确的可读性差异记录。普通文本对比度目标至少 4.5:1；淡化提示若不满足，则调整令牌并记录差异。使用上游 Windows 系统字体回退链，代码字体显式包含中文回退；首版不加载远程字体。Montserrat 仅是品牌字体资源，是否内置须单独评估，不影响基础聊天验收。

### 3.1.1 共用控件、表面与浮层

全仓样式规范不是“设置一套圆角和颜色”就完成。依据 [Web样式规范](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/web-styling.zh.md)及 [统一圆角规范](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/ui-radius.zh.md)，补充以下实施契约：

| 元素 | dsh约定 | Ollmin实现/验证 |
| --- | --- | --- |
| 菜单/选择弹层 | 标准R16外框+4px内缩+R12选项；紧凑R12/R8 | 模型、模式、会话菜单共用表面；选中、悬停、禁用、危险动作分别表达 |
| 高层级表面 | `border:0`，elevation投影首层绘制0.5px描边；输入用soft层 | 不叠加实体中性border和同类描边投影，浅深色/DPI检查发丝线 |
| 普通分隔/描边 | 中性实线0.5px，警告色/dashed保留1px | 避免全局1px粗描边；按设备像素观察，不强求不同DPI栅格完全一致 |
| 菜单材质 | 共享fill与backdrop tokens，背景单独图层 | 支持时复刻半透明菜单；不支持或性能超预算用相应实色回退，并记录差异 |
| 模态遮罩 | 黑色半透明，不模糊整页 | 设置/确认框不加全屏backdrop blur，降低成本并对齐上游 |
| 圆角曲线 | 支持时统一`superellipse(1.5)`；圆/胶囊显式round | 支持检测；元素与伪元素曲线一致，嵌套内缩圆角正确，普通CSS回退 |
| 文本链接 | 语义link色、500字重，hover/focus点状下划线 | 复刻阅读示能，继续沿用Ollmin安全协议白名单，不添加文件访问权限 |

浮层通过portal离开聊天/输入容器的overflow裁切区；按锚点真实矩形测量后定位，空间不足翻转，上下左右限制在视口/标题带安全区内。滚动/resize时更新位置或关闭，卸载时清理监听。统一浮层层级，菜单可以高于设置面板，但其焦点仍属于打开它的模态层；不能简单提高z-index让背景控件可交互。菜单blur绘制层与fixed子菜单定位层分离，避免filter产生错误定位上下文。

Tooltip同时支持悬停与键盘焦点，短反馈/Toast不抢焦点；复制成功等可短暂消失，服务断线、解析失败、保存失败等阻塞错误保持可读及可恢复。图标采用统一视觉尺寸和线宽，只抽取实际复用的图形，不内置整套品牌/第三方图标包。上游基件是行为与设计参考，Ollmin用现有React/CSS和少量共用组件实现，不整体引入ui-primitives包。

补充已核实基件参数：普通Menu最小宽144px/最大360px、菜单与锚点间4px，选项最小高34px、内边距6px/8px、13px/20px字体；模型专用菜单沿用§3.5的独立宽度约束。Menu方向键移动真实焦点，支持Home/End，外部pointerdown/window blur和选择后关闭。Tooltip默认hover/focus不延迟、150ms进入动画；固定阅读是可选行为，不要求所有图标点击固定Tooltip。Toast默认3000ms展示+1000ms淡出，只有动作按钮接受指针，重复失败应重新公告而非复用过期反馈。菜单/模态的数字层级可映射为Ollmin统一变量，不必硬编码上游的1000/1100。

材质事实复核：`ui-theme/src/styles/gradient-shadow-text.css`将`--dsw-mask-blur`设为`none`，菜单专用token为`blur(40px) saturate(150%)`；`ui-theme/tests/elevation-styles.client.spec.ts`断言遮罩不模糊。模态CSS出现backdrop-filter变量不代表运行时有模糊；Ollmin只对菜单评估blur性能，不模糊整页。

滚动条按主题和层级统一管理：主正文l1，菜单/设置等高层表面使用l2；上游WebKit路径是5px细滚动条，透明track和圆thumb。不要同时无条件设置标准scrollbar-color与WebKit伪元素造成Chromium覆盖悬停样式。侧栏隐藏thumb时保留空间，输入、弹层和正文的滚动互不穿透；长代码列结构不强行换行，横向滚动只限代码/表格内部。

### 3.2 Windows 壳层与侧栏

上游 `WINDOWS_TITLEBAR_HEIGHT=40`；Windows 主区左上圆角 16px。左栏默认 280px、拖动范围 264–420px、自动折叠断点 1024px。特别注意：上游通用 Web rail 是 56px，但带 Windows titlebar 的桌面布局折叠宽度为 **0px**，折叠/新建按钮留在标题带；不能误做成永久 56px 图标栏。

Ollmin 方案：保留无边框 Tauri 窗口，复用现有 `startDragging`、`toggleMaximize`、`minimize`、`close` 逻辑；按上游 Windows 几何重排拖动区和按钮。交互按钮排除拖动，双击空白标题区域最大化。最小化/最大化/还原/关闭图标须与实际窗口状态一致。

折叠状态和左栏宽度使用带 `ollmin.ui.*` 前缀的本地 UI 偏好，校验有限数值与范围，损坏时退回默认；访问 localStorage 失败也不能阻断启动。这是 Ollmin 的适配：上游侧栏 store 为运行时状态，关闭后重开回默认280px，本轮未见持久化依据；上游正文拖宽则明确使用 localStorage。窄窗自动折叠不覆盖用户宽窗偏好，窄窗手动展开须有返回路径。拖动使用 Pointer Capture 和按帧更新；拖动/连续窗口 resize 不开布局缓动，只对离散折叠动作使用动效，避免跟随窗口边缘延迟。

当前原生下限为 860×640，默认 1180×820。首版保持下限，验证 860、1024、1180、1440px 宽度，1024 以下测试自动折叠；更小窗口需要另行验证和调整 Tauri 配置，不把浏览器模拟窄窗等同于原生支持。

侧栏保留本地新建、150ms 去抖搜索、历史列表、选中态和底部设置。参考上游水平12px/垂直6px内边距、历史行最小36px、7px/8px行内边距和4px行间距；Windows顶部采用平台覆盖规则，不照搬通用rail的logo高度。模型常驻功能保留但改成次级本地入口，不能因模仿上游而自动预热。历史行以标题为主，模型/日期为次级信息；使用省略和 Tooltip，不在窄行堆叠冗余状态。删除通过“更多”按钮和右键两种入口，不能依赖右键才能操作。上游工作区树不伪装成本地文件工作区。

### 3.3 内容宽度与空态

上游正文宽度不是始终固定 748px。当前 CSS 默认共享轴是 `clamp(680px, columnWidth×0.64, 920px)`，输入卡片最大宽度是正文宽度 **+32px**；窄容器有独立降级规则。`ConversationWidthControls.tsx` 支持用户拖动正文宽度，拖动下限 640px并预留边缘空间。源码注释中旧的 `+16px` 或 748px 设计值不能覆盖当前可执行 CSS。

Ollmin 用一个共享变量管理正文、输入、空态和浮层锚点，先实现自适应，再实现正文宽度拖动与偏好恢复。窄窗使用 `min(可用宽度, 目标宽度)`，不能强行维持 680px造成横向溢出。更改宽度不改变模型上下文 token 设置。

新会话显示 Ollmin 欢迎标题和同一个输入组件，垂直居中；标题参考上游26px/32px，标题组间距10px、输入卡片上方12px。只有服务可用和模型已选时可以发送。服务离线、没有模型、历史加载中和空搜索结果分开表达，提供对应已有恢复动作。首轮开始后输入移到底部，保持同一组件实例和 key，避免 textarea 重新挂载丢失输入法状态、焦点或附件。

### 3.4 输入与消息

输入卡片按上游 28px 圆角、顶部 8px 内边距、文本与工具行 12px 间距、正文 14px/24px。底部模式最小文本区 36px、Hero 模式 52px，文本区最多 14 行/336px；长输入只滚动一个内部容器，窗口高度不足时进一步收紧上限。卡片宽度始终与正文同轴。

继续使用 textarea。上游输入器使用 Lexical、引用节点、装饰器、输入状态机和插槽，是 Agent 输入需求的实现，不能为了纯文本外观照搬。textarea 用内容高度测量实现自动增高，复用现有 draft/ref/sendMessage；不存在文件引用节点和斜杠工具命令时不增加编辑器。

工具行左侧为附件与性能模式，右侧为模型和发送/停止主按钮；附加状态置于卡片附近，避免侵占输入正文。模型仍使用真实 Ollama 名称发请求，界面使用既有别名函数。长模型名和 860px 窗口下工具行允许换行，发送动作始终可达。附件继续最多 3 个 PDF/DOCX/XLS/XLSX，仅使用既有文件选择和解析接口；解析中/失败/已就绪/移除分开显示，不复制上游上传和图片入口。

用户气泡右对齐，参考上游 `min(chatWidth×0.702, 82%)` 最大宽度、10px/16px 内边距、20px 圆角，移除当前白色描边阴影。助手回答左对齐无气泡背景。一般流程行间距 6px、助手响应附近 12px；Ollmin 用户/助手回合之间保留可辨识间隔，不模拟不存在的工具执行行。

思考改为 24px 紧凑披露行，13px 次级文本摘要，展开正文按会话滚动；内容不放在黄色卡片内。生成中是否自动展开沿用当前默认，但用户手动收起后不能被每帧流事件重新展开；完成状态仅影响初始默认值，不覆盖用户选择。长思考展开时保留收起入口并避免与代码块吸顶条重叠。无 thinking 的模型不显示空披露行。

复制图标参考上游操作行和短暂成功反馈，用户与助手正文都可复制；复制失败显示原因，不展示虚假成功。默认复制正文，思考需独立明确操作；不用未实现的分支、重新生成、赞踩占位按钮。tok/s、耗时、上下文预算继续可查看，信息密度改为次级摘要；在没有逐消息指标映射时不伪造上游每回合统计。

### 3.5 模型与性能选择器

上轮仅要求“模型选择换皮”不够。上游 `ui-model-selection/ModelSelect.tsx` 是二级弹层：根菜单包含Model/Effort，再进入各列表；模型超过4个时显示搜索，并有分组、当前选中标识、加载重试和选择失败反馈。trigger高28px、13px/20px字体、R8；弹层宽度约束为240–420px并受`100vw-32px`限制，高度上限360px且受视口限制。长名称先省略次级effort文字，极窄工具行可以退到图标但保留可访问名称。

Ollmin核心阶段新增可搜索模型弹层：列表来自现有 `/api/tags` 结果，名称通过别名函数解析、请求ID使用原始模型名；根菜单的性能项展示快速/平衡/推理，替代云提供商的effort语义。保留本机单来源，不虚构provider组、账户、模型能力或云推理强度。模型切换仍走当前动作；它是本地状态变更时不伪造后端pending，刷新列表失败与选择无效分别反馈。标签目录不按每次打开菜单触发重复请求，只在已有刷新流程或用户重试时更新。

共用选择组件应支持搜索、选中、方向键/Enter/Escape、返回上一层与焦点回收。单层模式选项可复用相同表面，不强行为3项设置搜索。原生select保留为首阶段或辅助降级；完成核心验收时需换成该弹层，不能将原生系统下拉框视为已经复刻dsh体验。

## 4. 交互契约与状态矩阵

### 4.1 生成和滚动

保留 `activeRequestId`、序列号、会话加载序号、thinking/content 双通道、Rust 调度锁、前端 `createStreamCoalescer` 及首字/终态及时刷新。消息 key 保持稳定，历史消息对象不因当前 token 更新重新创建，保留 `MessageItem` 的 memo 边界。状态展示只能从已有事件推导：准备/等待、已有思考、正文输出、完成、停止、失败；没有可验证的后端阶段信号时不编造加载百分比或阶段耗时。

沿用距底部 72px 内跟随；用户上滑立即停止自动拉底，显示“回到最新”按钮。显式跳到底部后恢复跟随。思考展开/收起、输入增高、宽度调整均应维持阅读锚点。流中暂停平滑滚动，不逐 token `scrollIntoView`。错误和停止保留已有部分正文与可复制内容。

| 状态 | 输入与主动作 | 必须可见的信息/验收 |
| --- | --- | --- |
| 离线/无模型 | 禁止发送，允许查看历史/设置/恢复连接 | 说明服务或模型原因，不无限转圈 |
| 正常空会话 | Hero 输入可用 | 模型、模式、附件入口与占位文字 |
| 解析附件/预热 | 沿用现有请求门禁 | 本地处理状态、失败原因、可移除动作 |
| 加载历史 | 禁止冲突操作 | 稳定加载反馈；迟到加载结果不覆盖新选择 |
| 等待/思考/输出 | 单个生成；主动作停止 | 已有内容稳定，草稿行为沿用当前可用策略 |
| 停止后立即发送 | 新请求独立 | 旧事件不得写到新回答，锁释放必须验证 |
| 失败/完成 | 恢复发送门禁 | 部分内容、复制、最终指标或错误原因 |
| 长历史/长正文 | 输入和跳到底部可达 | 无横向溢出、无抢滚动和明显重复渲染 |

历史加载阶段补充上游的`settling`语义：`ConversationMainPanel.tsx` 在历史尚不能判断Hero/active时，隐藏输入位置选择而不先闪欢迎态再跳到底部；已知空会话可直接显示Hero。Ollmin复用当前加载状态，保持常驻输入和滚动容器；不能因组件提取或会话key变化重挂整个主舞台。

### 4.2 键盘、菜单和弹窗

默认保持 Enter 发送、Shift+Enter 换行、Ctrl+N 新会话。中文/日文等 IME 合成中 Enter 必须只确认候选词，通过 `isComposing` 和 composition 生命周期判断。上游 `input/editor/keymap.ts` 还检测 `keyCode=229`，并有针对Safari事件顺序的compositionend后10ms保护；Ollmin先覆盖WebView2实际事件序列，不默认照搬Safari延迟补丁，必要性由原生IME复现决定，作为明确的平台适配。重复Enter（`event.repeat`）和提交中重入须被抑制。

上游Ctrl/Cmd+Enter走accelerated delivery，涉及其运行中输入调度；Ollmin不引入Agent队列，将Ctrl+Enter作为当前可发送状态的同等发送动作，busy时沿用单请求门禁，不暗中插入下一轮。上游可配置发送键行为可作为 UI 设置扩展，但不得未告知就改默认键。Ctrl+N是沿用Ollmin现状，侧栏组件的上游快捷键通过注册ID解析，不能由组件源码猜测具体组合键。

Escape 按最上层交互处理：关闭菜单 → 关闭/取消当前弹窗 → 无弹层时停止生成。这是对Ollmin已有Escape停止的统一层级提案，不是上游composer的原样行为；上游优先关闭popup，再交给输入仲裁。事件被消费后不能继续触发下层停止。重命名、删除和清空使用一致的轻量对话框，复用现有业务 callbacks；删除/清空必须明确对象和不可恢复后果，默认焦点放在安全动作。新增设置快捷键前核对上游定义和 Windows/WebView2 冲突，并在界面展示。

弹窗要求 `role=dialog`、`aria-modal`、可访问标题、打开时焦点、Tab/Shift+Tab闭环、Escape、关闭后返回实际触发按钮。参照上游`useModalLayer.ts`，焦点层栈只让最上层消费按键；菜单先消费Escape，IME/修饰键/repeat不误关模态，触发项卸载时有安全焦点回退。菜单支持键盘进入、上下键、Home/End、Enter和Escape，关闭后回收焦点。图标按钮有中文可访问名称，focus-visible可见；桌面密集图标优先保持上游视觉尺寸，同时确保至少24×24px可操作区域。状态用文本与图标共同表达，关键错误用alert；逐token内容不反复通过live region播报。

### 4.3 设置结构与保存

参考上游 800px 面板、188px 导航、28px 圆角，内容区单独滚动。上游宽度上限为`100vw-48px`，高度是`min(800px, 100vh-2×max(24px, frameOverlayTop))`；普通Windows标题带的frameOverlayTop通常为40+20=60px，因此640px窗高下该式给出520px，不是800px强制高度。在 860×640 下允许收紧导航/边距，但关闭按钮和保存动作必须始终可达。

建议四组：外观（主题及界面偏好）、模型与性能（默认模型/模式/预算/别名）、会话与隐私（思考保存/导出/清空）、本机服务与关于（连接刷新、常驻入口、应用版本）。字段依赖已有 `AppSettings`，不展示账号、提供商、插件或工具配置。

上游 `SettingsRoot` 是分类/插槽弹窗壳，没有全局保存按钮，各section自行决定保存策略。第一版保留 Ollmin 的 `settingsDraft`、保存/取消语义和 `saveSettingsDraft`，作为明确的行为适配：切分类不丢草稿，保存中阻止重复提交，失败保留编辑内容；dirty 状态关闭需确认放弃，不能悄悄保存。主题可以预览，取消需恢复已保存主题。UI 几何偏好与持久化业务设置分开，首版不为折叠/宽度增加 SQLite 迁移。若后续要复刻即时保存，则单独记录决策、失败回滚和隐私开关测试，不能混在视觉阶段。

全仓进一步核实：上游theme/字号本身是即时写Host `user-settings`的`ui-theme` namespace，并用revision隔离迟到回写；字号默认14px、10–22整数，仅影响会话内容。这与Ollmin草稿保存是明确差异，不能写成上游也按全局保存。外观组加入会话字号控制，Ollmin以12–22px区间兼顾阅读下限，UI偏好按保存/取消处理并记录无法持久化的失败。正文行高、思考、代码及输入按统一字号差量联动，标题栏/侧栏不整页缩放。

启动和跟随系统也属于体验：上游mount前应用theme/字号，system模式订阅`matchMedia`变化并在dispose时清理。Ollmin现有App主题effect只在设置值变化时计算，需补system运行中切换；启动读取既有设置后尽早应用主题，读取期间使用中性启动面，避免先显示暖色/浅色后跳深色。不得用重复后台请求刷新主题，也不为首屏主题复制整个Host启动系统。

### 4.4 会话导航、搜索与回合定位

全仓的左栏真实业务由`ui-workspace`和对应workspace/session controller共同实现，不只是`ui-sidebar`壳：包含工作区树、未分组会话、排序、置顶及归档筛选。Ollmin当前`ConversationSummary`没有工作区、置顶或归档字段，因此采用分层对齐：

| 体验 | 核心阶段方案 | 最大一致性后续 |
| --- | --- | --- |
| 会话列表与行操作 | 扁平本地列表、现有按更新时间顺序；更多/右键菜单提供重命名、导出、删除 | 工作区/手动排序涉及新数据语义，单独设计 |
| 快速搜索 | 复刻侧栏内搜索入口及Ctrl+K聚焦；折叠时先展开，复用`list_conversations(query)`和150ms去抖，覆盖键盘与加载/空/错态 | 不另造命令面板；不伪造分页、正文摘要或归档命中，需要时扩展结果契约 |
| 会话头部 | 当前会话标题、必要本地摘要、动作菜单 | 只有注册多个真实视图才出现tabs，不引入Trajectory空页面 |
| 置顶/归档 | 首版不显示没有实现的入口 | 数据字段、schema迁移、搜索默认排除、恢复/导出/删除规则明确后实现；归档不等于删除 |
| 草稿与历史选择 | 至少保护当前草稿，切换行为显式验证 | 如要会话级草稿恢复，先定义暂存/清理/隐私规则，不未经确认落盘 |

Ollmin现有后端搜索包含消息正文匹配，但返回的是会话摘要；快速搜索只展示可验证的标题/模型/时间信息。请求结果按查询代次隔离，较早查询不得覆盖较新结果；关闭后回到触发按钮，打开会话后将焦点转到主区合理位置。不要把服务刷新搜索和模型推理混为一条路径。

上游`ui-chat/TurnNavigator.tsx`是回合轨道，支持当前回合、预览、点击定位及未加载历史；轨道使用`@tanstack/react-virtual`，并不等于整个聊天列表都已虚拟化。Ollmin增加轻量回合定位：由当前已加载消息中的用户消息ID建立锚点，当前回合随阅读位置更新，悬停/焦点显示问题摘要，点击仅滚动不发送消息；同时保留“回到最新”。不支持后端分页时不绘制虚假未加载标记；首版不用新虚拟化依赖，长轨道的独立滚动/隐藏与窄窗布局按性能证据处理。

上游`WorkspaceBrowser.tsx`搜索将本地元数据与Host内容搜索结果合并，含500 code units查询上限、请求取消、加载/空/更多结果状态；Escape清空并收起，空查询点击外部才收起。Ollmin沿用SQLite现有正文匹配能力，不新增模型检索；查询归一化/长度限制、代次隔离和取消收起行为加入验证，不能声称具备上游全部分页/归档搜索。底层invoke不可取消时，仅丢弃过期结果，不伪造AbortController能终止Rust查询。

实际`ui-workspace/shortcuts.ts`注册确认：桌面新建Ctrl+N、搜索Ctrl+K、重命名Ctrl+Alt+G；新增工作区Ctrl+O、分支Ctrl+Alt+F、归档Ctrl+Shift+A有对应业务前提。前三项映射到Ollmin现有动作，后几项在未实现时不注册。设置和侧栏快捷键同样核对各自命令owner，速查只列已实现项。选择器/搜索/设置/菜单共同验证焦点和快捷键作用域：模态打开时不触发背景新建、删除或生成；回合导航不覆盖IME合成。会话头部祖先导航来自Session parent/subagent关系，不是每个会话单独多开tab或凭文件目录生成面包屑。

## 5. 技术实施方案

### 5.1 组件与文件边界

建议目标结构（文件按阶段需要逐步出现，避免一次性空目录/抽象）：

```text
src/App.tsx                          继续拥有请求/会话/设置持久化生命周期
src/features/shell/WindowTitleBar.tsx Tauri 窗口表现与已存在动作
src/features/sessions/SessionSidebar.tsx 侧栏、搜索、会话菜单
src/features/chat/ChatWorkspace.tsx   Hero/消息列/输入位置与宽度
src/features/chat/Composer.tsx        textarea、附件、模型/模式和主动作
src/features/chat/ModelPicker.tsx     本机模型搜索与性能选择弹层
src/features/chat/TurnNavigator.tsx   已加载回合锚点、摘要与定位
src/features/settings/SettingsDialog.tsx 分类、草稿及保存动作
src/components/MessageItem.tsx       沿用并调整消息/思考/复制
src/components/MarkdownContent.tsx   沿用安全渲染，扩展另立阶段
src/components/ui/                  模型/模式/会话复用的菜单表面与模态行为
src/index.css                        语义令牌、基础样式与平台规则
```

先使用现有 CSS 和局部明确的 class；单一区域复杂样式可在提取组件时迁入 CSS Modules，不能同时全量改名制造回归。提取后状态所有权单一，callbacks 直接复用 `src/features/*/helpers.ts`、`src/lib/*` 与 `src/api.ts`。不为界面重构建立 Cordis、插槽注册中心、通用 Renderer、路由系统或新状态库。

生产依赖首阶段保持不变：React、Tauri API、dialog 插件已能覆盖布局/弹窗/文件入口。上游 React 18.2 与 Ollmin React 19 有版本差异，直接拷贝组件需核对类型/ref/effect 清理；带 `useSession`、`renderSlot`、Cordis、上传与工具协议的组件不能作为独立 UI 直接 import。

### 5.2 Markdown 体验的分层补齐

这是与现有 [DECISIONS.md](DECISIONS.md) 中 D-013 的真实差异，不能将完整渲染引擎视为纯 CSS 工作。

1. 基础阶段：保留 React 节点和链接白名单，先复刻标题、段落、引用、列表、行内代码外观；围栏代码用安全 `pre/code` 与语言标签/独立复制按钮，流式未闭合围栏可显示为未完成代码块，不执行 HTML。
2. 对齐阶段：比较嵌套列表、GFM 表格、链接和流式解析质量。如果现有解析器无法可靠覆盖，以小型 AST Markdown 解析依赖替代扩张手写正则；只加入实际语法所需模块，解析后仍用 React 节点渲染。不能同时无限扩展自研解析器和引入第二套解析器。
3. 高亮/公式阶段：上游 `ui-primitives` 使用 mdast/micromark、GFM/math 扩展、Shiki 4.3.1、KaTeX 0.16.47及本地路径能力。Ollmin 不整体安装该包；如批准，按代码语言白名单和可见已完成代码块懒加载，公式单独按需加载并经过安全评估。阶段前更新 D-013 或追加替代决策。

任何阶段都不加载模型输出中的远程图片/HTML、任意本地路径、iframe或脚本；不直接复制上游 localPathMediaUrl/file API 的权限语义。复制保留原文本。超长消息允许退回安全文本，未知语言无需加载全部 grammar。高亮、公式和完整 GFM 属于最大体验一致性的后续工作，有明确入口；基础版验收时必须列出剩余差异，不声称完全一致。

### 5.3 桌面适配与许可

Tauri 2 自定义窗口接口已通过 Context7 对照 [官方窗口定制文档](https://v2.tauri.app/learn/window-customization/)。现有能力文件先核对再改，只按需要保留/增加窗口动作权限；不用 Electron preload、Node runtime或 Chromium 的 `-webkit-app-region` 替代 Tauri 拖动接口。CSS 新特性以项目实际 WebView2 测试为准，设置支持检测和普通 CSS 回退。

上游 [LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/LICENSE) 是 MIT。若实施阶段复制实质代码/CSS，保留其版权与许可声明，添加精确来源/提交及修改说明；字体和其他资源另查各自许可。以独立实现复刻交互时仍维护参考出处表。本次只新增计划，不引入上游代码或资源。

### 5.4 全仓能力映射与明确差异

上游`ui-sidebar-right`/`ui-dockkit`及documentpreview/files/browser/terminal组合成多用途右侧面板；`ui-tool`/`ui-approval`/`ui-deliverables`承载执行过程、审批和产物；`ui-input-trigger`/commands/reference提供斜杠和引用输入。它们有真实Host能力支撑，不能只借视觉引入空面板和无效动作。

上游`ui-attachment`草稿是文件/图片有序横向rail，通用文件卡240×64px，包含上传进度、失败重试和移除。Ollmin映射为最多3项本地附件rail，参考64px密度并允许窄卡，展示类型、名称、解析中/失败/就绪和移除；溢出有可达的横向滚动/箭头，键盘焦点不会落到不可见卡片。只有真实解析进度时才显示百分比，不把spinner冒充上传进度，不复制图片上传/灯箱。

附件卡可打开轻量详情，显示现有名称、片段数、页数/工作表和warnings，复用既有helper。此详情只读`AttachmentSummary`，不新增原文件路径读取、Office转PDF、终端、网页嵌入或远程图片。上游`ui-sidebar-documentpreview`是工作区文件预览系统，与附件详情不是同一个能力；若用户需要原文预览，再单独定义只读路径权限和解析资源预算，不照搬多渲染器/worker/Office转换依赖。

上下文计量与运行统计只映射真实Ollama指标：预算上限、已返回prompt/eval计数、tok/s与耗时。上游Agent压缩检查点、context injection、quota与turn usage面板不原样搬入；在不具备当前KV状态和完整预算依据时不展示伪精确占用百分比。Like/Dislike、分支和重新生成的按钮仅在相应存储/动作存在时加入。

复刻覆盖率按功能区域登记，而非“整仓所有模块”：每个区域标明直接对齐/本地等效/后续决策/权限边界省略及源码依据。核心验收必须覆盖菜单/选择、搜索、回合轨道和浮层，不能只验收首屏截图；最大一致性后续包括完整富文本和置顶/归档等真实新语义，分别评估并获授权。

## 6. 分阶段实施、交付与预计投入

投入是单名熟悉项目开发者的工作日估算，含验证和修正，不是交付承诺。全仓补评后，核心阶段0–5扩充到约15–22工作日，包含真实选择弹层、快速搜索、回合导航及共用浮层；阶段6完整富文本另加3–5工作日。置顶/归档等数据扩展尚未纳入承诺，待单独决策后排期。每阶段开始时重新检查diff和现有实现，避免覆盖其他Agent已完成工作。

| 阶段 | 工作与交付 | 文件范围 | 验证/退出条件 | 估算 |
| --- | --- | --- | --- | --- |
| 0 基线与规格 | 固定上游、采集两端 Windows 截图/交互录屏；整理几何和状态矩阵、资源/IPC基线 | 文档与本地证据，不改业务代码 | 有相同主题/DPI/窗口/数据的对照；记录不可用状态和明确差异 | 1–2天 |
| 1 主题与壳层 | 冷色语义令牌、40px标题带、主表面、280px侧栏；最小视图提取 | CSS、WindowTitleBar/App | 浅深色/窗口动作/860px布局通过；请求逻辑 diff 未扩大 | 2–3天 |
| 2 侧栏与内容轴 | 快速搜索/行菜单、共用MenuSurface/模态、折叠/拖宽/偏好恢复、内容轴 | SessionSidebar/ChatWorkspace/ui基件/CSS | 1024断点、查询竞态、损坏偏好、连续resize、portal翻转/焦点 | 3–4天 |
| 3 Hero与输入 | 常驻Hero/底部切换、settling、自动增高、模型搜索/性能弹层、附件、IME | Composer/ModelPicker/ChatWorkspace/ui基件 | 中文合成不误发；3附件/长模型名/搜索可用；停止后立即重发 | 3–4天 |
| 4 消息与阅读 | 气泡/排版、思考披露、复制、回合轨道/最新导航、基础代码块 | MessageItem/TurnNavigator/Markdown/CSS | 当前回合与锚点正确、安全渲染、阅读保持、复制反馈 | 3–4天 |
| 5 设置与全量验收 | 双栏设置、菜单/对话框焦点、危险操作、主题取消恢复；回归与资源对照 | SettingsDialog/ui基件/App/CSS/docs | 状态矩阵、真实原生/DPI/本地Ollama回归；核心差异关闭 | 3–5天 |
| 6 最大富文本一致性 | AST/GFM、可见代码高亮、可选公式，更新D-013与依赖来源 | Markdown/按需依赖/测试/docs | 安全、流式与性能预算均达标；失败时保持基础版 | 3–5天 |

依赖关系：0 → 1 → 2 → 3 → 4 → 5；6依赖4的内容和性能基线，可以在核心验收后独立交付。每阶段一个明确目标，验证后重建 Debug 和 Release exe，更新正式文档/交接及 Graphify，再提交中文 Git commit。只有用户明确要求时生成 setup 安装包。文档计划本身无需重建 exe。

推荐提交名称如“重构Ollmin主题与桌面壳层”“重构Ollmin输入区与欢迎态”；不要将所有阶段合为无法定位问题的大提交。发布操作与本地提交分开验证。

## 7. 验证方法与验收门槛

实施进度与实际证据统一记录在 [UI重构实施与验证](./UI-REFACTOR-VALIDATION.md)。2026-09-30阶段1–5已实现，当前根项目46项单元测试、47项Rust测试通过；阶段2/3/4/5分别50/41/22/33项浏览器检查通过。Debug/Release及原生探测证据见验证记录；匿名参考、DPI全矩阵和真实Tauri状态联调仍待补。不要把指定用例通过等同于全量复刻验收。

### 7.1 静态与自动检查

每个前端阶段执行项目现有命令，保留测试输出与产物时间/哈希：

```powershell
npm run test
npm run build
git diff --check
npm run tauri -- build --debug
npm run tauri -- build
```

涉及 Rust/Tauri command、权限或存储行为时，补 `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 与 `cargo test --manifest-path src-tauri/Cargo.toml`。纯 CSS 不为重复样式编写单元测试；新宽度裁剪、偏好容错、IME、消息状态和 Markdown 分支，使用现有 Vitest 留下能击穿错误的最小检查，不引入另一套测试框架。

已有重点测试：`MessageItem.test.tsx`、`MarkdownContent.test.tsx`、`StatusPill.test.tsx`、`lib/{streaming,history,session,metrics}.test.ts` 及 feature helpers tests。当前缺少 `App` 层完整交互和原生 E2E，必要时增加小范围组件/行为检查，不能仅凭 helper 测试宣布整套 UI 已验证。

### 7.2 Playwright、原生和截图对照

优先使用已配置 Playwright MCP 做浏览器布局/交互采集；浏览器无 Tauri 时只验证可运行的前端区域。若需 IPC mock，应明确标记测试入口、隔离到测试代码，不能让 mock 混入生产 fallback。原生 Tauri 的文件选择、剪贴板、窗口拖动、DPI 和真实 IPC 必须单独跑 Debug/Release exe验收。项目没有完整原生 Playwright E2E，本计划不把“浏览器 mock截图”称为“桌面 E2E”。

截图矩阵至少覆盖：浅/深/跟随系统，空态/历史/思考展开与收起/生成/停止/错误/设置/菜单，860×640与1180×820及1440px宽，Windows 100%/125%/150% DPI。用合成会话覆盖中文、英文、混排、长模型名、长文件名、超长代码与表格；关闭动画后再截图。不得将真实用户数据库/附件正文提交 Git。

全仓补评追加必测状态：折叠侧栏Ctrl+K展开聚焦、搜索快速连续变更/空结果/Escape清空、模型二级弹层/搜索/返回/刷新错误、输入上方弹层翻转、设置内菜单嵌套与IME Escape、快速关开Toast、3附件rail/详情、回合hover/focus预览/定位/切会话锚点清理，以及运行中系统主题切换和启动深色无闪烁。多视图头部和加载settling另取截图，确认省略的插槽没有残留高度。

参考程序优先使用与固定提交相符的构建；若只能运行另一发布版本，注明版本差异，不能把它截图与本快照 CSS 当成同一基准。逐区域对照：标题带、侧栏、主区边缘、正文/输入轴、气泡、设置、菜单。屏蔽品牌、真实模型名、日期和输出正文的预期差异，保留几何/字体/颜色差异。

拟定门槛：100% DPI 下主要区域边界偏差≤4px、控件尺寸和间距偏差≤2px、正文与输入中心轴偏差≤2px；颜色按已确认令牌逐项检查。DPI截图先转成逻辑坐标，允许字体栅格差异。区域像素 diff用于找问题，不以整图相似度“95%”替代可读性和交互验收。明确的品牌/字号下限/功能边界差异另列，不混入缺陷评分。

### 7.3 功能与安全回归

- 新建、搜索、重命名、删除、清空、切换会话、关闭重启恢复、Markdown/JSON导出；失败时不丢已存在会话或草稿。
- 本机服务离线、未安装模型、模型消失、断流、等待首字、停止后立即发送、旧事件迟到；始终单请求，不新增后台模型请求。
- thinking/content渲染与复制分离；`saveThinking=false/true` 新消息落盘符合原契约，关闭开关不暗中清除旧数据。
- 快速模式 `think:false`、默认4K上下文、输出限额及完整轮次裁剪；用户已有显式预算覆盖规则按当前后端实现验证，不能从 UI 标签推定发送参数。
- 3个附件、格式不支持、解析失败、移除、跨会话归属、附件源路径隐私；不为复刻新增读取权限或上传。
- 模型输出含 HTML、脚本链接、远程图片、伪造本地路径和未闭合 Markdown 时安全降级，CSP和链接策略保持有效。
- 键盘全路径、IME、焦点恢复、reduced-motion、Windows高对比度；删除和设置保存异常均给出明确反馈。

验收设计参考的上游测试包括`ui-primitives/tests/modal-layer.client.spec.tsx`和`ui-theme/tests/elevation-styles.client.spec.ts`；只提取用例目标，不运行其测试冒充Ollmin回归。补充菜单Home/End/Tab、嵌套Escape优先级、触发项卸载后的焦点回退、system订阅释放和字号取消恢复检查。回合轨道与历史列表虚拟化分开度量，导航不能触发生成或引入后台请求。

验证产物是日志、截图/录屏索引、失败案例、资源对照、exe路径与哈希、Git commit。每次测试结束关闭本次启动的进程/浏览器页面。构建前发现旧 exe占用时，核实完整路径确属 Ollmin 后结束该进程；不结束其他应用。

### 7.4 低配性能预算

在同一 Windows机器、WebView2版本、Release构建、主题、窗口大小和合成数据下测量旧版/新版。至少5次重复，记录中位数和异常范围；分开计算客户端/WebView2与Ollama，不能把模型速度波动归因于 UI。

| 项目 | 方法 | 建议门槛（待阶段0基线校准） |
| --- | --- | --- |
| 前端体积 | Vite报告及压缩体积，区分首包/懒加载包 | 核心阶段首包增量≤15%，无新重型UI依赖 |
| 空闲资源 | 启动后30秒测应用/WebView2总私有内存与CPU | 中位内存增量≤10%；不新增持续计时器/模型轮询 |
| 输入/菜单反馈 | DevTools Performance测受控输入与动作到绘制 | p95≤100ms，无重复同步布局 |
| 流式渲染 | 固定合成事件节奏，记录React Profiler和long tasks | 首字/终态不新增人为等待；UI引入的>50ms任务不多于基线 |
| 长会话 | 200条混合消息和长代码；滚动、继续生成、开设置 | 历史消息不随token全量重渲染，输入/停止保持响应 |
| 首次可交互 | 固定冷/热启动分别记录5次中位数 | 核心UI阶段回退≤10%；不可交互占位不算完成 |

超过预算先排查重复渲染、宽度测量、重复动画、Markdown全量解析和库首包；按证据决定分块缓存或懒加载。只有长会话测量证明 DOM成本需要时才引入虚拟列表，不提前引入并破坏查找、文本选择和阅读锚点。完整高亮/公式阶段另测首次使用成本，不能用“已懒加载”替代实测。

## 8. 风险、取舍与回滚

| 风险 | 预防与处理 |
| --- | --- |
| 视觉改造顺手搬动请求状态，破坏取消/落盘 | 状态所有权先不动；每阶段审查真实调用链，停止/迟到事件做独立回归 |
| 深色/新CSS在WebView2失真 | 先对照计算样式与条件标记；支持检测、普通圆角/布局回退；原生截图验证 |
| Hero切换导致焦点/IME/附件丢失 | 复用同一Composer实例，固定key，测试首轮状态变化和输入法 |
| 侧栏/正文拖宽导致窄窗溢出 | 有限范围校验，窄容器覆盖，resize不缓动；恢复损坏偏好仍能操作 |
| 修改设置保存或思考开关引发隐私行为变化 | 保留草稿事务和显式保存；即时保存单独决策，不混入重排 |
| 完整Markdown引擎扩大体积/权限 | 独立阶段及性能/安全门禁，不复制路径访问、HTML或图片加载语义 |
| 上游继续变化 | 按固定commit完成；需要追新时另列增量差异，不自动同步master |

每阶段可独立回滚到前一提交；若产物或验收失败，保留已验证 exe与失败证据，不标完成。使用新的 `git revert` 回滚本任务提交，不能 reset/覆盖用户其他修改。UI阶段优先不改数据库，确保旧exe仍可读现有数据；如后续确需schema迁移，另立计划和迁移回归。

## 9. 预期成效与完成定义

核心交付后预期：从暖色工具窗变成接近 dsh-desktop 的冷中性色桌面聊天界面；空态输入、收缩导航、流式阅读、思考披露、操作反馈和双栏设置形成一致体验。用户能继续使用 Ollmin 的本机模型、三档性能、附件与本地会话，不新增Agent运行时或云端依赖。

可以验证的成效是几何/令牌差异缩小、键盘流程完成、长输入与阅读稳定、资源未明显回退。UI重构不承诺模型推理变快、首token变短或回答质量提高；这些仍依赖模型、硬件和请求预算。

完成定义：阶段0–5交付、状态/截图/原生/功能/性能矩阵通过、关键差异清单关闭、Debug/Release exe重建并记录、正式架构/开发/测试文档与交接更新、Graphify代码AST更新、分阶段中文提交完成。阶段6未实施时明确标注富文本差异；若要求完整富文本体验，需同时完成阶段6后才能称该部分对齐。

## 10. 决策点与执行清单

本次只编制/修订计划，不将“参考 UI”扩展成对产品功能的授权。核心默认方案已给出；进入以下依赖工作前按项目约定确认：完整Markdown/公式引擎替代D-013、置顶/归档/工作区/分支及对应数据迁移、原文预览或新增文件读取接口、任何远程或Agent能力、业务设置改即时保存、降低原生窗口下限、品牌字体资源引入。已获明确实施授权的事项不重复询问；其余独立核心工作按已确认方案推进。

- [x] 核对当前Git、Ollmin源码/文档与既有UI更新。
- [x] 固定上游commit，核对桌面壳和共享UI源码。
- [x] 编制技术方案、阶段依赖、验证方法、预算、预期成效与取舍。
- [x] 全仓补评：启动/组合、工作区导航、快捷键、模型选择、共用基件、主题生命周期、附件/预览和回合定位。
- [ ] 阶段0：Ollmin基线已完成；本机dsh版本/脱敏布局观察已补，匿名参考截图与完整交互/资源对照待补。
- [x] 阶段1：主题、标题栏、主表面。
- [x] 阶段2：侧栏搜索/菜单、内容宽度、偏好与共用浮层；指定验证和Debug/Release重建完成，详见验证记录。
- [x] 阶段3：常驻Hero、模型选择、输入、附件和主动作；已完成浅深色四宽几何与41项合成交互验证，实机联调缺口见验证文档。
- [x] 阶段4：消息、思考、复制、回合轨道和阅读导航；44项单测及22项合成交互通过，安全代码块保持基础子集。
- [x] 阶段5开发：双栏设置、字号偏好、主题预览/取消、保存门禁与焦点恢复；完成指定回归及产物交付，证据见验证文档。
- [ ] 阶段5全量原生验收：匿名dsh对照、其他系统DPI、原生输入法/附件和真实Tauri聊天取消/存储状态矩阵待补。
- [ ] 阶段6：按决策推进完整富文本一致性。

实施时每阶段完成后及时更新清单及证据，未覆盖的原生/DPI或真实Ollama场景必须单列，不用构建成功代替体验验收。

## 11. 本次全仓重新评估结论与源码入口

保留原计划的Tauri/React架构、主题/Windows几何和行为隔离；修订重点是把“看起来接近”推进为完整的主要交互闭环，核心阶段必须包含模型弹层、侧栏快捷搜索、回合定位、共用菜单/模态/反馈、启动与系统主题、附件rail。修正了搜索入口应位于侧栏、视图tabs条件显示、历史加载不闪Hero、模态无blur、主题即时保存与Ollmin草稿策略不同等细节。未安装/运行上游，原生外观和资源差异仍由阶段0验证。

供实施者复查的固定提交入口：

- [实际Web/UI装配清单](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/bundle/web-app/cordis.patch.yml)
- [Web Client分层与数据所有权](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/subsystems/web-client.zh.md)
- [会话导航快捷键](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-workspace/src/client/shortcuts.ts)
- [侧栏搜索和导航](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx)
- [模型选择器](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-model-selection/src/client/ModelSelect.tsx)
- [共用UI基件](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-primitives/src)
- [启动主题应用](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-theme/src/boot-theme.ts)
- [回合跳转与阅读锚点](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-chat/src/client/chat/use-chat-navigation.ts)
