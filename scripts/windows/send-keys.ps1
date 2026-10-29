param(
  [Parameter(Mandatory = $true)][string]$WindowTitle,
  [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
  [Parameter(Mandatory = $true)][string]$Key,
  [int]$DelayMs = 450,
  [switch]$PreserveState
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class RamboForegroundCheck {
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
  public static bool IsTargetForeground(IntPtr handle, uint expectedProcessId, string marker) {
    return GetForegroundWindow() == handle && IsTargetWindow(handle, expectedProcessId, marker);
  }
}
"@

$browserWindows = @([RamboForegroundCheck]::FindWindows($WindowTitle, [uint32]$ExpectedProcessId))
if ($Key -eq "ANCHOR") {
  for ($captionAttempt = 0; $captionAttempt -lt 20 -and $browserWindows.Count -eq 0; $captionAttempt++) {
    $foregroundProcessId = [uint32]0
    [void][RamboForegroundCheck]::GetWindowThreadProcessId([RamboForegroundCheck]::GetForegroundWindow(), [ref]$foregroundProcessId)
    if ($foregroundProcessId -ne $ExpectedProcessId) { break }
    Start-Sleep -Milliseconds 100
    $browserWindows = @([RamboForegroundCheck]::FindWindows($WindowTitle, [uint32]$ExpectedProcessId))
  }
}
if ($browserWindows.Count -ne 1) {
  [Console]::Error.WriteLine("Expected one dedicated headed Chrome window for PID $ExpectedProcessId and title marker '$WindowTitle'; found $($browserWindows.Count). The key was not sent.")
  exit 3
}

$browserHandle = [IntPtr]$browserWindows[0]
$livePreparation = ($Key -eq "{TAB}" -and $WindowTitle.StartsWith("RAMBO NVDA prepare "))
if (-not $PreserveState -and -not $livePreparation -and $Key -notin @("ANCHOR", "SCOPE")) {
for ($attempt = 0; $attempt -lt 8; $attempt++) {
  if (-not [RamboForegroundCheck]::IsTargetWindow($browserHandle, [uint32]$ExpectedProcessId, $WindowTitle)) { break }
  [RamboForegroundCheck]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [RamboForegroundCheck]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][RamboForegroundCheck]::ShowWindowAsync($browserHandle, 3)
  [void][RamboForegroundCheck]::BringWindowToTop($browserHandle)
  [void][RamboForegroundCheck]::SetForegroundWindow($browserHandle)
  [RamboForegroundCheck]::SwitchToThisWindow($browserHandle, $true)
  Start-Sleep -Milliseconds 125

  $foreground = [RamboForegroundCheck]::GetForegroundWindow()
  $foregroundProcessId = [uint32]0
  [void][RamboForegroundCheck]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
  if ($foreground -eq $browserHandle -and $foregroundProcessId -eq $ExpectedProcessId -and [RamboForegroundCheck]::IsTargetWindow($browserHandle, [uint32]$ExpectedProcessId, $WindowTitle)) {
    break
  }
}
}

$foreground = [RamboForegroundCheck]::GetForegroundWindow()
$foregroundProcessId = [uint32]0
[void][RamboForegroundCheck]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
if ($foreground -ne $browserHandle -or $foregroundProcessId -ne $ExpectedProcessId -or -not [RamboForegroundCheck]::IsTargetWindow($browserHandle, [uint32]$ExpectedProcessId, $WindowTitle)) {
  [Console]::Error.WriteLine("The dedicated headed browser webpage could not be focused safely; the key was not sent. Expected PID $ExpectedProcessId and title marker '$WindowTitle'; found PID $foregroundProcessId and title '$([RamboForegroundCheck]::WindowTitle($foreground))'.")
  exit 3
}

if ($Key -eq "SCOPE") {
  . (Join-Path $PSScriptRoot "focus-anchor.ps1")
  $result = Get-RamboDocumentFocus $browserHandle { [RamboForegroundCheck]::IsTargetForeground($browserHandle, [uint32]$ExpectedProcessId, $WindowTitle) }
  if ($result.ok) { [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress)); exit 0 }
  [Console]::Error.WriteLine($result.reason)
  exit 3
}

if ($Key -eq "ANCHOR") {
  . (Join-Path $PSScriptRoot "focus-anchor.ps1")
  $result = Set-RamboDocumentAnchorFocus $browserHandle { [RamboForegroundCheck]::IsTargetForeground($browserHandle, [uint32]$ExpectedProcessId, $WindowTitle) }
  if ($result.ok) { exit 0 }
  [Console]::Error.WriteLine($result.reason)
  exit 3
}

if ($Key -eq "{TAB}") {
  if (-not $PreserveState) {
  # During live startup, this marker exists only in the agent's synthetic
  # blank document. Use real Windows accessibility focus instead of assuming
  # an F6 pane order (which varies with Chrome's automation/info bars).
  if ($WindowTitle.StartsWith("RAMBO NVDA prepare ")) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $automationRoot = [System.Windows.Automation.AutomationElement]::FromHandle($browserHandle)
  $prepareCondition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Prepare document focus")),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))
  )
  $prepareControl = $null
  for ($readyAttempt = 0; $readyAttempt -lt 30; $readyAttempt++) {
    if (-not [RamboForegroundCheck]::IsTargetForeground($browserHandle, [uint32]$ExpectedProcessId, $WindowTitle)) { [Console]::Error.WriteLine("Browser focus was lost; preparation was canceled."); exit 3 }
    $prepareControl = $automationRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $prepareCondition)
    if ($prepareControl) { break }
    Start-Sleep -Milliseconds 100
  }
  if ($prepareControl) {
    if (-not [RamboForegroundCheck]::IsTargetForeground($browserHandle, [uint32]$ExpectedProcessId, $WindowTitle)) { [Console]::Error.WriteLine("Browser focus was lost; preparation was canceled."); exit 3 }
    $prepareControl.SetFocus()
    Start-Sleep -Milliseconds 250
    exit 0
  }
  [Console]::Error.WriteLine("The synthetic preparation control was not exposed; no setup keys were sent.")
  exit 3
  }
  # Put Chromium in a known focus state, then use its standard focus-pane
  # command to enter web content before tabbing. This avoids toolbar traversal.
  [RamboForegroundCheck]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  [RamboForegroundCheck]::keybd_event(0x4C, 0, 0, [UIntPtr]::Zero)
  [RamboForegroundCheck]::keybd_event(0x4C, 0, 2, [UIntPtr]::Zero)
  [RamboForegroundCheck]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 125
  if (-not [RamboForegroundCheck]::IsTargetForeground($browserHandle, [uint32]$ExpectedProcessId, $WindowTitle)) { [Console]::Error.WriteLine("Browser focus was lost; remaining keys were not sent."); exit 3 }
  [RamboForegroundCheck]::keybd_event(0x75, 0, 0, [UIntPtr]::Zero)
  [RamboForegroundCheck]::keybd_event(0x75, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 125
  if (-not [RamboForegroundCheck]::IsTargetForeground($browserHandle, [uint32]$ExpectedProcessId, $WindowTitle)) { [Console]::Error.WriteLine("Browser focus was lost; remaining keys were not sent."); exit 3 }
  [RamboForegroundCheck]::keybd_event(0x75, 0, 0, [UIntPtr]::Zero)
  [RamboForegroundCheck]::keybd_event(0x75, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 250
  if (-not [RamboForegroundCheck]::IsTargetForeground($browserHandle, [uint32]$ExpectedProcessId, $WindowTitle)) { [Console]::Error.WriteLine("Browser focus was lost; Tab was not sent."); exit 3 }
  }
  # PreserveState sends only Tab: replay already established webpage focus.
  # Alt/address-bar focus changes could close the menu being tested.
  [RamboForegroundCheck]::keybd_event(0x09, 0, 0, [UIntPtr]::Zero)
  [RamboForegroundCheck]::keybd_event(0x09, 0, 2, [UIntPtr]::Zero)
} else {
  [Console]::Error.WriteLine("The guarded native keyboard helper received an unsupported key.")
  exit 5
}
Start-Sleep -Milliseconds ([Math]::Max(100, $DelayMs))
