# 설치/재설치는 현재 사용자 범위로 제한한다. appData는 설치 경로와 분리한다.
!include LogicLib.nsh
!include FileFunc.nsh

# Kirian uses its own installation identity and profile; legacy profiles are not migrated.

!ifdef BUILD_UNINSTALLER
  !define KIRIAN_REPARSE_GUARD "un.kirianRejectReparseAncestors"
  !define KIRIAN_TREE_GUARD "un.kirianRejectReparseTree"
!else
  !define KIRIAN_REPARSE_GUARD "kirianRejectReparseAncestors"
  !define KIRIAN_TREE_GUARD "kirianRejectReparseTree"
!endif

Function "${KIRIAN_REPARSE_GUARD}"
  Pop $0
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
    ${If} $1 != -1
      IntOp $2 $1 & 0x400
      ${If} $2 != 0
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
    ${GetParent} "$0" $1
    ${If} $1 == ""
    ${OrIf} $1 == $0
      ${ExitDo}
    ${EndIf}
    StrCpy $0 $1
  ${Loop}
FunctionEnd

Function "${KIRIAN_TREE_GUARD}"
  Pop $0
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r3'
  ${If} $3 == -1
    Return
  ${EndIf}
  IntOp $4 $3 & 0x400
  ${If} $4 != 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  ClearErrors
  FindFirst $1 $2 "$0\*"
  ${If} ${Errors}
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${DoWhile} $2 != ""
    ${If} $2 != "."
    ${AndIf} $2 != ".."
      StrCpy $3 "$0\$2"
      System::Call 'kernel32::GetFileAttributesW(w r3) i.r4'
      ${If} $4 == -1
        SetErrorLevel 2
        Quit
      ${EndIf}
      IntOp $5 $4 & 0x400
      ${If} $5 != 0
        # 링크의 대상을 열거나 따라가기 전에 중단한다.
        SetErrorLevel 2
        Quit
      ${EndIf}
      IntOp $5 $4 & 0x10
      ${If} $5 != 0
        Push $0
        Push $1
        Push $2
        Push $3
        Call "${KIRIAN_TREE_GUARD}"
        Pop $2
        Pop $1
        Pop $0
      ${EndIf}
    ${EndIf}
    FindNext $1 $2
  ${Loop}
  FindClose $1
FunctionEnd

!macro customInstallMode
  StrCpy $isForceMachineInstall "0"
  StrCpy $isForceCurrentInstall "1"
!macroend

# 명시적 allusers 플래그도 거절하여 assisted/silent 양쪽 정책을 일치시킨다.
!macro preInit
  ${If} ${isForAllUsers}
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro GetDParameter $R0
  ${If} $R0 != ""
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro rejectUserDataOverlap
  # NSIS GetFullPathName은 아직 없는 폴더에 빈 문자열을 반환할 수 있다.
  # Win32 정규화는 첫 설치의 미생성 경로도 해석한다.
  Push $0
  Push $1
  Push $2
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i.r2'
  ${If} $2 == 0
  ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $R0 $0
  System::Call 'kernel32::GetFullPathNameW(w "$APPDATA\Kirian", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r2'
  ${If} $2 == 0
  ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $R1 $1
  System::Call 'kernel32::GetFullPathNameW(w "$LOCALAPPDATA\Programs\Kirian", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r2'
  ${If} $2 == 0
  ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $R4 $1
  Pop $2
  Pop $1
  Pop $0
  # 끝 구분자를 제거하고 경계 포함 비교한다.
  ${Do}
    StrCpy $R2 $R0 1 -1
    ${If} $R2 != "\"
      ${ExitDo}
    ${EndIf}
    StrCpy $R0 $R0 -1
  ${Loop}
  ${Do}
    StrCpy $R2 $R1 1 -1
    ${If} $R2 != "\"
      ${ExitDo}
    ${EndIf}
    StrCpy $R1 $R1 -1
  ${Loop}
  # 고정된 기본 위치만 지원한다. 기존의 다른 설치 위치를 임의로 이동하지 않는다.
  # 8.3 별칭·임의 registry 위치도 정확한 기본 full path와 다르면 거절한다.
  ${If} $R0 != $R4
    SetErrorLevel 2
    Quit
  ${EndIf}
  Push $R0
  Call "${KIRIAN_REPARSE_GUARD}"
  Push $R1
  Call "${KIRIAN_REPARSE_GUARD}"
  StrCpy $R0 "$R0\"
  StrCpy $R1 "$R1\"
  StrLen $R2 $R0
  StrCpy $R3 $R1 $R2
  ${If} $R0 == $R3
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrLen $R2 $R1
  StrCpy $R3 $R0 $R2
  ${If} $R1 == $R3
    SetErrorLevel 2
    Quit
  ${EndIf}
  Push $R0
  Call "${KIRIAN_TREE_GUARD}"
!macroend

!macro customInit
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
  !insertmacro rejectUserDataOverlap
!macroend

!macro customUnInit
  ${If} $installMode != "CurrentUser"
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro rejectUserDataOverlap
!macroend
