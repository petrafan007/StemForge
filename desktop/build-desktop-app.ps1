# Builds StemForge.exe (in the StemForge folder) and puts a "StemForge" shortcut on your desktop.
#
# Usage (PowerShell, from the StemForge folder):   .\desktop\build-desktop-app.ps1
# Options:  -NoShortcut   only build the exe
#
# Re-run this after pulling new code if you want to rebuild the launcher itself. (StemForge.exe
# rebuilds the web app automatically whenever the source changes.)

param(
    [switch]$NoShortcut
)

$ErrorActionPreference = "Stop"
$desktopDir = $PSScriptRoot
$root = Split-Path $desktopDir -Parent

Write-Host "=== Building the StemForge desktop app ===" -ForegroundColor Cyan

# 1. Web app build (served by the GPU server in desktop mode)
Push-Location $root
try {
    if (-not (Test-Path "node_modules")) {
        Write-Host "Installing web app dependencies ..."
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }
    Write-Host "Building the web app (dist\) ..."
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} finally {
    Pop-Location
}

# 2. Compile the launcher with the C# compiler that ships with Windows (.NET Framework 4.x)
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw "The .NET Framework 4 C# compiler (csc.exe) was not found." }

$icon = Join-Path $desktopDir "StemForge.ico"
$exe = Join-Path $root "StemForge.exe"
$source = Join-Path $desktopDir "StemForgeLauncher.cs"

Write-Host "Compiling StemForge.exe ..."
& $csc /nologo /target:winexe /optimize+ "/out:$exe" "/win32icon:$icon" `
    /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Management.dll `
    $source
if ($LASTEXITCODE -ne 0) { throw "Compiling the launcher failed." }
Write-Host "Built $exe" -ForegroundColor Green

# 3. Desktop shortcut
if (-not $NoShortcut) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $lnk = Join-Path $desktop "StemForge.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($lnk)
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = "$exe,0"
    $shortcut.Description = "StemForge - stem separation, MIDI, tabs and sheet music (local GPU)"
    $shortcut.Save()
    Write-Host "Desktop shortcut created: $lnk" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Double-click StemForge on your desktop to start." -ForegroundColor Green
