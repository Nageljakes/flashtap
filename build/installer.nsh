; FlashTap NSIS customisation — install-time license validation + firewall rule.
; Included by electron-builder (nsis.include).
;
; Flow:
;   customInit              — markers, extract helper scripts, parse /KEY=.
;                             SILENT installs run the license check here (no UI)
;                             and quit with the PS exit code when it fails.
;   customPageAfterChangeDir — interactive installs get a real wizard PAGE
;                             (window visible the whole time) that asks for the
;                             key and runs the same check. The old approach ran
;                             everything inside customInit, BEFORE the wizard
;                             window existed — the user saw nothing for up to
;                             50 s, which looked like a "silent crash".
;   customInstall           — after files are in place, best-effort add a
;                             Windows Firewall rule for FlashTap.exe (one UAC
;                             prompt; declining is fine — the app offers the
;                             fix again on first launch).
;
; Exit codes from ft-license.ps1: 0 ok|3 invalid|4 revoked|5 unreachable|6 error
; Exit codes from ft-firewall.ps1: 0 ok/already|1 declined-or-failed
;
; Registers only — Var declarations trigger unused-var warnings (fatal) in the
; __uninstaller compile pass.
;   $R0 key from /KEY=  $R1 scratch / nsExec output  $R2 1=silent
;   $R3 key textbox hwnd  $R4 status label hwnd  $R5 ps exit code
;   $R6 log file handle
;
; Diagnostics: $TEMP\ft-debug.ini (machine markers) + $TEMP\FlashTap-Setup.log
; (human-readable).

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"

!ifndef LICENSE_SERVER_URL
  !define LICENSE_SERVER_URL "https://tiny.tail5f36c9.ts.net|http://192.168.110.8:3211"
!endif

; ---------------------------------------------------------------------------
; helpers
; ---------------------------------------------------------------------------

!macro ftLog TEXT
  FileOpen $R6 "$TEMP\FlashTap-Setup.log" a
  ${If} $R6 != ""
    FileSeek $R6 0 END
    FileWrite $R6 " FlashTap-Setup: ${TEXT}$\r$\n"
    FileClose $R6
  ${EndIf}
!macroend

!macro ftExtractHelpers
  InitPluginsDir
  File /oname=$PLUGINSDIR\ft-license.ps1  "${BUILD_RESOURCES_DIR}\ft-license.ps1"
  File /oname=$PLUGINSDIR\ft-firewall.ps1 "${BUILD_RESOURCES_DIR}\ft-firewall.ps1"
!macroend

; Runs the headless license check via PowerShell; exit code lands in $R5,
; the console output is popped into $R1 so the stack stays balanced.
!macro ftRunLicenseCheck KEYREG
  nsExec::ExecToStack `powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ft-license.ps1" "${LICENSE_SERVER_URL}" "${KEYREG}"`
  Pop $R5
  Pop $R1
!macroend

!macro ftLicenseFailMsg
  ${If} $R5 = 3
    MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "That license key isn't recognised.$\n$\nFormat: FT-XXXXX-XXXXX-XXXXX — contact the issuer for a valid key."
  ${ElseIf} $R5 = 4
    MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "This license key has been revoked.$\n$\nContact the issuer to have it reinstated."
  ${ElseIf} $R5 = 5
    MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "Could not reach the license server.$\n$\nAn internet connection is needed once during install. Check the connection and try again."
  ${Else}
    MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "License check failed (code $R5).$\n$\nAn internet connection is needed once during install.$\n$\nDetails: $TEMP\FlashTap-Setup.log"
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; customInit — runs before any window exists: keep it light for interactive
; installs, run the full check only for silent ones.
; ---------------------------------------------------------------------------
!macro customInit
  WriteINIStr "$TEMP\ft-debug.ini" steps entered 1
  !insertmacro ftLog "customInit start"
  !insertmacro ftExtractHelpers

  StrCpy $R0 ""
  StrCpy $R2 0
  ${GetOptions} $CMDLINE "/KEY=" $R0

  IfSilent ft_lic_silent ft_lic_done
    ft_lic_silent:
      StrCpy $R2 1
      WriteINIStr "$TEMP\ft-debug.ini" steps silent_mode 1
      ${If} $R0 == ""
        ; silent install with no key — cannot prompt, fail closed
        WriteINIStr "$TEMP\ft-debug.ini" steps silent_no_key 1
        !insertmacro ftLog "ABORT: silent install without /KEY="
        SetErrorLevel 3
        Quit
      ${EndIf}
      !insertmacro ftRunLicenseCheck $R0
      WriteINIStr "$TEMP\ft-debug.ini" steps after_nsexec "rc $R5"
      !insertmacro ftLog "silent license check rc=$R5"
      ${If} $R5 != 0
        SetErrorLevel $R5
        Quit
      ${EndIf}
    ft_lic_done:
!macroend

; ---------------------------------------------------------------------------
; License wizard page (interactive only) — declared between the directory
; page and the install step, while the wizard window is fully visible.
; ---------------------------------------------------------------------------
!macro customPageAfterChangeDir
  Page custom ftLicensePageCreate ftLicensePageLeave

  Function ftLicensePageCreate
    !insertmacro MUI_HEADER_TEXT "FlashTap License" "Enter the license key you were given to install FlashTap."

    ; support marker: proves the custom page was reached
    WriteINIStr "$TEMP\ft-debug.ini" steps license_page_shown 1

    nsDialogs::Create 1018
    Pop $R1

    ${NSD_CreateLabel} 0 0 300u 26u "FlashTap is licensed per venue. Type the key you got from the issuer (format FT-XXXXX-XXXXX-XXXXX).$\nAn internet connection is needed once to verify it."
    Pop $R1

    ${NSD_CreateText} 0 34u 300u 13u ""
    Pop $R3
    ${NSD_SetTextLimit} $R3 20

    ; prefill: /KEY= switch wins, else a key saved by a previous install
    ReadRegStr $R1 HKCU "Software\FlashTap" "LicenseKey"
    ${If} $R0 != ""
      ${NSD_SetText} $R3 $R0
    ${ElseIf} $R1 != ""
      ${NSD_SetText} $R3 $R1
    ${EndIf}

    ${NSD_CreateLabel} 0 56u 300u 16u " "
    Pop $R4

    nsDialogs::Show
  FunctionEnd

  Function ftLicensePageLeave
    ${NSD_GetText} $R3 $R0

    ${If} $R0 == ""
      MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "Please enter your FlashTap license key to continue."
      Abort
    ${EndIf}

    ${NSD_SetText} $R4 "Verifying license key…"
    EnableWindow $HWNDPARENT 0   ; freeze wizard buttons during the check
    !insertmacro ftRunLicenseCheck $R0
    EnableWindow $HWNDPARENT 1

    WriteINIStr "$TEMP\ft-debug.ini" steps page_check_rc "rc $R5"
    !insertmacro ftLog "license page check rc=$R5"

    ${If} $R5 != 0
      !insertmacro ftLicenseFailMsg
      ${NSD_SetText} $R4 "License check failed (code $R5) — try again."
      Abort
    ${EndIf}
  FunctionEnd
!macroend

; ---------------------------------------------------------------------------
; customInstall — files are on disk; add the firewall rule (best effort).
; ---------------------------------------------------------------------------
!macro customInstall
  WriteINIStr "$TEMP\ft-debug.ini" steps firewall_attempt 1
  !insertmacro ftLog "adding firewall rule for $INSTDIR\FlashTap.exe"
  nsExec::ExecToStack `powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ft-firewall.ps1" "$INSTDIR"`
  Pop $R5
  Pop $R1
  WriteINIStr "$TEMP\ft-debug.ini" steps firewall_rc "rc $R5"
  !insertmacro ftLog "firewall rc=$R5 (1 = declined or failed; the app offers the fix on first launch)"
!macroend
