param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][int]$ExpectedProcessId
)

if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  exit 0
}

$ErrorActionPreference = "Stop"
$ownedProcess = Get-Process -Id $ExpectedProcessId -ErrorAction SilentlyContinue
if (-not $ownedProcess) { exit 0 }
if ($ownedProcess.ProcessName -ne "nvda") { throw "Refusing to stop a process that is not NVDA." }
$ownedExecutable = $null
try { $ownedExecutable = $ownedProcess.Path } catch {}
if ($ownedExecutable -and -not $ownedExecutable.Equals($Executable, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to stop an NVDA process from a different executable."
}
# Installed UIAccess readers may reject Stop-Process. Use NVDA's own IPC exit
# only after confirming this desktop's sole reader is the authenticated PID.
$desktopSession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$readers = @(Get-Process -Name nvda -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $desktopSession })
if ($readers.Count -ne 1 -or $readers[0].Id -ne $ExpectedProcessId) {
  # The add-on can finish its graceful exit between the two process snapshots.
  # A vanished owned PID is success; never send global IPC to another reader.
  if (-not (Get-Process -Id $ExpectedProcessId -ErrorAction SilentlyContinue)) { exit 0 }
  throw "Refusing to send shutdown to an unverified NVDA desktop instance."
}
$exitRequest = Start-Process -FilePath $Executable -ArgumentList @("--quit") -WindowStyle Hidden -PassThru -Wait
for ($attempt = 0; $attempt -lt 16; $attempt++) {
  if (-not (Get-Process -Id $ExpectedProcessId -ErrorAction SilentlyContinue)) { exit 0 }
  Start-Sleep -Milliseconds 250
}
Stop-Process -Id $ExpectedProcessId -Force -ErrorAction Stop
