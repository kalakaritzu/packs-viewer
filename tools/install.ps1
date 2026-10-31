# Copies the release exe to %LOCALAPPDATA%\Programs\Packs Viewer and creates a plain Start menu shortcut.
# Build it first with: npm run build
# No installer / app ID on the shortcut: Start search fails to load the icon for shortcuts that carry one.
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot '..\src-tauri\target\release\packs-viewer.exe'
$dir = Join-Path $env:LOCALAPPDATA 'Programs\Packs Viewer'
$exe = Join-Path $dir 'Packs Viewer.exe'
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Packs Viewer.lnk'
Get-Process 'packs-viewer', 'Packs Viewer' -ErrorAction SilentlyContinue | Stop-Process -Force
New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item $src $exe -Force
$ico = Join-Path $dir 'icon.ico'
Copy-Item (Join-Path $PSScriptRoot '..\src-tauri\icons\icon.ico') $ico -Force
$sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sh.TargetPath = $exe; $sh.WorkingDirectory = $dir; $sh.IconLocation = "$ico,0"; $sh.Description = 'Browse your FL Studio sample packs'
$sh.Save()
Write-Output "Installed to $dir"
