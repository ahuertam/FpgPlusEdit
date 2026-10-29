param(
    [string]$Toolchain = "stable-x86_64-pc-windows-gnu",
    [switch]$RunTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"

if (!(Test-Path $cargo)) {
    throw "No encuentro cargo.exe en $cargo"
}

$cargoToml = Get-Content (Join-Path $root "Cargo.toml") -Raw
$m = [regex]::Match($cargoToml, '(?m)^version\s*=\s*"([^"]+)"')
if (!$m.Success) {
    throw "No he podido leer la versión del workspace en Cargo.toml"
}

$version = $m.Groups[1].Value
$releaseDir = Join-Path $root "target\release"
$packageRoot = Join-Path $root "target\package"
$packageName = "FPGPlusEdit-$version-windows-gnu"
$outDir = Join-Path $packageRoot $packageName
$webOut = Join-Path $outDir "web"

Write-Host "==> Compilando release con toolchain $Toolchain"
& $cargo "+$Toolchain" build --release --locked
if ($LASTEXITCODE -ne 0) {
    throw "cargo build --release ha fallado"
}

if ($RunTests) {
    Write-Host "==> Ejecutando tests"
    & $cargo "+$Toolchain" test --locked
    if ($LASTEXITCODE -ne 0) {
        throw "cargo test ha fallado"
    }
}

Write-Host "==> Preparando paquete $packageName"
if (Test-Path $outDir) {
    Remove-Item $outDir -Recurse -Force
}
New-Item -ItemType Directory -Path $webOut -Force | Out-Null

$files = @(
    @{ Src = Join-Path $releaseDir "fpgplusedit.exe"; Dst = Join-Path $outDir "fpgplusedit.exe" },
    @{ Src = Join-Path $releaseDir "div2fpg.exe"; Dst = Join-Path $outDir "div2fpg.exe" },
    @{ Src = Join-Path $root "README.md"; Dst = Join-Path $outDir "README.md" },
    @{ Src = Join-Path $root "LICENSE"; Dst = Join-Path $outDir "LICENSE" },
    @{ Src = Join-Path $root "web\index.html"; Dst = Join-Path $webOut "index.html" },
    @{ Src = Join-Path $root "web\style.css"; Dst = Join-Path $webOut "style.css" },
    @{ Src = Join-Path $root "web\app.js"; Dst = Join-Path $webOut "app.js" }
)

foreach ($file in $files) {
    if (!(Test-Path $file.Src)) {
        throw "Falta el fichero $($file.Src)"
    }
    Copy-Item $file.Src $file.Dst -Force
}

$hashLines = Get-ChildItem $outDir -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
        $rel = $_.FullName.Substring($outDir.Length + 1).Replace('\', '/')
        $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash *$rel"
    }

[System.IO.File]::WriteAllLines((Join-Path $outDir "SHA256SUMS.txt"), $hashLines)

Write-Host ""
Write-Host "Paquete generado en:"
Write-Host "  $outDir"
Write-Host ""
Write-Host "Arranque manual:"
Write-Host "  .\fpgplusedit.exe"
