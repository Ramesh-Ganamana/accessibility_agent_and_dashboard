# Exercise the real native-window selection code with in-memory windows.
# Every Win32 import is replaced before compilation; this fixture cannot focus
# a desktop window or send a real key.
$ErrorActionPreference = "Stop"
$fakeNativeMethods = @'
  public sealed class FakeWindow {
    public IntPtr Handle;
    public uint ProcessId;
    public bool Visible;
    public string ClassName;
    public string Title;
  }
  public static readonly List<FakeWindow> FakeWindows = new List<FakeWindow>();
  public static IntPtr FakeForeground = IntPtr.Zero;
  public static int KeyEvents = 0;
  public static int ActivationRequests = 0;
  public static void Reset() {
    FakeWindows.Clear(); FakeForeground = IntPtr.Zero; KeyEvents = 0; ActivationRequests = 0;
  }
  public static void AddWindow(long handle, uint processId, string title, bool visible, string className) {
    FakeWindows.Add(new FakeWindow { Handle = new IntPtr(handle), ProcessId = processId, Title = title, Visible = visible, ClassName = className });
  }
  private static FakeWindow FindFake(IntPtr handle) { return FakeWindows.Find(window => window.Handle == handle); }
  private static bool EnumWindows(EnumWindowCallback callback, IntPtr value) {
    foreach (var window in FakeWindows) if (!callback(window.Handle, value)) return false;
    return true;
  }
  private static bool IsWindowVisible(IntPtr handle) { var window = FindFake(handle); return window != null && window.Visible; }
  private static int GetWindowText(IntPtr handle, StringBuilder text, int count) {
    var window = FindFake(handle); var value = window == null ? "" : window.Title;
    text.Append(value.Substring(0, Math.Min(value.Length, count - 1))); return text.Length;
  }
  private static int GetWindowTextLength(IntPtr handle) { var window = FindFake(handle); return window == null ? 0 : window.Title.Length; }
  private static int GetClassName(IntPtr handle, StringBuilder text, int count) {
    var window = FindFake(handle); if (window != null) text.Append(window.ClassName); return text.Length;
  }
  public static uint GetWindowThreadProcessId(IntPtr handle, out uint processId) {
    var window = FindFake(handle); processId = window == null ? 0 : window.ProcessId; return 1;
  }
  public static IntPtr GetForegroundWindow() { return FakeForeground; }
  public static bool ShowWindowAsync(IntPtr handle, int command) { ActivationRequests++; return true; }
  public static bool SetForegroundWindow(IntPtr handle) { ActivationRequests++; FakeForeground = handle; return true; }
  public static bool BringWindowToTop(IntPtr handle) { ActivationRequests++; return true; }
  public static void SwitchToThisWindow(IntPtr handle, bool altTab) { ActivationRequests++; FakeForeground = handle; }
  public static void keybd_event(byte key, byte scanCode, uint flags, UIntPtr info) { KeyEvents++; }
'@

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "$Message Expected '$Expected', received '$Actual'." }
}

$helperDefinitions = @(
  @{ File = 'focus-browser.ps1'; Class = 'RamboWindowControl' },
  @{ File = 'key-server.ps1'; Class = 'RamboKeyServer' },
  @{ File = 'send-keys.ps1'; Class = 'RamboForegroundCheck' }
)
$helperAsts = @{}
foreach ($definition in $helperDefinitions) {
  $helperPath = Join-Path $PSScriptRoot ('windows/' + $definition.File)
  $parseTokens = $null
  $parseErrors = $null
  $helperAst = [System.Management.Automation.Language.Parser]::ParseFile($helperPath, [ref]$parseTokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
  $helperAsts[$definition.Class] = $helperAst
  $nativeType = $helperAst.Find({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type' -and $node.CommandElements.Count -eq 2
  }, $true)
  if (-not $nativeType) { throw "Native helper type was not found in $($definition.File)." }
  $source = $nativeType.CommandElements[1].Value
  $source = [regex]::Replace($source, '(?m)^\s*\[DllImport\([^\r\n]*\)\]\s+(?:public|private)\s+static\s+extern\s+[^\r\n]*;\r?$', '')
  if ($source.Contains('DllImport') -or $source.Contains('extern ')) { throw 'Refusing to compile a test double with native imports remaining.' }
  $declaration = 'public static class ' + $definition.Class + ' {'
  $source = $source.Replace($declaration, $declaration + [Environment]::NewLine + $fakeNativeMethods)
  Add-Type -TypeDefinition $source
  $native = $definition.Class -as [type]
  $native::Reset()
  $native::AddWindow(101, 42, 'RAMBO NVDA run home - Google Chrome', $true, 'Chrome_WidgetWin_1')
  $native::AddWindow(202, 42, 'RAMBO NVDA run child - Google Chrome', $true, 'Chrome_WidgetWin_1')
  $native::AddWindow(303, 77, 'RAMBO NVDA run child - Google Chrome', $true, 'Chrome_WidgetWin_1')
  $native::AddWindow(404, 42, 'RAMBO NVDA run child - Google Chrome', $false, 'Chrome_WidgetWin_1')
  $native::AddWindow(505, 42, 'RAMBO NVDA run child - Other app', $true, 'OtherClass')

  $matches = @($native::FindWindows('RAMBO NVDA run child', 42))
  Assert-Equal $matches.Count 1 "$($definition.File): hidden, unrelated-process, and non-Chrome windows must be excluded."
  $matchedHandle = if ($definition.Class -eq 'RamboWindowControl') { $matches[0].Handle } else { $matches[0] }
  Assert-Equal $matchedHandle.ToInt64() 202 "$($definition.File): a popup sharing the main browser process must resolve to its own HWND."
  Assert-Equal $native::IsTargetWindow([IntPtr]101, 42, 'RAMBO NVDA run child') $false 'A home-tab HWND cannot stand in for a popup.'
  $native::AddWindow(606, 42, 'RAMBO NVDA run child - Google Chrome', $true, 'Chrome_WidgetWin_1')
  Assert-Equal @($native::FindWindows('RAMBO NVDA run child', 42)).Count 2 'Duplicate markers must remain ambiguous, never silently select the first window.'
  Assert-Equal @($native::FindWindows('', 42)).Count 0 'Empty markers must never select windows.'
  Assert-Equal $native::KeyEvents 0 'Window discovery must not send keys.'
  Assert-Equal $native::ActivationRequests 0 'Window discovery must not activate windows.'
}

# Execute only the key server's function definitions, against the fake Win32
# class above. No helper startup/console loop or real Add-Type block is run.
$keyFunctions = $helperAsts['RamboKeyServer'].FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
. ([scriptblock]::Create(($keyFunctions | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine))
[RamboKeyServer]::Reset()
[RamboKeyServer]::AddWindow(101, 42, 'RAMBO NVDA run home - Google Chrome', $true, 'Chrome_WidgetWin_1')
[RamboKeyServer]::AddWindow(202, 42, 'RAMBO NVDA run child - Google Chrome', $true, 'Chrome_WidgetWin_1')
$command = [pscustomobject]@{ op = 'tab'; processId = 42; windowTitle = 'RAMBO NVDA run child'; delayMs = 50; preserveState = $true }
[RamboKeyServer]::FakeForeground = [IntPtr]101
$result = Invoke-RamboCommand $command
Assert-Equal $result.ok $false 'A foreground home tab must not receive a key intended for its popup.'
Assert-Equal ([RamboKeyServer]::KeyEvents) 0 'A failed foreground guard must not send keys.'
Assert-Equal ([RamboKeyServer]::ActivationRequests) 0 'PreserveState must never switch the user back by force.'
[RamboKeyServer]::FakeForeground = [IntPtr]202
$result = Invoke-RamboCommand $command
Assert-Equal $result.ok $true 'The exact foreground popup must accept its requested Tab.'
Assert-Equal ([RamboKeyServer]::KeyEvents) 2 'A successful command sends one key-down/key-up pair.'
[RamboKeyServer]::AddWindow(606, 42, 'RAMBO NVDA run child - Google Chrome', $true, 'Chrome_WidgetWin_1')
$result = Invoke-RamboCommand $command
Assert-Equal $result.ok $false 'Ambiguous target markers must reject the command even when one match has foreground.'
Assert-Equal ([RamboKeyServer]::KeyEvents) 2 'An ambiguous command must send no additional keys.'
[RamboKeyServer]::FakeWindows.RemoveAt(2)
[RamboKeyServer]::FakeWindows[1].Title = 'Different tab - Google Chrome'
$result = Invoke-RamboCommand $command
Assert-Equal $result.ok $false 'A same-HWND tab change must invalidate its previous marker.'
Assert-Equal ([RamboKeyServer]::KeyEvents) 2 'A changed active tab must receive no additional keys.'

Write-Output 'Native browser-window regression checks passed (three helpers; fake windows only, no desktop input).'
