[CmdletBinding()]
param(
  [string]$Model,
  [string]$Prompt = "Introduce yourself in one sentence.",
  [string]$OutputDirectory = "benchmarks"
)

$ErrorActionPreference = "Stop"
$baseUri = "http://127.0.0.1:11434"

function Invoke-OllamaJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $false)][hashtable]$Body
  )

  $request = @{
    Uri = "$baseUri$Path"
    Method = "Post"
    ContentType = "application/json"
  }
  if ($null -ne $Body) {
    $request.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
  }
  Invoke-RestMethod @request
}

function Measure-Case {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][bool]$Think,
    [Parameter(Mandatory = $true)][array]$Messages
  )

  $body = @{
    model = $Model
    messages = $Messages
    stream = $false
    think = $Think
    keep_alive = "30m"
    options = @{
      num_ctx = 4096
      num_predict = 384
      temperature = 0.7
    }
  }
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $response = Invoke-OllamaJson -Path "/api/chat" -Body $body
  $clock.Stop()

  $evalSeconds = if ($response.eval_duration) { [double]$response.eval_duration / 1e9 } else { $null }
  $speed = if ($null -ne $evalSeconds -and $evalSeconds -gt 0) { [double]$response.eval_count / $evalSeconds } else { $null }
  [PSCustomObject]@{
    Label = $Label
    Think = $Think
    WallMs = [math]::Round($clock.Elapsed.TotalMilliseconds, 1)
    TotalMs = if ($response.total_duration) { [math]::Round([double]$response.total_duration / 1e6, 1) } else { $null }
    LoadMs = if ($response.load_duration) { [math]::Round([double]$response.load_duration / 1e6, 1) } else { $null }
    PromptMs = if ($response.prompt_eval_duration) { [math]::Round([double]$response.prompt_eval_duration / 1e6, 1) } else { $null }
    PromptTokens = $response.prompt_eval_count
    OutputMs = if ($response.eval_duration) { [math]::Round([double]$response.eval_duration / 1e6, 1) } else { $null }
    OutputTokens = $response.eval_count
    OutputTokPerSecond = if ($null -ne $speed) { [math]::Round($speed, 2) } else { $null }
    ThinkingCharacters = if ($response.message.thinking) { $response.message.thinking.Length } else { 0 }
  }
}

try {
  $version = Invoke-RestMethod -Uri "$baseUri/api/version" -Method Get
  $tags = Invoke-RestMethod -Uri "$baseUri/api/tags" -Method Get
  $loaded = Invoke-RestMethod -Uri "$baseUri/api/ps" -Method Get
  if ([string]::IsNullOrWhiteSpace($Model)) {
    $Model = $tags.models[0].name
  }
  if ([string]::IsNullOrWhiteSpace($Model)) {
    throw "No local model found. Run ollama pull first."
  }

  $shortMessages = @(@{ role = "user"; content = $Prompt })
  $longMessages = @(
    @{ role = "user"; content = "Remember the first benchmark context item." },
    @{ role = "assistant"; content = "The first item is recorded." },
    @{ role = "user"; content = "Remember the second benchmark context item." },
    @{ role = "assistant"; content = "The second item is recorded." },
    @{ role = "user"; content = "Remember the third benchmark context item." },
    @{ role = "assistant"; content = "The third item is recorded." },
    @{ role = "user"; content = $Prompt }
  )

  $cases = @(
    (Measure-Case -Label "First request (see /api/ps)" -Think $false -Messages $shortMessages),
    (Measure-Case -Label "Warm fast mode" -Think $false -Messages $shortMessages),
    (Measure-Case -Label "Warm thinking mode" -Think $true -Messages $shortMessages),
    (Measure-Case -Label "Long history fast mode" -Think $false -Messages $longMessages)
  )

  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $outputPath = Join-Path $OutputDirectory "benchmark-$stamp.md"
  $rows = ($cases | ForEach-Object {
    "| $($_.Label) | $($_.Think) | $($_.WallMs) | $($_.TotalMs) | $($_.LoadMs) | $($_.PromptMs) | $($_.PromptTokens) | $($_.OutputTokens) | $($_.OutputTokPerSecond) | $($_.ThinkingCharacters) |"
  }) -join [Environment]::NewLine
  $report = @(
    "# Ollmin Stage 0 Benchmark Report",
    "",
    "> Generated at $(Get-Date -Format o). The report contains no prompt or answer text.",
    "",
    "- Ollama: $($version.version)",
    "- Model: $Model",
    "- Loaded model count at start: $($loaded.models.Count)",
    "- Prompt label: $($Prompt.Substring(0, [math]::Min(32, $Prompt.Length)))",
    "",
    "| Case | Think | Wall ms | API total ms | Load ms | Prompt ms | Input tokens | Output tokens | Output tok/s | Thinking chars |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    $rows,
    "",
    "## Interpretation",
    "",
    "- High LoadMs: the model may not have been resident or may have reloaded.",
    "- Rising PromptMs/PromptTokens with history indicates context overhead.",
    "- More ThinkingCharacters and higher total time indicate thinking-token cost.",
    "- Compare Ollmin and native API only with identical requests and warm state."
  ) -join [Environment]::NewLine
  Set-Content -Path $outputPath -Value $report -Encoding UTF8
  Write-Output "Generated $outputPath"
}
catch {
  Write-Error "Benchmark failed: $($_.Exception.Message)"
  exit 1
}
