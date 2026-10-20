; FlashTap NSIS customisation — install-time license validation.
; Included by electron-builder (nsis.include). Valid key required to install.
; Exit codes from ft-license.ps1: 0 ok|2 cancelled|3 invalid|4 revoked|5 unreachable|6 error
; Registers only — Var declarations trigger unused-var warnings (fatal) in the
; __uninstaller compile pass.
; $R0 = powershell exit code / key from /KEY=, $R2 = 1 when silent install.

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef LICENSE_SERVER_URL
  !define LICENSE_SERVER_URL "https://tiny.tail5f36c9.ts.net|http://192.168.110.8:3211"
!endif

!macro ftLicenseCheck
  ; support marker: proves customInit ran (absent = it never did)
  WriteINIStr "$TEMP\ft-debug.ini" steps entered 1
  File /oname=$PLUGINSDIR\ft-license.ps1 "${BUILD_RESOURCES_DIR}\ft-license.ps1"
  StrCpy $R0 ""
  StrCpy $R2 0
  ${GetOptions} $CMDLINE "/KEY=" $R0
  IfSilent ft_lic_silent ft_lic_check
    ft_lic_silent:
      StrCpy $R2 1
      ${If} $R0 == ""
        ; silent install with no key — cannot prompt, fail closed
        WriteINIStr "$TEMP\ft-debug.ini" steps silent_no_key 1
        Abort
      ${EndIf}
    ft_lic_check:
  nsExec::ExecToStack `powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ft-license.ps1" "${LICENSE_SERVER_URL}" "$R0"`
  Pop $R0
  ; support marker: the license-check exit code (for remote debugging)
  WriteINIStr "$TEMP\ft-debug.ini" steps after_nsexec "rc $R0"
  ${If} $R0 != 0
    ${If} $R2 = 0
      ${If} $R0 = 3
        MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "FlashTap Setup stopped:$\n$\nThat license key isn't recognised.$\n$\nFormat: FT-XXXXX-XXXXX-XXXXX — contact the issuer for a valid key."
      ${ElseIf} $R0 = 4
        MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "FlashTap Setup stopped:$\n$\nThis license key has been revoked."
      ${ElseIf} $R0 = 5
        MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "FlashTap Setup stopped:$\n$\nCould not reach the license server.$\n$\nAn internet connection is required once during install."
      ${ElseIf} $R0 = 2
        ; user cancelled the prompt — nothing to say
      ${Else}
        MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "FlashTap Setup stopped:$\n$\nLicense check failed (code $R0).$\n$\nConnect to the internet and try again."
      ${EndIf}
    ${EndIf}
    Abort
  ${EndIf}
!macroend

!macro customInit
  !insertmacro ftLicenseCheck
!macroend
