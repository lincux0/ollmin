# Ollmin 运行基准测试协议

> 状态：测试协议，不是已取得的性能结论。适用于当前 `1.1.1` 的本机 Ollama 客户端；结果必须与设备、Ollama 版本、模型 digest 和运行状态一同保存。

## 目标

在同一台设备、同一 Ollama 模型和同一提示词下，区分以下耗时来源：

- 模型加载（`load_duration`）；
- 提示词预填充（`prompt_eval_duration`）；
- 思考 token；
- 正文生成（`eval_duration`、`eval_count`）；
- 客户端额外的首字等待或后台请求。

该协议不比较不同模型、不同量化或不同上下文下的绝对速度，也不把 GUI 的动画速度当成模型速度。

## 固定条件

记录以下信息，但报告中不要写入提示词正文：

| 项目 | 值 |
| --- | --- |
| 操作系统 | Windows 版本 |
| Ollama 版本 | `ollama --version` |
| 模型完整名称与 digest | `ollama list` / `/api/tags` |
| 量化与参数规模 | 模型详情 |
| 处理器卸载比例 | `ollama ps` 的 `PROCESSOR` |
| 上下文 | `num_ctx` 与服务默认值 |
| 并发 | 只运行一个前台请求 |
| 提示词 | 使用固定短提示词，报告只保存标签 |

测试前关闭其他会使用 Ollama 的客户端。不要为了制造“冷启动”而自动执行 `ollama stop`，以免中断用户的其他任务；第一条请求标记为“首次请求”，实际状态以 `/api/ps` 记录为准。

## 四组测试

每组至少运行 3 次，取中位数和 P95。固定请求使用 `stream: false`，这样能读取完整的 Ollama 统计字段。

### A. 首次请求

启动 Ollama 后确认模型未必常驻，运行一条短提示词。记录 `load_duration`；不能把第一条请求必然称为冷启动。

### B. 预热后的快速模式

先用 Ollmin 的“预热并常驻”，再连续运行同一提示词，设置 `think: false`、`num_ctx: 4096`、`num_predict: 768`。

### C. 预热后的思考模式

保持模型和提示词不变，只把 `think` 改为 `true`。记录思考字段是否出现、输出 token 是否增加以及总耗时变化。

### D. 长历史提示

将 4–6 轮固定的用户/助手文本放入 `messages`，在最后追加相同问题；保持 `think: false`。比较 `prompt_eval_count` 和 `prompt_eval_duration` 与 B 组的变化。

## 原生 API 参考请求

```powershell
$body = @{
  model = "qwen3:4b"
  messages = @(@{ role = "user"; content = "请用一句话介绍你自己。" })
  stream = $false
  think = $false
  keep_alive = "30m"
  options = @{
    num_ctx = 4096
    num_predict = 768
    temperature = 0.7
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Uri http://127.0.0.1:11434/api/chat `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

正式测试应使用 `scripts/benchmark.ps1`，它只保存统计字段与提示词标签，不保存提示词正文或模型回答。

## 必须记录的字段

从 API 响应读取：

- `total_duration`；
- `load_duration`；
- `prompt_eval_count`、`prompt_eval_duration`；
- `eval_count`、`eval_duration`；
- `message.thinking` 是否存在及字符数；
- Ollmin 本地测得的端到端耗时。

换算公式：

```text
毫秒 = 纳秒 / 1,000,000
生成 tok/s = eval_count / (eval_duration / 1,000,000,000)
```

## 客户端对照

对 Chatbox、WorkBuddy 只在能够固定以下条件时纳入对照：模型名、思考开关、上下文上限、最大输出、历史条数、系统提示词、是否启用自动标题/工具。若无法固定，报告标记为“不可公平比较”，不作速度结论。

| 客户端 | 模型 | 思考 | 上下文 | 输出上限 | 后台调用 | TTFT | 总耗时 | tok/s | 备注 |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| CLI |  |  |  |  |  |  |  |  |  |
| 原生 API |  |  |  |  |  |  |  |  |  |
| Ollmin |  |  |  |  |  |  |  |  |  |
| Chatbox/WorkBuddy |  |  |  |  |  |  |  |  |  |

## 协议通过标准

1. 能从 Ollmin 界面完成模型检测、已加载状态刷新、预热和单次诊断；
2. 快速模式明确发送 `think: false`，思考模式明确发送 `think: true`；
3. 能区分加载、提示词预填充、思考和正文生成四类主要成本；
4. 空闲时没有自动生成请求；
5. 生成一份不包含提示词正文的 Markdown 基准报告；
6. 在模型已预热、请求等价的条件下，Ollmin 的客户端额外首字开销目标不超过 150 ms。
