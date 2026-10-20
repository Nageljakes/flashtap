; FlashTap NSIS customisation — install-time license validation.
; Included by electron-builder (nsis.include). Valid key required to install.
; Exit codes from ft-license.ps1: 0 ok|2 cancelled|3 invalid|4 revoked|5 unreachable|6 error

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef LICENSE_SERVER_URL
  !define LICENSE_SERVER_URL "https://tiny.tail5f36c9.ts.net|http://192.168.110.8:3211"
!endif

Var FT_KEY
Var FT_RC

!macro ftLicenseCheck
  File /oname=$PLUGINSDIR\ft-license.ps1 "${BUILD_RESOURCES_DIR}\ft-license.ps1"
  StrCpy $FT_KEY ""
  ${GetOptions} $CMDLINE "/KEY=" $FT_KEY
  nsExec::ExecToStack `powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ft-license.ps1" "${LICENSE_SERVER_URL}" "$FT_KEY"`
  Pop $FT_RC
  ${If} $FT_RC != 0
    ${If} $FT_RC = 3
      MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "FlashTap Setup stopped:$\n$\nThat license key isn't recognised.$\n$\nFormat: FT-XXXXX-XXXXX-XXXXX — contact the issuer for a valid key."
    ${ElseIf} $FT_RC = 4
      MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "FlashTap Setup stopped:$\n$\nThis license key has been revoked."
    ${ElseIf} $FT_RC = 5
      MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "FlashTap Setup stopped:$\n$\nCould not reach the license server.$\n$\nAn internet connection is required once during install."
    ${ElseIf} $FT_RC = 2
      ; user cancelled the prompt — nothing to say
    ${Else}
      MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "FlashTap Setup stopped:$\n$\nLicense check failed (code $FT_RC).$\n$\nConnect to the internet and try again."
    ${EndIf}
    Abort
  ${EndIf}
!macroend

!macro customInit
  !insertmacro ftLicenseCheck
!macroend
