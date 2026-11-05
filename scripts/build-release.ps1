param(
  [string]$Version = "",
  [string]$PackagedDir = "",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

$ProductCn = "LazyCut"
$GuideFileCn = [regex]::Unescape("\u4F7F\u7528\u8BF4\u660E.txt")

$PackageJson = Get-Content (Join-Path $Root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = [string]$PackageJson.version
}
$Version = $Version.TrimStart('v', 'V')

$VersionParts = $Version.Split('.')
while ($VersionParts.Count -lt 4) {
  $VersionParts += "0"
}
$FileVersion = ($VersionParts[0..3] -join '.')

if ([string]::IsNullOrWhiteSpace($PackagedDir)) {
  $PackagedDir = Join-Path $Root ("artifacts\" + $ProductCn + "-win32-x64")
}
if (-not (Test-Path -LiteralPath $PackagedDir)) {
  throw ("Packaged application directory not found: " + $PackagedDir + " (run npm run package first)")
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $Root "artifacts\release"
}
if (Test-Path -LiteralPath $OutputDir) {
  Remove-Item -LiteralPath $OutputDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function Resolve-Makensis {
  $cmd = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
    "${env:ProgramFiles}\NSIS\makensis.exe",
    "C:\ProgramData\chocolatey\bin\makensis.exe",
    (Join-Path $Root ".generated\nsis\nsis-3.11\makensis.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }
  throw "NSIS (makensis.exe) not found. Please install NSIS."
}

function Get-FileSha256Hex([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$Utf8Bom = New-Object System.Text.UTF8Encoding($true)
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$InstallerDir = Join-Path $Root "packaging\installer"
$IconPath = Join-Path $Root "app\assets\app-icon.ico"
$InstallerGuidePath = Join-Path $InstallerDir $GuideFileCn
$SetupExeName = "LazyCut-$Version-Windows-x64-Setup.exe"
$SetupExePath = Join-Path $OutputDir $SetupExeName

Write-Host "[1/2] Building NSIS installer: $SetupExeName"
$GenConfigNsh = Join-Path $InstallerDir "generated-config.nsh"
$GenInstallNsh = Join-Path $InstallerDir "generated-install.nsh"
$GenUninstallNsh = Join-Path $InstallerDir "generated-uninstall.nsh"
$GenUninstallDirsNsh = Join-Path $InstallerDir "generated-uninstall-dirs.nsh"

try {
  $PackagedRoot = (Resolve-Path -LiteralPath $PackagedDir).Path.TrimEnd('\')
  $AllFiles = Get-ChildItem -LiteralPath $PackagedRoot -Recurse -File | Sort-Object FullName
  $AllDirs = Get-ChildItem -LiteralPath $PackagedRoot -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending

  $TotalBytes = ($AllFiles | Measure-Object -Property Length -Sum).Sum
  if (Test-Path -LiteralPath $InstallerGuidePath) {
    $TotalBytes += (Get-Item -LiteralPath $InstallerGuidePath).Length
  }
  $InstalledSizeKb = [Math]::Max(1, [int][Math]::Ceiling($TotalBytes / 1024.0))

  $ConfigLines = @(
    "!define APP_VERSION `"$Version`"",
    "!define APP_FILE_VERSION `"$FileVersion`"",
    "!define OUTPUT_FILE `"$SetupExePath`"",
    "!define APP_ICON `"$IconPath`"",
    "!define INSTALLED_SIZE_KB $InstalledSizeKb"
  )
  [System.IO.File]::WriteAllLines($GenConfigNsh, $ConfigLines, $Utf8Bom)

  $InstallLines = New-Object System.Collections.Generic.List[string]
  $UninstallLines = New-Object System.Collections.Generic.List[string]
  $CurrentOutDir = $null

  foreach ($File in $AllFiles) {
    $RelPath = $File.FullName.Substring($PackagedRoot.Length + 1)
    $RelDir = Split-Path -Parent $RelPath
    $TargetOutDir = if ([string]::IsNullOrEmpty($RelDir)) { "`$INSTDIR" } else { "`$INSTDIR\$RelDir" }
    if ($TargetOutDir -ne $CurrentOutDir) {
      $InstallLines.Add("SetOutPath `"$TargetOutDir`"")
      $CurrentOutDir = $TargetOutDir
    }
    $InstallLines.Add("File `"$($File.FullName)`"")
    $UninstallLines.Add("Delete `"`$INSTDIR\$RelPath`"")
  }

  if (Test-Path -LiteralPath $InstallerGuidePath) {
    if ($CurrentOutDir -ne "`$INSTDIR") {
      $InstallLines.Add("SetOutPath `"`$INSTDIR`"")
    }
    $InstallLines.Add("File `"$InstallerGuidePath`"")
    $UninstallLines.Add("Delete `"`$INSTDIR\$GuideFileCn`"")
  }

  $UninstallDirLines = New-Object System.Collections.Generic.List[string]
  foreach ($Dir in $AllDirs) {
    $RelDir = $Dir.FullName.Substring($PackagedRoot.Length + 1)
    $UninstallDirLines.Add("RMDir `"`$INSTDIR\$RelDir`"")
  }

  if (Test-Path -LiteralPath $InstallerGuidePath) {
    $GuideText = [System.IO.File]::ReadAllText($InstallerGuidePath, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($InstallerGuidePath, $GuideText, $Utf8Bom)
  }

  [System.IO.File]::WriteAllLines($GenInstallNsh, $InstallLines, $Utf8Bom)
  [System.IO.File]::WriteAllLines($GenUninstallNsh, $UninstallLines, $Utf8Bom)
  [System.IO.File]::WriteAllLines($GenUninstallDirsNsh, $UninstallDirLines, $Utf8Bom)

  $SetupNsiPath = Join-Path $InstallerDir "setup.nsi"
  $SetupNsiText = [System.IO.File]::ReadAllText($SetupNsiPath, [System.Text.Encoding]::UTF8)
  [System.IO.File]::WriteAllText($SetupNsiPath, $SetupNsiText, $Utf8Bom)

  $Makensis = Resolve-Makensis
  & $Makensis /V2 /INPUTCHARSET UTF8 $SetupNsiPath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $SetupExePath)) {
    throw "NSIS installer compilation failed."
  }
} finally {
  Remove-Item $GenConfigNsh, $GenInstallNsh, $GenUninstallNsh, $GenUninstallDirsNsh -Force -ErrorAction SilentlyContinue
}

Write-Host "[2/2] Generating SHA256SUMS.txt"
$ReleaseFiles = Get-ChildItem -LiteralPath $OutputDir -File | Where-Object { $_.Name -ne "SHA256SUMS.txt" } | Sort-Object Name
$ShaLines = foreach ($File in $ReleaseFiles) {
  $Hash = Get-FileSha256Hex $File.FullName
  "$Hash  $($File.Name)"
}
$ShaSumsPath = Join-Path $OutputDir "SHA256SUMS.txt"
[System.IO.File]::WriteAllLines($ShaSumsPath, $ShaLines, $Utf8NoBom)

Write-Host "Release assets successfully generated at: $OutputDir"
Get-ChildItem -LiteralPath $OutputDir -File | Select-Object Name, Length
