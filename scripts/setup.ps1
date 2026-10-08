$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$installDir = Join-Path $projectDir 'bin'
$version = '1.6.1'
$decoderPath = Join-Path $installDir "multimon-ng-$version.exe"
$expectedHash = '115946771798e110c76b9dc40eedf285692c5ac0a37386509586d904d92244a0'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

if (!(Test-Path $decoderPath -PathType Leaf)) {
  $workDir = Join-Path ([System.IO.Path]::GetTempPath()) ('subpager-radio-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $workDir | Out-Null
  try {
    $archive = Join-Path $workDir 'multimon-ng-win64.zip'
    Invoke-WebRequest -Uri "https://github.com/EliasOenal/multimon-ng/releases/download/$version/multimon-ng-win64.zip" -OutFile $archive
    if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant() -ne $expectedHash) {
      throw 'multimon-ng archive hash does not match the published 1.6.1 Windows x64 release.'
    }
    Expand-Archive -Path $archive -DestinationPath (Join-Path $workDir 'unpacked')
    $decoder = Get-ChildItem -Recurse -Filter 'multimon-ng.exe' (Join-Path $workDir 'unpacked') | Select-Object -First 1
    if (!$decoder) { throw 'The release archive did not contain multimon-ng.exe.' }
    Get-ChildItem -Path $decoder.Directory.FullName -Filter '*.dll' -File | Copy-Item -Destination $installDir -Force
    Copy-Item $decoder.FullName -Destination $decoderPath -Force
  } finally { Remove-Item -Recurse -Force $workDir }
}

Write-Host "multimon-ng $version installed at $decoderPath"
Write-Host 'Next, install rtl_fm and its DLLs, and bind only your NESDR device to WinUSB using Zadig.'
Write-Host 'See README.md for MSYS2 package and driver instructions. This script does not change drivers.'
