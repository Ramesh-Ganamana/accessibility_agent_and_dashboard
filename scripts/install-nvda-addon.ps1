param(
  [string]$ConfigPath = "$env:LOCALAPPDATA\RAMBO\nvda-profile"
)

$workspace = Split-Path -Parent $PSScriptRoot
$source = Join-Path $workspace "nvda-addon\accessibilityAgentCapture"
$targetRoot = Join-Path $ConfigPath "addons"
$target = Join-Path $targetRoot "accessibilityAgentCapture"

if (-not (Test-Path -LiteralPath $source)) {
  throw "NVDA add-on source was not found at $source"
}

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -LiteralPath (Join-Path $source "manifest.ini") -Destination (Join-Path $target "manifest.ini") -Force
$sourcePlugins = Join-Path $source "globalPlugins"
$targetPlugins = Join-Path $target "globalPlugins"
New-Item -ItemType Directory -Force -Path $targetPlugins | Out-Null
Copy-Item -LiteralPath (Join-Path $sourcePlugins "accessibilityAgentCapture.py") -Destination (Join-Path $targetPlugins "accessibilityAgentCapture.py") -Force

# The dedicated test profile never runs NVDA's automatic update check, which adds
# startup work and network access to every test. Only this profile's nvda.ini is
# changed; a personal NVDA configuration is never touched.
$iniPath = Join-Path $ConfigPath "nvda.ini"
$lines = New-Object System.Collections.Generic.List[string]
if (Test-Path -LiteralPath $iniPath) { $lines.AddRange([string[]](Get-Content -LiteralPath $iniPath -Encoding UTF8)) }
$section = -1
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].Trim() -eq "[update]") { $section = $i; break } }
if ($section -lt 0) {
  $lines.Add("[update]")
  $lines.Add("`tautoCheck = False")
} else {
  $end = $lines.Count
  for ($i = $section + 1; $i -lt $lines.Count; $i++) { if ($lines[$i].TrimStart().StartsWith("[")) { $end = $i; break } }
  $existing = -1
  for ($i = $section + 1; $i -lt $end; $i++) { if ($lines[$i] -match '^\s*autoCheck\s*=') { $existing = $i } }
  if ($existing -ge 0) { $lines[$existing] = "`tautoCheck = False" } else { $lines.Insert($section + 1, "`tautoCheck = False") }
}
New-Item -ItemType Directory -Force -Path $ConfigPath | Out-Null
[System.IO.File]::WriteAllLines($iniPath, $lines, (New-Object System.Text.UTF8Encoding($false)))

Write-Output "Installed the RAMBO NVDA capture add-on into $target"
Write-Output "Set NVDA_CONFIG_PATH=$ConfigPath. Exit manually running NVDA; the agent launches and stops its own test reader."
