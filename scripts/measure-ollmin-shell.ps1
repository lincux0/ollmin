[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ExecutablePath,
  [Parameter(Mandatory)][string]$OutputPath,
  [ValidateRange(1, 10)][int]$Repeats = 5,
  [ValidateRange(1, 30)][int]$IdleSeconds = 3,
  [switch]$TitlebarButtons,
  [switch]$ProcessTree
)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $ExecutablePath).Path
if ([IO.Path]::GetFileName($exe) -ne 'ollmin.exe') { throw 'Only ollmin.exe is accepted.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OllminShellProbe {
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
}
'@
if ($TitlebarButtons) { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes }
function Invoke-TitlebarButton([IntPtr]$Window, [string]$Name) {
  $root = [Windows.Automation.AutomationElement]::FromHandle($Window)
  $condition = [Windows.Automation.AndCondition]::new([Windows.Automation.Condition[]]@(
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name),
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
  ))
  $button = $null
  for ($retry = 0; $retry -lt 20; $retry++) {
    $button = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -ne $button) { break }
    Start-Sleep -Milliseconds 100
  }
  if ($null -eq $button) { throw "Native titlebar button not found: $Name" }
  $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Milliseconds 350
}
$runs = @()
function Measure-ProcessTree([int]$RootProcessId) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $ids = [Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootProcessId)
  do {
    $added = $false
    foreach ($entry in $all) {
      if ($ids.Contains([int]$entry.ParentProcessId) -and $ids.Add([int]$entry.ProcessId)) { $added = $true }
    }
  } while ($added)
  $bytes = 0L; $count = 0
  foreach ($processId in $ids) {
    $entry = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -ne $entry) { $bytes += $entry.PrivateMemorySize64; $count++ }
  }
  return @{ processCount = $count; privateBytes = $bytes }
}
for ($i = 0; $i -lt $Repeats; $i++) {
  $process = $null
  try {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath $exe -PassThru
    while ($timer.ElapsedMilliseconds -lt 20000) {
      $process.Refresh()
      if ($process.HasExited) { throw 'Ollmin exited before exposing a window.' }
      if ($process.MainWindowHandle -ne [IntPtr]::Zero) { break }
      Start-Sleep -Milliseconds 100
    }
    $window = $process.MainWindowHandle
    if ($window -eq [IntPtr]::Zero) { throw 'No Ollmin window within 20 seconds.' }
    $windowReadyMs = $timer.ElapsedMilliseconds
    Start-Sleep -Seconds $IdleSeconds
    $process.Refresh()
    $cpuStart = $process.TotalProcessorTime.TotalMilliseconds
    Start-Sleep -Seconds $IdleSeconds
    $process.Refresh()
    $privateBytes = $process.PrivateMemorySize64
    $idleCpuMs = $process.TotalProcessorTime.TotalMilliseconds - $cpuStart
    $tree = if ($ProcessTree) { Measure-ProcessTree $process.Id } else { $null }
    if ($ProcessTree -and $tree.processCount -lt 2) { throw 'WebView2 descendants not captured.' }
    if ($TitlebarButtons) { Invoke-TitlebarButton $window '最大化' }
    else { [void][OllminShellProbe]::SendMessage($window, 0x0112, [IntPtr]0xF030, [IntPtr]::Zero) }
    Start-Sleep -Milliseconds 250
    $maximized = [OllminShellProbe]::IsZoomed($window)
    if ($TitlebarButtons) { Invoke-TitlebarButton $window '还原' }
    else { [void][OllminShellProbe]::SendMessage($window, 0x0112, [IntPtr]0xF120, [IntPtr]::Zero) }
    Start-Sleep -Milliseconds 250
    $restored = -not [OllminShellProbe]::IsZoomed($window)
    if (-not ($maximized -and $restored)) { throw 'Native maximize/restore failed.' }
    $dpi = [OllminShellProbe]::GetDpiForWindow($window)
    if ($TitlebarButtons) {
      Invoke-TitlebarButton $window '最小化'
      if (-not [OllminShellProbe]::IsIconic($window)) { throw 'Native minimize button failed.' }
      [void][OllminShellProbe]::SendMessage($window, 0x0112, [IntPtr]0xF120, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 350
      Invoke-TitlebarButton $window '关闭'
      if (-not $process.WaitForExit(3000)) { throw 'Native close button failed.' }
    }
    $runs += [ordered]@{ windowReadyMs = $windowReadyMs; privateBytes = $privateBytes; idleCpuMs = $idleCpuMs; dpi = $dpi; maximizeRestore = $true; titlebarButtons = [bool]$TitlebarButtons; processTree = $tree }
  }
  finally {
    if ($null -ne $process) {
      $process.Refresh()
      if (-not $process.HasExited) {
        [void]$process.CloseMainWindow()
        if (-not $process.WaitForExit(3000)) { $process.Kill(); $process.WaitForExit() }
      }
      $process.Dispose()
    }
  }
}
$report = [ordered]@{
  capturedAt = [DateTime]::UtcNow.ToString('o'); executable = $exe
  sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
  idleSeconds = $IdleSeconds; runs = $runs
  scope = 'Main process only; window handle readiness is not first paint. By default tests system commands; TitlebarButtons uses native UI Automation Invoke for maximize/restore/minimize/close (no drag or pointer E2E). Reads current local settings; no chat submission, screenshots, or database edits.'
  processTreeScope = 'Optional private-byte snapshot of this exe and its current descendants, including WebView2. CPU delta remains main process only. No renderer paint/frame or GPU shared-memory measurement.'
}
$parent = Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding utf8
$report | ConvertTo-Json -Depth 5
