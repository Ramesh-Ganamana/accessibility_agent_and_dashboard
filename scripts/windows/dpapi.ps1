# Encrypts or decrypts saved browser sessions with Windows DPAPI for the
# current Windows user. Input and output are base64 on stdin/stdout, so cookie
# values never appear on a command line or in a temporary file.
param(
  [Parameter(Mandatory = $true)][ValidateSet("Protect", "Unprotect")][string]$Mode
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$entropy = [System.Text.Encoding]::UTF8.GetBytes("RAMBO accessibility agent saved session v1")
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
if ($Mode -eq "Protect") {
  $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
} else {
  $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
}
[Console]::Out.Write([Convert]::ToBase64String($result))
