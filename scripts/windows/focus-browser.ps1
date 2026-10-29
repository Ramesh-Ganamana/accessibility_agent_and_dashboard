param(
  [Parameter(Mandatory = $true)][string]$WindowTitle,
  [int]$ExpectedProcessId = 0
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class RamboWindowControl {
  public delegate bool EnumWindowCallback(IntPtr hWnd, IntPtr lParam);
  public sealed class BrowserWindow {
    public IntPtr Handle;
    public uint ProcessId;
    public string Title;
  }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll")] public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static string WindowTitle(IntPtr handle) {
    var text = new StringBuilder(GetWindowTextLength(handle) + 1);
    GetWindowText(handle, text, text.Capacity);
    return text.ToString();
  }
  public static bool IsTargetWindow(IntPtr handle, uint expectedProcessId, string marker) {
    if (handle == IntPtr.Zero || String.IsNullOrEmpty(marker) || !IsWindowVisible(handle)) return false;
    uint processId;
    GetWindowThreadProcessId(handle, out processId);
    if (processId == 0 || (expectedProcessId != 0 && processId != expectedProcessId)) return false;
    var className = new StringBuilder(256);
    GetClassName(handle, className, className.Capacity);
    return className.ToString() == "Chrome_WidgetWin_1" && WindowTitle(handle).IndexOf(marker, StringComparison.Ordinal) >= 0;
  }
  public static BrowserWindow[] FindWindows(string marker, uint expectedProcessId) {
    var matches = new List<BrowserWindow>();
    EnumWindows(delegate(IntPtr handle, IntPtr unused) {
      if (IsTargetWindow(handle, expectedProcessId, marker)) {
        uint processId;
        GetWindowThreadProcessId(handle, out processId);
        matches.Add(new BrowserWindow { Handle = handle, ProcessId = processId, Title = WindowTitle(handle) });
      }
      return true;
    }, IntPtr.Zero);
    return matches.ToArray();
  }
}
"@

$candidates = @([RamboWindowControl]::FindWindows($WindowTitle, [uint32]$ExpectedProcessId))
if ($candidates.Count -ne 1) {
  [Console]::Error.WriteLine("Expected one dedicated headed Chrome window with title marker '$WindowTitle'; found $($candidates.Count). No window was activated.")
  exit 2
}

$candidate = $candidates[0]
$handle = [IntPtr]$candidate.Handle
[void][RamboWindowControl]::ShowWindowAsync($handle, 3)

# Windows may reject a background process's first foreground request. A harmless
# Alt press/release grants the helper the same guarded foreground right as a user
# initiated window switch; the exact PID and HWND are still verified below.
for ($attempt = 0; $attempt -lt 8; $attempt++) {
  if (-not [RamboWindowControl]::IsTargetWindow($handle, $candidate.ProcessId, $WindowTitle)) { break }
  [RamboWindowControl]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [RamboWindowControl]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][RamboWindowControl]::ShowWindowAsync($handle, 3)
  [void][RamboWindowControl]::BringWindowToTop($handle)
  [void][RamboWindowControl]::SetForegroundWindow($handle)
  [RamboWindowControl]::SwitchToThisWindow($handle, $true)
  Start-Sleep -Milliseconds 150

  $foreground = [RamboWindowControl]::GetForegroundWindow()
  $foregroundProcessId = [uint32]0
  [void][RamboWindowControl]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
  if ($foreground -eq $handle -and $foregroundProcessId -eq $candidate.ProcessId -and [RamboWindowControl]::IsTargetWindow($handle, $candidate.ProcessId, $WindowTitle)) {
    break
  }
}

$foreground = [RamboWindowControl]::GetForegroundWindow()
$foregroundProcessId = [uint32]0
[void][RamboWindowControl]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
if ($foreground -ne $handle -or $foregroundProcessId -ne $candidate.ProcessId -or -not [RamboWindowControl]::IsTargetWindow($handle, $candidate.ProcessId, $WindowTitle)) {
  [Console]::Error.WriteLine("The dedicated headed browser could not be confirmed as the foreground window. Expected PID $($candidate.ProcessId) and handle $($handle.ToInt64()); found PID $foregroundProcessId and handle $($foreground.ToInt64()).")
  exit 3
}

[pscustomobject]@{
  processId = [int]$candidate.ProcessId
  windowHandle = $handle.ToInt64().ToString()
  title = [RamboWindowControl]::WindowTitle($handle)
} | ConvertTo-Json -Compress
