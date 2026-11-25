# Build standalone XIQ-SE-Studio.exe on Windows
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$Python = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$PyInstaller = Join-Path $ProjectRoot ".venv\Scripts\pyinstaller.exe"

Write-Host "1/2 - Generation de l'icone..."
& $Python build_icon.py

Write-Host "2/2 - Compilation de XIQ-SE-Studio.exe..."
& $PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name "XIQ-SE-Studio" `
    --icon "assets\app_icon.ico" `
    --add-data "frontend;frontend" `
    --collect-all webview `
    --collect-all pythonnet `
    --collect-all clr_loader `
    --hidden-import backend.server `
    --hidden-import backend.storage `
    --hidden-import backend.xiqse_client `
    --hidden-import backend.mock_engine `
    --hidden-import backend.code_generator `
    --hidden-import backend.templates_catalog `
    app.py

Write-Host "Build termine ! Executable disponible ici : $ProjectRoot\dist\XIQ-SE-Studio.exe"
