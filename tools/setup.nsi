; One-click installer: no wizard, no admin, installs for the current user and launches the app.
; Plain Start menu shortcut (no AppUserModelID): Start search fails to load icons for shortcuts that carry one.
; Build with: npm run installer
Unicode true
!define NAME "Packs Viewer"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NAME}"
Name "${NAME}"
OutFile "..\build\Packs-Viewer-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\${NAME}"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
SetCompressor /SOLID lzma
Icon "..\build\icon.ico"
UninstallIcon "..\build\icon.ico"

Section
  nsExec::Exec 'taskkill /F /IM "${NAME}.exe"'
  nsExec::Exec 'taskkill /F /IM "packs-viewer.exe"'
  Sleep 300
  SetOutPath "$INSTDIR"
  File "/oname=${NAME}.exe" "..\src-tauri\target\release\packs-viewer.exe"
  File "/oname=icon.ico" "..\src-tauri\icons\icon.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${NAME}.lnk" "$INSTDIR\${NAME}.exe" "" "$INSTDIR\icon.ico" 0
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${NAME}"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "1.1.0"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "${NAME}"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  Exec '"$INSTDIR\${NAME}.exe"'
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM "${NAME}.exe"'
  Sleep 300
  Delete "$SMPROGRAMS\${NAME}.lnk"
  DeleteRegKey HKCU "${UNKEY}"
  RMDir /r "$INSTDIR"
  ; settings, favourites and caches in %APPDATA% are kept
SectionEnd
