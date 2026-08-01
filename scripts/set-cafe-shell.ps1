<#
.SYNOPSIS
  Set or restore the Windows shell for a cafe seat user so Pixl starts instead of Explorer.

.DESCRIPTION
  Writes HKCU\Software\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell so Winlogon
  launches Pixl.exe (or explorer.exe on restore) as the per-user shell.

  Recommended: run while logged in as the cafe Standard user (no elevation required for HKCU).

  Offline / another user: load that user's NTUSER.DAT into a temporary registry hive, then
  pass -HiveRoot. Example (elevated admin PowerShell):

    reg load HKU\CafeTemp "C:\Users\cafeuser\NTUSER.DAT"
    .\scripts\set-cafe-shell.ps1 -HiveRoot 'Registry::HKEY_USERS\CafeTemp'
    reg unload HKU\CafeTemp

  Do not unload the hive while any process still has it open. Log off the target user first
  if their profile is in use.

.PARAMETER Restore
  Set Shell back to explorer.exe (normal Windows desktop).

.PARAMETER PixlPath
  Full path to Pixl.exe when setting the shell. Default: C:\Program Files\Pixl\Pixl.exe

.PARAMETER HiveRoot
  Registry path for a loaded user hive (e.g. Registry::HKEY_USERS\CafeTemp). When omitted,
  the current user's HKCU is used.

.EXAMPLE
  # As cafeuser, after installing Pixl:
  .\scripts\set-cafe-shell.ps1

.EXAMPLE
  .\scripts\set-cafe-shell.ps1 -Restore

.EXAMPLE
  .\scripts\set-cafe-shell.ps1 -PixlPath 'D:\Apps\Pixl\Pixl.exe'
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Restore,

  [string]$PixlPath = 'C:\Program Files\Pixl\Pixl.exe',

  [string]$HiveRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$winlogonRelative = 'Software\Microsoft\Windows NT\CurrentVersion\Winlogon'
$shellValueName = 'Shell'

function Get-WinlogonKeyPath {
  if ($HiveRoot) {
    $root = $HiveRoot.TrimEnd('\')
    if (-not (Test-Path -LiteralPath $root)) {
      throw "Hive root not found: $HiveRoot. Load the user's NTUSER.DAT first (see script header)."
    }
    return Join-Path $root $winlogonRelative
  }
  return "Registry::HKEY_CURRENT_USER\$winlogonRelative"
}

function Set-UserShell {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ShellExe
  )

  $keyPath = Get-WinlogonKeyPath

  if (-not (Test-Path -LiteralPath $keyPath)) {
    if ($PSCmdlet.ShouldProcess($keyPath, 'Create Winlogon key')) {
      New-Item -Path $keyPath -Force | Out-Null
    }
  }

  if ($PSCmdlet.ShouldProcess($keyPath, "Set Shell = $ShellExe")) {
    New-ItemProperty -LiteralPath $keyPath -Name $shellValueName -Value $ShellExe -PropertyType String -Force | Out-Null
    $current = (Get-ItemProperty -LiteralPath $keyPath -Name $shellValueName).$shellValueName
    if ($current -ne $ShellExe) {
      throw "Failed to verify Shell value. Expected '$ShellExe', got '$current'."
    }
    Write-Host "Shell set to: $ShellExe"
    if ($HiveRoot) {
      Write-Host "Target hive: $HiveRoot"
    } else {
      Write-Host "Target: current user ($env:USERNAME)"
    }
  }
}

try {
  if ($Restore) {
    Set-UserShell -ShellExe 'explorer.exe'
    Write-Host 'Restore complete. Next login for this user will start Explorer.'
    exit 0
  }

  if (-not (Test-Path -LiteralPath $PixlPath)) {
    Write-Error @"
Pixl.exe not found at:
  $PixlPath

Install Pixl first, or pass -PixlPath with the full path to Pixl.exe.
Refusing to set Shell to a missing executable.
"@
    exit 1
  }

  $resolved = (Resolve-Path -LiteralPath $PixlPath).Path
  Set-UserShell -ShellExe $resolved
  Write-Host 'Done. Sign out and back in (or reboot) for the cafe user to start Pixl as the shell.'
  exit 0
}
catch {
  Write-Error $_.Exception.Message
  exit 1
}
