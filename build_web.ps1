param(
    [string]$Toolchain = "stable-x86_64-pc-windows-gnu"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Monta la versión web: la misma interfaz de `web/`, pero con el núcleo de
# edición dentro del navegador (`div2wasm.wasm`). El resultado es una carpeta
# estática que se puede publicar tal cual, sin servidor de aplicaciones.
#
# No confundir con build_release.ps1, que monta el paquete de Windows con
# `fpgplusedit.exe`: aquel SÍ habla con el disco del equipo.

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
$wasm = Join-Path $root "target\wasm32-unknown-unknown\release\div2wasm.wasm"
$packageRoot = Join-Path $root "target\package"
$outDir = Join-Path $packageRoot "FPGPlusEdit-$version-web"

Write-Host "==> Compilando el núcleo a WebAssembly con $Toolchain"
& $cargo "+$Toolchain" build --release --locked --target wasm32-unknown-unknown -p div2wasm
if ($LASTEXITCODE -ne 0) {
    throw "Ha fallado la compilación a WebAssembly. Si falta el destino: rustup target add wasm32-unknown-unknown --toolchain $Toolchain"
}

Write-Host "==> Preparando la carpeta web"
if (Test-Path $outDir) {
    Remove-Item $outDir -Recurse -Force
}
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$files = @(
    @{ Src = Join-Path $root "web\index.html";  Dst = Join-Path $outDir "index.html" },
    @{ Src = Join-Path $root "web\style.css";   Dst = Join-Path $outDir "style.css" },
    @{ Src = Join-Path $root "web\app.js";      Dst = Join-Path $outDir "app.js" },
    @{ Src = Join-Path $root "web\backend.js";  Dst = Join-Path $outDir "backend.js" },
    @{ Src = $wasm;                             Dst = Join-Path $outDir "div2wasm.wasm" },
    @{ Src = Join-Path $root "LICENSE";         Dst = Join-Path $outDir "LICENSE" }
)

foreach ($file in $files) {
    if (!(Test-Path $file.Src)) {
        throw "Falta el fichero $($file.Src)"
    }
    Copy-Item $file.Src $file.Dst -Force
}

$wasmInfo = Get-Item (Join-Path $outDir "div2wasm.wasm")
$wasmHash = (Get-FileHash $wasmInfo.FullName -Algorithm SHA256).Hash.ToLowerInvariant()

Write-Host ""
Write-Host "Versión web generada en:"
Write-Host "  $outDir"
Write-Host ""
Write-Host "  div2wasm.wasm   $($wasmInfo.Length) bytes"
Write-Host "                  SHA256 $wasmHash"
Write-Host ""
Write-Host "Para probarla en local, sirve la carpeta por HTTP (una URL «file://» no vale,"
Write-Host "el navegador no deja leer el .wasm):"
Write-Host ""
Write-Host "  cd `"$outDir`""
Write-Host "  python -m http.server 8000     # y abre http://localhost:8000/"
Write-Host ""
Write-Host "Para publicarla, copia el contenido de esa carpeta a cualquier alojamiento"
Write-Host "de ficheros estáticos (GitHub Pages, Netlify, Cloudflare Pages…)."
