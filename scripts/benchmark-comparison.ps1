[CmdletBinding()]
param(
  [string]$Model,
  [string]$Prompt = "请写一段约八十字的中文短文，主题是春天的公园。只输出正文，不要标题或解释。",
  [string]$PromptLabel = "固定短文提示词",
  [ValidateRange(3, 20)][int]$Runs = 3,
  [string]$OutputDirectory = "benchmarks",
  [switch]$SkipApi,
  [switch]$SkipCli
)

$ErrorActionPreference = "Stop"
$baseUri = "http://127.0.0.1:11434"

$profiles = @(
  [PSCustomObject]@{
    Key = "fast"; Label = "快速"; Think = $false; NumCtx = 4096; NumPredict = 384
  },
  [PSCustomObject]@{
    Key = "balanced"; Label = "平衡"; Think = $true; NumCtx = 4096; NumPredict = 768
  },
  [PSCustomObject]@{
    Key = "reasoning"; Label = "推理"; Think = $true; NumCtx = 8192; NumPredict = 2048
  }
)

function Get-ApiJson {
  param([Parameter(Mandatory = $true)][string]$Path)
  Invoke-RestMethod -Uri "$baseUri$Path" -Method Get
}

function Convert-DurationToMs {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return $null }
  return [math]::Round([double]$Value / 1e6, 1)
}

function Invoke-StreamingApiCase {
  param(
    [Parameter(Mandatory = $true)][object]$Profile,
    [Parameter(Mandatory = $true)][string]$CaseLabel
  )

  $payload = @{
    model = $Model
    messages = @(@{ role = "user"; content = $Prompt })
    stream = $true
    think = $Profile.Think
    keep_alive = "30m"
    options = @{
      num_ctx = $Profile.NumCtx
      num_predict = $Profile.NumPredict
      temperature = 0.7
    }
  }
  $json = $payload | ConvertTo-Json -Depth 8 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $request = [System.Net.HttpWebRequest]::Create("$baseUri/api/chat")
  $request.Method = "POST"
  $request.ContentType = "application/json"
  $request.ContentLength = $bytes.Length

  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $requestStream = $request.GetRequestStream()
  $requestStream.Write($bytes, 0, $bytes.Length)
  $requestStream.Dispose()
  $response = $request.GetResponse()
  $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
  $firstChunkMs = $null
  $chunkCount = 0
  $thinkingChars = 0
  $contentChars = 0
  $done = $null

  while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($null -eq $firstChunkMs) {
      $firstChunkMs = [math]::Round($clock.Elapsed.TotalMilliseconds, 1)
    }
    $chunk = $line | ConvertFrom-Json
    $chunkCount++
    if ($chunk.message) {
      if ($null -ne $chunk.message.thinking) {
        $thinkingChars += ([string]$chunk.message.thinking).Length
      }
      if ($null -ne $chunk.message.content) {
        $contentChars += ([string]$chunk.message.content).Length
      }
    }
    if ($chunk.done) { $done = $chunk }
  }
  $reader.Dispose()
  $response.Dispose()
  $clock.Stop()

  $evalSeconds = if ($done -and $done.eval_duration) { [double]$done.eval_duration / 1e9 } else { $null }
  [PSCustomObject]@{
    Client = "Ollmin 等价 API"
    Mode = $Profile.Label
    ModeKey = $Profile.Key
    Case = $CaseLabel
    Run = $null
    WallMs = [math]::Round($clock.Elapsed.TotalMilliseconds, 1)
    TotalMs = if ($done) { Convert-DurationToMs $done.total_duration } else { $null }
    LoadMs = if ($done) { Convert-DurationToMs $done.load_duration } else { $null }
    PromptMs = if ($done) { Convert-DurationToMs $done.prompt_eval_duration } else { $null }
    PromptTokens = if ($done) { $done.prompt_eval_count } else { $null }
    OutputMs = if ($done) { Convert-DurationToMs $done.eval_duration } else { $null }
    OutputTokens = if ($done) { $done.eval_count } else { $null }
    OutputTokPerSecond = if ($null -ne $evalSeconds -and $evalSeconds -gt 0) { [math]::Round([double]$done.eval_count / $evalSeconds, 2) } else { $null }
    ThinkingCharacters = $thinkingChars
    ContentCharacters = $contentChars
    FirstChunkMs = $firstChunkMs
    ChunkCount = $chunkCount
    NumCtx = $Profile.NumCtx
    NumPredict = $Profile.NumPredict
    Think = $Profile.Think
  }
}

function Get-CliMetricMs {
  param([Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)][string]$Name)
  $prefixGuard = if ($Name -like "eval *") { "(?<!prompt )" } else { "" }
  $match = [regex]::Match($Text, "(?i)$prefixGuard$([regex]::Escape($Name)):\s*([0-9.]+)\s*(ms|s)\b")
  if (-not $match.Success) { return $null }
  $value = [double]$match.Groups[1].Value
  if ($match.Groups[2].Value -ieq "s") { $value *= 1000 }
  return [math]::Round($value, 1)
}

function Get-CliMetricNumber {
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

function Invoke-CliCase {
  param(
    [Parameter(Mandatory = $true)][object]$Profile,
    [Parameter(Mandatory = $true)][string]$CaseLabel,
    [Parameter(Mandatory = $true)][string]$CliModel
  )

  $thinkArg = if ($Profile.Think) { "--think=true" } else { "--think=false" }
  $arguments = @("run", $CliModel, $thinkArg, "--keepalive", "30m", "--verbose", "--hidethinking", "--nowordwrap", $Prompt)

  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $output = @(& ollama @arguments 2>&1)
  $clock.Stop()
  $text = Remove-AnsiEscapeCodes -Text (($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
  $text = $text -replace "`r", "`n"
  $evalMs = Get-CliMetricMs -Text $text -Name "eval duration"
  $evalSeconds = if ($null -ne $evalMs -and $evalMs -gt 0) { $evalMs / 1000 } else { $null }
  $outputTokens = Get-CliMetricNumber -Text $text -Name "eval count"

  [PSCustomObject]@{
    Client = "ollama CLI"
    Mode = $Profile.Label
    ModeKey = $Profile.Key
    Case = $CaseLabel
    Run = $null
    WallMs = [math]::Round($clock.Elapsed.TotalMilliseconds, 1)
    TotalMs = Get-CliMetricMs -Text $text -Name "total duration"
    LoadMs = Get-CliMetricMs -Text $text -Name "load duration"
    PromptMs = Get-CliMetricMs -Text $text -Name "prompt eval duration"
    PromptTokens = Get-CliMetricNumber -Text $text -Name "prompt eval count"
    OutputMs = $evalMs
    OutputTokens = $outputTokens
    OutputTokPerSecond = if ($null -ne $evalSeconds -and $evalSeconds -gt 0) { [math]::Round($outputTokens / $evalSeconds, 2) } else { $null }
    ThinkingCharacters = $null
    ContentCharacters = $null
    FirstChunkMs = $null
    ChunkCount = $null
    NumCtx = $Profile.NumCtx
    NumPredict = $Profile.NumPredict
    Think = $Profile.Think
  }
}

function Get-Percentile {
  param([AllowNull()][array]$Values, [Parameter(Mandatory = $true)][double]$Percent)
  if ($null -eq $Values) { return $null }
  $sorted = @($Values | Where-Object { $null -ne $_ } | Sort-Object { [double]$_ })
  if ($sorted.Count -eq 0) { return $null }
  $index = [math]::Ceiling(($Percent / 100) * $sorted.Count) - 1
  $index = [math]::Max(0, [math]::Min($index, $sorted.Count - 1))
  return [math]::Round([double]$sorted[$index], 1)
}

function Add-Summary {
  param([Parameter(Mandatory = $true)][array]$Rows)
  $groups = $Rows | Group-Object Client, ModeKey
  foreach ($group in $groups) {
    $items = @($group.Group)
    $first = $items[0]
    [PSCustomObject]@{
      Client = $first.Client
      Mode = $first.Mode
      ModeKey = $first.ModeKey
      Runs = $items.Count
      WallMedianMs = Get-Percentile -Values @($items | ForEach-Object WallMs) -Percent 50
      WallP95Ms = Get-Percentile -Values @($items | ForEach-Object WallMs) -Percent 95
      TotalMedianMs = Get-Percentile -Values @($items | ForEach-Object TotalMs) -Percent 50
      LoadMedianMs = Get-Percentile -Values @($items | ForEach-Object LoadMs) -Percent 50
      PromptMedianMs = Get-Percentile -Values @($items | ForEach-Object PromptMs) -Percent 50
      PromptTokensMedian = Get-Percentile -Values @($items | ForEach-Object PromptTokens) -Percent 50
      OutputMedianMs = Get-Percentile -Values @($items | ForEach-Object OutputMs) -Percent 50
      OutputTokensMedian = Get-Percentile -Values @($items | ForEach-Object OutputTokens) -Percent 50
      OutputTokPerSecondMedian = Get-Percentile -Values @($items | ForEach-Object OutputTokPerSecond) -Percent 50
      FirstChunkMedianMs = Get-Percentile -Values @($items | ForEach-Object FirstChunkMs) -Percent 50
      ThinkingCharactersMedian = Get-Percentile -Values @($items | ForEach-Object ThinkingCharacters) -Percent 50
    }
  }
}

try {
  $version = Get-ApiJson -Path "/api/version"
  $tags = Get-ApiJson -Path "/api/tags"
  $psBefore = Get-ApiJson -Path "/api/ps"
  if ([string]::IsNullOrWhiteSpace($Model)) {
    $Model = $tags.models[0].name
  }
  if ([string]::IsNullOrWhiteSpace($Model)) {
    throw "没有找到本地模型。"
  }

  $rows = New-Object System.Collections.Generic.List[object]
  $createdCliModels = New-Object System.Collections.Generic.List[string]
  if (-not $SkipApi) {
    foreach ($profile in $profiles) {
      Write-Host "预热 Ollmin 等价 API：$($profile.Label)"
      [void](Invoke-StreamingApiCase -Profile $profile -CaseLabel "warmup")
      for ($run = 1; $run -le $Runs; $run++) {
        Write-Host "Ollmin 等价 API $($profile.Label) 第 $run/$Runs 次"
        $item = Invoke-StreamingApiCase -Profile $profile -CaseLabel "measured"
        $item.Run = $run
        $rows.Add($item)
      }
    }
  }

  if (-not $SkipCli) {
    $cliModels = @{}
    $runStamp = Get-Date -Format "yyyyMMddHHmmss"
    foreach ($profile in $profiles) {
      $cliModel = "ollmin-bench-$($profile.Key)-$runStamp"
      $modelfile = [System.IO.Path]::GetTempFileName()
      try {
        Set-Content -LiteralPath $modelfile -Value @(
          "FROM $Model",
          "PARAMETER num_ctx $($profile.NumCtx)",
          "PARAMETER num_predict $($profile.NumPredict)",
          "PARAMETER temperature 0.7"
        ) -Encoding UTF8
        & ollama create $cliModel -f $modelfile | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "创建 CLI 临时模型失败：$cliModel" }
        $cliModels[$profile.Key] = $cliModel
        $createdCliModels.Add($cliModel)
      }
      finally {
        if (Test-Path -LiteralPath $modelfile) { Remove-Item -LiteralPath $modelfile -Force }
      }
    }

    foreach ($profile in $profiles) {
      $cliModel = $cliModels[$profile.Key]
      Write-Host "预热 ollama CLI：$($profile.Label)"
      [void](Invoke-CliCase -Profile $profile -CaseLabel "warmup" -CliModel $cliModel)
      for ($run = 1; $run -le $Runs; $run++) {
        Write-Host "ollama CLI $($profile.Label) 第 $run/$Runs 次"
        $item = Invoke-CliCase -Profile $profile -CaseLabel "measured" -CliModel $cliModel
        $item.Run = $run
        $rows.Add($item)
      }
    }

    foreach ($cliModel in $createdCliModels) {
      & ollama rm $cliModel | Out-Null
    }
  }

  $summary = @(Add-Summary -Rows $rows)
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $outputPath = Join-Path $OutputDirectory "comparison-$stamp.md"

  $summaryRows = ($summary | ForEach-Object {
    "| $($_.Client) | $($_.Mode) | $($_.Runs) | $($_.WallMedianMs) | $($_.WallP95Ms) | $($_.TotalMedianMs) | $($_.LoadMedianMs) | $($_.PromptMedianMs) | $($_.PromptTokensMedian) | $($_.OutputTokensMedian) | $($_.OutputTokPerSecondMedian) | $($_.FirstChunkMedianMs) | $($_.ThinkingCharactersMedian) |"
  }) -join [Environment]::NewLine

  $rawRows = ($rows | ForEach-Object {
    "| $($_.Client) | $($_.Mode) | $($_.Run) | $($_.WallMs) | $($_.TotalMs) | $($_.LoadMs) | $($_.PromptMs) | $($_.PromptTokens) | $($_.OutputMs) | $($_.OutputTokens) | $($_.OutputTokPerSecond) | $($_.FirstChunkMs) | $($_.ThinkingCharacters) | $($_.ChunkCount) |"
  }) -join [Environment]::NewLine

  $report = @(
    "# Ollmin 与 ollama CLI 性能对比",
    "",
    "> 生成时间：$(Get-Date -Format o)。报告不保存提示词正文或模型回答。",
    "",
    "- Ollama：$($version.version)",
    "- 模型：$Model",
    "- 提示词标签：$PromptLabel",
    "- 每个客户端/模式：预热 1 次，正式测量 $Runs 次；以下为正式测量结果。",
    "- 固定参数：temperature=0.7；快速 think=false/ctx=4096/predict=384；平衡 think=true/ctx=4096/predict=768；推理 think=true/ctx=8192/predict=2048。",
    "- 开始测试前 /api/ps 已加载模型数：$($psBefore.models.Count)。",
    "",
    "## 中位数与 P95",
    "",
    "| 客户端路径 | 模式 | 次数 | 端到端中位数 ms | 端到端 P95 ms | Ollama total 中位数 ms | 加载中位数 ms | 预填充中位数 ms | 输入 token 中位数 | 输出 token 中位数 | 输出 tok/s 中位数 | 首块中位数 ms | 思考字符中位数 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    $summaryRows,
    "",
    "## 原始测量",
    "",
    "| 客户端路径 | 模式 | 次数 | 端到端 ms | Ollama total ms | 加载 ms | 预填充 ms | 输入 token | 输出生成 ms | 输出 token | 输出 tok/s | 首块 ms | 思考字符 | 流块数 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    $rawRows,
    "",
    "## 解释",
    "",
    "- 端到端时间包含客户端启动/请求/接收开销；Ollama total 是服务端统计，两者应分开看。",
    "- Ollmin 等价 API 使用与 Rust 客户端相同的 /api/chat 流式请求字段，代表 Ollmin 请求路径；未把 GUI 绘制时间计入模型统计。",
    "- CLI 通过临时 Modelfile 固定相同的 num_ctx、num_predict 和 temperature，再启动新的 ollama run 进程；测试结束后删除临时模型别名。",
    "- 输出 tok/s 来自 Ollama eval_duration/eval_count，不受客户端界面渲染影响。",
    "- 如果 LoadMs 明显升高，应以 /api/ps 和该次 LoadMs 判断是否发生了模型重载，不应归因于客户端。"
  ) -join [Environment]::NewLine

  Set-Content -Path $outputPath -Value $report -Encoding UTF8
  Write-Output "Generated $outputPath"
}
catch {
  if ($createdCliModels) {
    foreach ($cliModel in $createdCliModels) {
      & ollama rm $cliModel | Out-Null
    }
  }
  Write-Error "性能对比失败：$($_.Exception.Message)"
  exit 1
}
