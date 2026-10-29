param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$LogFile
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "NVDA executable was not found at $Executable"
}

$arguments = @(
  "--minimal",
  "--config-path=`"$ConfigPath`"",
  "--log-file=`"$LogFile`"",
  "--log-level=20"
)

$nvdaProcess = Start-Process -FilePath $Executable -ArgumentList $arguments -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 500
if ($nvdaProcess.HasExited -and $nvdaProcess.ExitCode -ne 0) {
  throw "NVDA exited during startup with code $($nvdaProcess.ExitCode)."
}
Write-Output $nvdaProcess.Id
