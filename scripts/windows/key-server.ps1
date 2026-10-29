# Long-running form of send-keys.ps1. Starting powershell.exe and compiling the
# Win32 bindings costs about two seconds, so the NVDA runner keeps one helper
# alive and sends one JSON command per line on stdin. Each reply is one JSON
# line on stdout. Every command repeats the same foreground and window guards.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class RamboKeyServer {
  public delegate bool EnumWindowCallback(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll")] public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
  public static string WindowTitle(IntPtr handle) {
    var text = new StringBuilder(GetWindowTextLength(handle) + 1);
    GetWindowText(handle, text, text.Capacity);
    return text.ToString();
  }
  public static bool IsTargetWindow(IntPtr handle, uint expectedProcessId, string marker) {
    if (handle == IntPtr.Zero || expectedProcessId == 0 || String.IsNullOrEmpty(marker) || !IsWindowVisible(handle)) return false;
    uint processId;
    GetWindowThreadProcessId(handle, out processId);
    if (processId != expectedProcessId) return false;
    var className = new StringBuilder(256);
    GetClassName(handle, className, className.Capacity);
    return className.ToString() == "Chrome_WidgetWin_1" && WindowTitle(handle).IndexOf(marker, StringComparison.Ordinal) >= 0;
  }
  public static IntPtr[] FindWindows(string marker, uint expectedProcessId) {
    var matches = new List<IntPtr>();
    EnumWindows(delegate(IntPtr handle, IntPtr unused) {
      if (IsTargetWindow(handle, expectedProcessId, marker)) matches.Add(handle);
      return true;
    }, IntPtr.Zero);
    return matches.ToArray();
  }
}
"@

$script:automationLoaded = $false
. (Join-Path $PSScriptRoot "focus-anchor.ps1")

function Send-RamboKey([byte]$VirtualKey) {
  [RamboKeyServer]::keybd_event($VirtualKey, 0, 0, [UIntPtr]::Zero)
  [RamboKeyServer]::keybd_event($VirtualKey, 0, 2, [UIntPtr]::Zero)
}

function Get-ForegroundProcessId {
  $foreground = [RamboKeyServer]::GetForegroundWindow()
  $foregroundProcessId = [uint32]0
  [void][RamboKeyServer]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
  return @{ Handle = $foreground; ProcessId = $foregroundProcessId }
}

function Test-RamboForeground([IntPtr]$Handle, [uint32]$ProcessId, [string]$WindowTitle) {
  $current = Get-ForegroundProcessId
  return ($current.Handle -eq $Handle -and $current.ProcessId -eq $ProcessId -and [RamboKeyServer]::IsTargetWindow($Handle, $ProcessId, $WindowTitle))
}

function Invoke-RamboCommand($Command) {
  if ($Command.op -eq "ping") { return @{ ok = $true } }
  if ($Command.op -eq "nvda-status") {
    # Read-only ownership check, scoped to the same interactive Windows session
    # as this helper. Never assume a failed/unknown query means NVDA is stopped.
    $agentSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $readers = @(Get-Process -Name nvda -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $agentSessionId })
    return @{ ok = $true; running = ($readers.Count -gt 0) }
  }
  if ($Command.op -notin @("tab", "prepare", "anchor", "scope")) {
    return @{ ok = $false; reason = "The guarded native keyboard helper received an unsupported command." }
  }
  $expectedProcessId = [int]$Command.processId
  $windowTitle = [string]$Command.windowTitle
  $delayMs = [Math]::Max(50, [int]$Command.delayMs)
  $browserWindows = @([RamboKeyServer]::FindWindows($windowTitle, [uint32]$expectedProcessId))
  # Chromium updates its native caption asynchronously after document.title.
  # Wait read-only for the exact marker; never focus a window by PID alone.
  if ($Command.op -eq "anchor") {
    for ($captionAttempt = 0; $captionAttempt -lt 20 -and $browserWindows.Count -eq 0; $captionAttempt++) {
      if ((Get-ForegroundProcessId).ProcessId -ne $expectedProcessId) { break }
      Start-Sleep -Milliseconds 100
      $browserWindows = @([RamboKeyServer]::FindWindows($windowTitle, [uint32]$expectedProcessId))
    }
  }
  if ($browserWindows.Count -ne 1) {
    return @{ ok = $false; reason = "Expected one dedicated headed Chrome window for PID $expectedProcessId and title marker '$windowTitle'; found $($browserWindows.Count). The key was not sent." }
  }
  $browserHandle = [IntPtr]$browserWindows[0]
  # Live preparation already owns foreground before NVDA launch. If it was lost
  # during initialization, fail the guard instead of grabbing focus back.
  $livePreparation = ($Command.op -eq "prepare" -and $windowTitle.StartsWith("RAMBO NVDA prepare "))
  $preserveState = ($Command.op -in @("anchor", "scope") -or ($Command.op -eq "tab" -and $Command.preserveState -eq $true) -or $livePreparation)

  if (-not $preserveState) {
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
      if (-not [RamboKeyServer]::IsTargetWindow($browserHandle, [uint32]$expectedProcessId, $windowTitle)) { break }
      Send-RamboKey 0x12
      [void][RamboKeyServer]::ShowWindowAsync($browserHandle, 3)
      [void][RamboKeyServer]::BringWindowToTop($browserHandle)
      [void][RamboKeyServer]::SetForegroundWindow($browserHandle)
      [RamboKeyServer]::SwitchToThisWindow($browserHandle, $true)
      Start-Sleep -Milliseconds 125
      if (Test-RamboForeground $browserHandle $expectedProcessId $windowTitle) { break }
    }
  }

  if (-not (Test-RamboForeground $browserHandle $expectedProcessId $windowTitle)) {
    $current = Get-ForegroundProcessId
    return @{ ok = $false; reason = "The dedicated headed browser webpage could not be focused safely; the key was not sent. Expected PID $expectedProcessId and title marker '$windowTitle'; found PID $($current.ProcessId) and title '$([RamboKeyServer]::WindowTitle($current.Handle))'." }
  }

  if ($Command.op -eq "scope") {
    return Get-RamboDocumentFocus $browserHandle { Test-RamboForeground $browserHandle $expectedProcessId $windowTitle }
  }
  if ($Command.op -eq "anchor") {
    return Set-RamboDocumentAnchorFocus $browserHandle { Test-RamboForeground $browserHandle $expectedProcessId $windowTitle }
  }

  if ($Command.op -eq "prepare") {
    # During live startup this marker exists only in the agent's synthetic blank
    # document. Use real Windows accessibility focus instead of an F6 pane order.
    if ($windowTitle.StartsWith("RAMBO NVDA prepare ")) {
      if (-not $script:automationLoaded) {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $script:automationLoaded = $true
      }
      $automationRoot = [System.Windows.Automation.AutomationElement]::FromHandle($browserHandle)
      $prepareCondition = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Prepare document focus")),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))
      )
      $prepareControl = $null
      for ($readyAttempt = 0; $readyAttempt -lt 30; $readyAttempt++) {
        if (-not (Test-RamboForeground $browserHandle $expectedProcessId $windowTitle)) { return @{ ok = $false; reason = "Browser focus was lost; preparation was canceled." } }
        $prepareControl = $automationRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $prepareCondition)
        if ($prepareControl) { break }
        Start-Sleep -Milliseconds 100
      }
      if (-not $prepareControl) { return @{ ok = $false; reason = "The synthetic preparation control was not exposed; no setup keys were sent." } }
      if (-not (Test-RamboForeground $browserHandle $expectedProcessId $windowTitle)) { return @{ ok = $false; reason = "Browser focus was lost; preparation was canceled." } }
      $prepareControl.SetFocus()
      Start-Sleep -Milliseconds 250
      return @{ ok = $true }
    }
    # Put Chromium in a known focus state, then use its focus-pane command to
    # enter web content before tabbing. This avoids toolbar traversal.
    [RamboKeyServer]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    Send-RamboKey 0x4C
    [RamboKeyServer]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 125
    if (-not (Test-RamboForeground $browserHandle $expectedProcessId $windowTitle)) { return @{ ok = $false; reason = "Browser focus was lost; remaining keys were not sent." } }
    Send-RamboKey 0x75
    Start-Sleep -Milliseconds 125
    if (-not (Test-RamboForeground $browserHandle $expectedProcessId $windowTitle)) { return @{ ok = $false; reason = "Browser focus was lost; remaining keys were not sent." } }
    Send-RamboKey 0x75
    Start-Sleep -Milliseconds 250
    if (-not (Test-RamboForeground $browserHandle $expectedProcessId $windowTitle)) { return @{ ok = $false; reason = "Browser focus was lost; Tab was not sent." } }
  }

  # PreserveState sends only Tab: replay already established webpage focus, and
  # Alt/address-bar focus changes could close the menu being tested.
  Send-RamboKey 0x09
  Start-Sleep -Milliseconds $delayMs
  return @{ ok = $true }
}

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $command = $line | ConvertFrom-Json
    $id = $command.id
    if ($command.op -eq "exit") { break }
    $result = Invoke-RamboCommand $command
  } catch {
    $result = @{ ok = $false; reason = "The keyboard helper could not process the command: $($_.Exception.Message)" }
  }
  $result.id = $id
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
