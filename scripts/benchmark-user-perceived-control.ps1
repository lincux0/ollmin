[CmdletBinding()]
param(
  [string]$Model,
  [string]$Prompt = "请用约八十字介绍春天的公园，只输出正文。",
  [ValidateRange(3, 10)][int]$Runs = 4,
  [string]$OutputDirectory = "benchmarks"
)

$ErrorActionPreference = "Stop"
$baseUri = "http://127.0.0.1:11434"
$profiles = @(
  [PSCustomObject]@{ Key = "fast"; Label = "快速"; Think = $false; NumCtx = 4096; NumPredict = 768 },
  [PSCustomObject]@{ Key = "balanced"; Label = "平衡"; Think = $true; NumCtx = 4096; NumPredict = 768 },
  [PSCustomObject]@{ Key = "reasoning"; Label = "推理"; Think = $true; NumCtx = 8192; NumPredict = 2048 }
)

function Convert-DurationToMs {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return $null }
  return [math]::Round([double]$Value / 1e6, 1)
}

function Get-MetricMs {
  param([Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)][string]$Name)
  $prefixGuard = if ($Name -like "eval *") { "(?<!prompt )" } else { "" }
  $match = [regex]::Match($Text, "(?i)$prefixGuard$([regex]::Escape($Name)):\s*([0-9.]+)\s*(ms|s)\b")
  if (-not $match.Success) { return $null }
  $value = [double]$match.Groups[1].Value
  if ($match.Groups[2].Value -ieq "s") { $value *= 1000 }
  return [math]::Round($value, 1)
}

function Get-MetricNumber {
  param([Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)][string]$Name)
  $prefixGuard = if ($Name -like "eval *") { "(?<!prompt )" } else { "" }
  $match = [regex]::Match($Text, "(?i)$prefixGuard$([regex]::Escape($Name)):\s*([0-9.]+)")
  if (-not $match.Success) { return $null }
  return [double]$match.Groups[1].Value
}

function Remove-AnsiEscapeCodes {
  param([Parameter(Mandatory = $true)][string]$Text)
  $escape = [string][char]27
  return [regex]::Replace($Text, "$escape\[[0-?]*[ -/]*[@-~]", "")
}

function Invoke-ApiCase {
  param([Parameter(Mandatory = $true)][object]$Profile, [Parameter(Mandatory = $true)][string]$Case)

  $payload = @{
    model = $Model
    messages = @(@{ role = "user"; content = $Prompt })
    stream = $true
    think = $Profile.Think
    keep_alive = "30m"
    options = @{
      num_ctx = $Profile.NumCtx
      num_predict = $Profile.NumPredict
      temperature = 0
    }
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 8 -Compress))
  $request = [Net.HttpWebRequest]::Create("$baseUri/api/chat")
  $request.Method = "POST"
  $request.ContentType = "application/json"
  $request.ContentLength = $bytes.Length
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $requestStream = $request.GetRequestStream()
  $requestStream.Write($bytes, 0, $bytes.Length)
  $requestStream.Dispose()
  $response = $request.GetResponse()
  $reader = [IO.StreamReader]::new($response.GetResponseStream(), [Text.Encoding]::UTF8)
  $firstChunkMs = $null
  $chunkCount = 0
  $thinkingChars = 0
  $done = $null
  while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($null -eq $firstChunkMs) { $firstChunkMs = [math]::Round($clock.Elapsed.TotalMilliseconds, 1) }
    $chunk = $line | ConvertFrom-Json
    $chunkCount++
    if ($chunk.message -and $null -ne $chunk.message.thinking) {
      $thinkingChars += ([string]$chunk.message.thinking).Length
    }
    if ($chunk.done) { $done = $chunk }
  }
  $reader.Dispose(); $response.Dispose(); $clock.Stop()
  $evalSeconds = if ($done -and $done.eval_duration) { [double]$done.eval_duration / 1e9 } else { $null }
  [PSCustomObject]@{
    Client = "等价 API"; Mode = $Profile.Label; ModeKey = $Profile.Key; Case = $Case
    WallMs = [math]::Round($clock.Elapsed.TotalMilliseconds, 1)
    FirstChunkMs = $firstChunkMs
    TotalMs = if ($done) { Convert-DurationToMs $done.total_duration } else { $null }
    LoadMs = if ($done) { Convert-DurationToMs $done.load_duration } else { $null }
    PromptMs = if ($done) { Convert-DurationToMs $done.prompt_eval_duration } else { $null }
    PromptTokens = if ($done) { $done.prompt_eval_count } else { $null }
    OutputMs = if ($done) { Convert-DurationToMs $done.eval_duration } else { $null }
    OutputTokens = if ($done) { $done.eval_count } else { $null }
    OutputTokPerSecond = if ($null -ne $evalSeconds -and $evalSeconds -gt 0) { [math]::Round([double]$done.eval_count / $evalSeconds, 2) } else { $null }
    ThinkingCharacters = $thinkingChars; ChunkCount = $chunkCount; Order = $null
  }
}

function Invoke-CliCase {
  param([Parameter(Mandatory = $true)][object]$Profile, [Parameter(Mandatory = $true)][string]$CliModel, [Parameter(Mandatory = $true)][string]$Case)

  $ollamaPath = (Get-Command ollama -ErrorAction Stop).Source
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $ollamaPath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  # Ollmin keeps the thinking block visible while streaming; leave CLI thinking
  # visible as well so first-output timing has the same presentation policy.
  foreach ($arg in @("run", $CliModel, "--think=$($Profile.Think.ToString().ToLowerInvariant())", "--keepalive", "30m", "--verbose", "--nowordwrap", $Prompt)) {
    [void]$startInfo.ArgumentList.Add($arg)
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $clock = [Diagnostics.Stopwatch]::StartNew()
  [void]$process.Start()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $stdout = [Text.StringBuilder]::new()
  $firstOutputMs = $null
  while (($value = $process.StandardOutput.Read()) -ge 0) {
    if ($null -eq $firstOutputMs) { $firstOutputMs = [math]::Round($clock.Elapsed.TotalMilliseconds, 1) }
    [void]$stdout.Append([char]$value)
  }
  $process.WaitForExit()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $clock.Stop()
  $text = Remove-AnsiEscapeCodes -Text (([string]$stdout) + "`n" + $stderr)
  $evalMs = Get-MetricMs -Text $text -Name "eval duration"
  $evalSeconds = if ($null -ne $evalMs -and $evalMs -gt 0) { $evalMs / 1000 } else { $null }
  $outputTokens = Get-MetricNumber -Text $text -Name "eval count"
  [PSCustomObject]@{
    Client = "ollama CLI"; Mode = $Profile.Label; ModeKey = $Profile.Key; Case = $Case
    WallMs = [math]::Round($clock.Elapsed.TotalMilliseconds, 1)
    FirstChunkMs = $firstOutputMs
    TotalMs = Get-MetricMs -Text $text -Name "total duration"
    LoadMs = Get-MetricMs -Text $text -Name "load duration"
    PromptMs = Get-MetricMs -Text $text -Name "prompt eval duration"
    PromptTokens = Get-MetricNumber -Text $text -Name "prompt eval count"
    OutputMs = $evalMs; OutputTokens = $outputTokens
    OutputTokPerSecond = if ($null -ne $evalSeconds -and $null -ne $outputTokens) { [math]::Round($outputTokens / $evalSeconds, 2) } else { $null }
    ThinkingCharacters = $null; ChunkCount = $null; Order = $null
  }
}

function Get-Median {
  param([array]$Values)
  $items = @($Values | Where-Object { $null -ne $_ } | Sort-Object { [double]$_ })
  if ($items.Count -eq 0) { return $null }
  return [math]::Round([double]$items[[int][math]::Floor(($items.Count - 1) / 2)], 1)
}

function Get-P95 {
  param([array]$Values)
  $items = @($Values | Where-Object { $null -ne $_ } | Sort-Object { [double]$_ })
  if ($items.Count -eq 0) { return $null }
  $index = [math]::Ceiling($items.Count * 0.95) - 1
  return [math]::Round([double]$items[[math]::Max(0, [math]::Min($index, $items.Count - 1))], 1)
}

$createdCliModels = New-Object System.Collections.Generic.List[string]
$rows = New-Object System.Collections.Generic.List[object]
try {
  $version = Invoke-RestMethod -Uri "$baseUri/api/version"
  if ([string]::IsNullOrWhiteSpace($Model)) { $Model = ((Invoke-RestMethod -Uri "$baseUri/api/tags").models | Select-Object -First 1).name }
  if ([string]::IsNullOrWhiteSpace($Model)) { throw "没有找到本地模型。" }
  $stamp = Get-Date -Format "yyyyMMddHHmmss"
  $cliModels = @{}
  foreach ($profile in $profiles) {
    $cliModel = "ollmin-user-$($profile.Key)-$stamp"
    $modelfile = [IO.Path]::GetTempFileName()
    try {
      Set-Content -LiteralPath $modelfile -Encoding UTF8 -Value @(
        "FROM $Model",
        "PARAMETER num_ctx $($profile.NumCtx)",
        "PARAMETER num_predict $($profile.NumPredict)",
        "PARAMETER temperature 0"
      )
      & ollama create $cliModel -f $modelfile | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "创建 CLI 模型失败：$cliModel" }
      $cliModels[$profile.Key] = $cliModel
      $createdCliModels.Add($cliModel)
    } finally {
      if (Test-Path -LiteralPath $modelfile) { Remove-Item -LiteralPath $modelfile -Force }
    }
  }

  foreach ($profile in $profiles) {
    Write-Host "预热 $($profile.Label)：API -> CLI"
    [void](Invoke-ApiCase -Profile $profile -Case "warmup")
    [void](Invoke-CliCase -Profile $profile -CliModel $cliModels[$profile.Key] -Case "warmup")
    for ($run = 1; $run -le $Runs; $run++) {
      $sequence = if ($run % 2 -eq 1) { @("api", "cli") } else { @("cli", "api") }
      foreach ($client in $sequence) {
        $item = if ($client -eq "api") {
          Invoke-ApiCase -Profile $profile -Case "measured-$run"
        } else {
          Invoke-CliCase -Profile $profile -CliModel $cliModels[$profile.Key] -Case "measured-$run"
        }
        $item.Order = "$($profile.Key)-$run-$client"
        $rows.Add($item)
        Write-Host ("{0} {1}/{2} {3}: wall={4} first={5} eval={6} tok/s={7}" -f $profile.Label,$run,$Runs,$item.Client,$item.WallMs,$item.FirstChunkMs,$item.OutputMs,$item.OutputTokPerSecond)
      }
    }
  }

  $summary = @($rows | Group-Object Client,ModeKey | ForEach-Object {
    $first = $_.Group[0]
    [PSCustomObject]@{
      Client = $first.Client; Mode = $first.Mode; Runs = $_.Count
      WallMedianMs = Get-Median @($_.Group | ForEach-Object WallMs)
      WallP95Ms = Get-P95 @($_.Group | ForEach-Object WallMs)
      FirstMedianMs = Get-Median @($_.Group | ForEach-Object FirstChunkMs)
      TotalMedianMs = Get-Median @($_.Group | ForEach-Object TotalMs)
      PromptMedianMs = Get-Median @($_.Group | ForEach-Object PromptMs)
      PromptTokensMedian = Get-Median @($_.Group | ForEach-Object PromptTokens)
      OutputMedianMs = Get-Median @($_.Group | ForEach-Object OutputMs)
      OutputTokensMedian = Get-Median @($_.Group | ForEach-Object OutputTokens)
      TokPerSecondMedian = Get-Median @($_.Group | ForEach-Object OutputTokPerSecond)
    }
  })
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  $outputPath = Join-Path $OutputDirectory ("user-perceived-control-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".md")
  $summaryRows = ($summary | ForEach-Object { "| $($_.Client) | $($_.Mode) | $($_.Runs) | $($_.WallMedianMs) | $($_.WallP95Ms) | $($_.FirstMedianMs) | $($_.TotalMedianMs) | $($_.PromptMedianMs) | $($_.PromptTokensMedian) | $($_.OutputMedianMs) | $($_.OutputTokensMedian) | $($_.TokPerSecondMedian) |" }) -join [Environment]::NewLine
  $rawRows = ($rows | ForEach-Object { "| $($_.Client) | $($_.Mode) | $($_.Case) | $($_.Order) | $($_.WallMs) | $($_.FirstChunkMs) | $($_.TotalMs) | $($_.LoadMs) | $($_.PromptMs) | $($_.PromptTokens) | $($_.OutputMs) | $($_.OutputTokens) | $($_.OutputTokPerSecond) | $($_.ThinkingCharacters) | $($_.ChunkCount) |" }) -join [Environment]::NewLine
  $report = @(
    "# Ollmin 用户感知控制组测试",
    "",
    "> 生成时间：$(Get-Date -Format o)。报告不保存提示词正文或模型回答。",
    "",
    "- Ollama：$($version.version)",
    "- 模型：$Model",
    "- 参数：temperature=0；快速 think=false/ctx=4096/predict=768；平衡 think=true/ctx=4096/predict=768；推理 think=true/ctx=8192/predict=2048。",
    "- 每档：预热 API 与 CLI 各 1 次，正式测量 $Runs 对交替样本。奇数轮 API→CLI，偶数轮 CLI→API。",
    "- 本报告的 API 是 Ollmin 等价流式控制组，不包含 Tauri 窗口、WebView 绘制或 React 更新。",
    "",
    "## 中位数与 P95",
    "",
    "| 客户端路径 | 模式 | 有效次数 | 端到端中位数 ms | 端到端 P95 ms | 首个输出中位数 ms | Ollama total 中位数 ms | 预填充中位数 ms | 输入 token 中位数 | 解码中位数 ms | 输出 token 中位数 | 输出 tok/s 中位数 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    $summaryRows,
    "",
    "## 原始测量",
    "",
    "| 客户端路径 | 模式 | 轮次 | 交替顺序 | 端到端 ms | 首个输出 ms | Ollama total ms | 加载 ms | 预填充 ms | 输入 token | 解码 ms | 输出 token | 输出 tok/s | 思考字符 | 流块数 |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    $rawRows,
    "",
    "## 限制",
    "",
    "- 真实 Ollmin GUI 未能在当前执行环境中获得可交互的桌面窗口句柄，因此没有伪造 T1/T2/T3/T4/T5，也没有把 API 控制组冒充 GUI 结果。",
    "- CLI 首个输出时间是进程标准输出首字节；API 首个输出时间是首个 NDJSON 分片，不等同于真实 Ollmin 首个可见字符。",
    "- 如需完成完整方案，需在有可见桌面的用户会话中运行 Ollmin Release，并按 user-perceived-benchmark-plan.md 采集录像或前端绘制时间。"
  ) -join [Environment]::NewLine
  Set-Content -LiteralPath $outputPath -Value $report -Encoding UTF8
  Write-Output "Generated $outputPath"
}
finally {
  foreach ($cliModel in $createdCliModels) { & ollama rm $cliModel | Out-Null }
}
