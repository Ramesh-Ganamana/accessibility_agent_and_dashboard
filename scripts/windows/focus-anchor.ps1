# Shared by the persistent and one-shot keyboard helpers. The caller has
# already resolved the owned Chrome window and must recheck foreground before
# every native focus operation. This never invokes a control or sends keys.
function Get-RamboDocumentFocus([IntPtr]$BrowserHandle, [scriptblock]$IsTargetForeground) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  if (-not (& $IsTargetForeground)) { return @{ ok = $false; reason = "The testing tab is no longer in the foreground." } }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($BrowserHandle)
  $ancestor = [System.Windows.Automation.AutomationElement]::FocusedElement
  $inDocument = $false
  $inWindow = $false
  for ($depth = 0; $depth -lt 100 -and $ancestor; $depth++) {
    if ([System.Windows.Automation.Automation]::Compare($ancestor, $root)) { $inWindow = $true; break }
    if ($ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { $inDocument = $true }
    $ancestor = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($ancestor)
  }
  if (-not $inWindow -or -not (& $IsTargetForeground)) { return @{ ok = $false; reason = "Native focus is outside the verified testing window." } }
  return @{ ok = $true; inDocument = $inDocument }
}

function Set-RamboDocumentAnchorFocus([IntPtr]$BrowserHandle, [scriptblock]$IsTargetForeground) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($BrowserHandle)
  $condition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Accessibility test start")),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty, $true))
  )
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (-not (& $IsTargetForeground)) { return @{ ok = $false; reason = "Testing Chrome lost foreground; document focus was not changed." } }
    $matches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($matches.Count -gt 1) { return @{ ok = $false; reason = "The testing document focus marker is ambiguous; no native focus was changed." } }
    if ($matches.Count -eq 1) {
      $anchor = $matches.Item(0)
      $ancestor = $anchor
      $inDocument = $false
      for ($depth = 0; $depth -lt 100 -and $ancestor; $depth++) {
        if ([System.Windows.Automation.Automation]::Compare($ancestor, $root)) { break }
        if ($ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { $inDocument = $true; break }
        $ancestor = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($ancestor)
      }
      if (-not $inDocument -or $anchor.Current.IsOffscreen) { return @{ ok = $false; reason = "The focus marker is not in the visible testing document; no native focus was changed." } }
      if (-not (& $IsTargetForeground)) { return @{ ok = $false; reason = "Testing Chrome lost foreground; document focus was not changed." } }
      $anchor.SetFocus()
      return @{ ok = $true }
    }
    Start-Sleep -Milliseconds 50
  }
  return @{ ok = $false; reason = "The testing document focus marker was not exposed to Windows accessibility; no keys were sent." }
}
