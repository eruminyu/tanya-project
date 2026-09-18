# Windows Sandbox 안에서만 실행하는 실제 NSIS 설치/복구/업데이트/제거 검증이다.
# 호스트에서 직접 실행하면 제품 경로·레지스트리·설치본을 읽기 전에 종료한다.
$ErrorActionPreference = 'Stop'
if ([Environment]::UserName -ne 'WDAGUtilityAccount' -or
    $env:USERPROFILE -ne 'C:\Users\WDAGUtilityAccount' -or
    $PSScriptRoot -ne 'C:\KirianSandboxInput') {
    throw '이 검증은 준비된 Windows Sandbox 안에서만 실행할 수 있습니다.'
}

$outputDirectory = 'C:\KirianSandboxOutput'
$installDirectory = Join-Path $env:LOCALAPPDATA 'Programs\Kirian'
$userDataDirectory = Join-Path $env:APPDATA 'Kirian'
$currentInstaller = 'C:\KirianSandboxInput\current.exe'
$upgradeInstaller = 'C:\KirianSandboxInput\upgrade.exe'
$phaseResults = [System.Collections.Generic.List[string]]::new()
$brainProcess = $null
$report = [ordered]@{ passed = $false; phases = @(); upgradeIncluded = (Test-Path -LiteralPath $upgradeInstaller); error = $null }
$testStartedAt = Get-Date

function Assert-Condition($condition, [string]$message) {
    if (-not $condition) { throw $message }
}

function Invoke-Installer([string]$installer) {
    $process = Start-Process -FilePath $installer -ArgumentList '/S','/currentuser' -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(120000)) { $process.Kill(); throw '설치 시간 초과' }
    Assert-Condition ($process.ExitCode -eq 0) "설치 실패: $($process.ExitCode)"
    Assert-Condition (Test-Path -LiteralPath (Join-Path $installDirectory 'Kirian.exe')) 'Kirian.exe 누락'
    Assert-Condition (Test-Path -LiteralPath (Join-Path $installDirectory 'resources\brain\kirian-brain.exe')) 'Brain 누락'
}

function Get-ProfileFingerprint {
    $entries = Get-ChildItem -LiteralPath $userDataDirectory -File -Recurse | Sort-Object FullName
    return (($entries | ForEach-Object {
        $_.FullName.Substring($userDataDirectory.Length) + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }) -join "`n")
}

function Assert-DataUnchanged([string]$before) {
    Assert-Condition ((Get-ProfileFingerprint) -eq $before) '설치/제거가 사용자 자료를 변경했습니다.'
}

function Open-Brain {
    $bytes = [byte[]]::new(32)
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $token = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = Join-Path $installDirectory 'resources\brain\kirian-brain.exe'
    $info.WorkingDirectory = $env:TEMP
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables['KIRIAN_V1_DATA_DIR'] = Join-Path $userDataDirectory 'brain'
    # .NET Framework는 Process.Start의 AutoFlush 설정 때도 stdin BOM을 쓸 수 있다.
    $previousInputEncoding = [Console]::InputEncoding
    try {
        [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
        $process = [Diagnostics.Process]::Start($info)
    } finally {
        [Console]::InputEncoding = $previousInputEncoding
    }
    try {
        # Windows PowerShell 5.1의 기본 StreamWriter는 UTF-8 BOM을 앞에 붙일 수 있다.
        # 실제 Electron과 같은 BOM 없는 JSON 한 줄을 파이프에 직접 보낸다.
        $handshake = [Text.Encoding]::UTF8.GetBytes((@{ token = $token } | ConvertTo-Json -Compress) + "`n")
        $process.StandardInput.BaseStream.Write($handshake, 0, $handshake.Length)
        $process.StandardInput.BaseStream.Flush()
        $readyTask = $process.StandardOutput.ReadLineAsync()
        if (-not $readyTask.Wait(30000)) { throw 'Brain 준비 시간 초과' }
        if ([string]::IsNullOrWhiteSpace($readyTask.Result)) {
            if ($process.WaitForExit(5000)) { throw "Brain 준비 전 종료: $($process.ExitCode), $($process.StandardError.ReadToEnd().Trim())" }
            throw 'Brain ready 응답 없이 stdout 종료'
        }
        $ready = $readyTask.Result | ConvertFrom-Json
        Assert-Condition ($ready.type -eq 'ready' -and $ready.port -gt 0 -and $ready.port -lt 65536) 'Brain ready 오류'
        return @{ process = $process; url = "http://127.0.0.1:$($ready.port)"; headers = @{ Authorization = "Bearer $token" } }
    } catch {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit(5000) | Out-Null }
        $process.Dispose()
        throw
    }
}

function Close-Brain($brain) {
    $brain.process.StandardInput.BaseStream.Close()
    if (-not $brain.process.WaitForExit(15000)) { $brain.process.Kill(); throw 'Brain EOF 종료 시간 초과' }
    Assert-Condition ($brain.process.ExitCode -eq 0) 'Brain 정상 종료 실패'
    Assert-Condition ($brain.process.StandardError.ReadToEnd() -eq '') 'Brain stderr 노출'
    Assert-Condition ($brain.process.StandardOutput.ReadToEnd() -eq '') 'Brain 추가 stdout 노출'
    $brain.process.Dispose()
}

function Read-Fixture($brain, [string]$sourceId) {
    $result = Invoke-RestMethod -Uri ($brain.url + '/v1/sources') -Headers $brain.headers -TimeoutSec 10
    $found = @($result.sources | Where-Object { $_.record.source_id -eq $sourceId })
    Assert-Condition ($found.Count -eq 1) '재설치 뒤 실제 SQLite 자료 누락'
}

try {
    'started' | Set-Content -LiteralPath (Join-Path $outputDirectory 'started.txt') -Encoding UTF8
    Invoke-Installer $currentInstaller
    $phaseResults.Add('현재 사용자 설치 성공')
    Assert-Condition (Test-Path -LiteralPath (Join-Path $env:USERPROFILE 'Desktop\Kirian.lnk')) '바탕화면 바로가기 누락'
    Assert-Condition (Test-Path -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Kirian.lnk')) '시작 메뉴 바로가기 누락'
    $initialVersion = (Get-Item -LiteralPath (Join-Path $installDirectory 'Kirian.exe')).VersionInfo.ProductVersion
    Assert-Condition ($initialVersion -like '0.1.0*') '현재 설치본 앱 메타데이터 오류'
    $brainProcess = Open-Brain
    $configuration = Invoke-RestMethod -Uri ($brainProcess.url + '/v1/config') -Headers $brainProcess.headers -TimeoutSec 10
    Assert-Condition ($configuration.persistence -eq $true) '영속 Brain 설정 오류'
    $body = @{ title = 'Sandbox fixture'; text = 'sandbox-persistent-fixture'; kind = 'note'; boundary = 'local'; parents = @() } | ConvertTo-Json -Compress
    $source = Invoke-RestMethod -Uri ($brainProcess.url + '/v1/sources') -Method Post -Headers $brainProcess.headers -ContentType 'application/json' -Body $body -TimeoutSec 10
    $sourceId = $source.source.record.source_id
    Close-Brain $brainProcess
    $brainProcess = $null
    [IO.File]::WriteAllText((Join-Path $userDataDirectory 'sandbox-sentinel.txt'), 'installer-must-preserve-userdata')
    $fingerprint = Get-ProfileFingerprint

    foreach ($forbidden in @($userDataDirectory, $env:APPDATA, (Join-Path $userDataDirectory 'nested'))) {
        $rejected = Start-Process -FilePath $currentInstaller -ArgumentList '/S','/currentuser',"/D=$forbidden" -PassThru -WindowStyle Hidden
        if (-not $rejected.WaitForExit(30000)) { $rejected.Kill(); throw '잘못된 설치 경로 거절 시간 초과' }
        Assert-Condition ($rejected.ExitCode -eq 2) 'appData 설치 경로를 거절하지 않았습니다.'
        Assert-DataUnchanged $fingerprint
    }
    $phaseResults.Add('appData·상위·하위 /D 설치 거절·자료 보존 성공')

    $installationKeys = @(Get-ChildItem -LiteralPath 'HKCU:\Software' | ForEach-Object {
        Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    } | Where-Object { $_.InstallLocation -eq $installDirectory })
    Assert-Condition ($installationKeys.Count -eq 1) '현재 사용자 설치 레지스트리 식별 실패'
    $installationKey = $installationKeys[0].PSPath
    foreach ($forbidden in @($userDataDirectory, $env:APPDATA, (Join-Path $userDataDirectory 'nested'))) {
        try {
            Set-ItemProperty -LiteralPath $installationKey -Name InstallLocation -Value $forbidden
            $rejected = Start-Process -FilePath $currentInstaller -ArgumentList '/S','/currentuser' -PassThru -WindowStyle Hidden
            if (-not $rejected.WaitForExit(30000)) { $rejected.Kill(); throw '기존 설치 경로 거절 시간 초과' }
            Assert-Condition ($rejected.ExitCode -eq 2) '레지스트리의 appData 설치 경로를 거절하지 않았습니다.'
            Assert-DataUnchanged $fingerprint
        } finally {
            Set-ItemProperty -LiteralPath $installationKey -Name InstallLocation -Value $installDirectory
        }
    }
    $phaseResults.Add('기존 레지스트리의 appData 중첩 설치 경로 거절 성공')

    $unsafeLink = [IO.Path]::GetFullPath((Join-Path $installDirectory 'sandbox-unsafe-link'))
    Assert-Condition ($unsafeLink.StartsWith([IO.Path]::GetFullPath($installDirectory) + '\')) 'junction 검증 경로 오류'
    try {
        New-Item -ItemType Junction -Path $unsafeLink -Target $userDataDirectory | Out-Null
        $rejected = Start-Process -FilePath $currentInstaller -ArgumentList '/S','/currentuser' -PassThru -WindowStyle Hidden
        if (-not $rejected.WaitForExit(30000)) { $rejected.Kill(); throw '설치 내부 junction 거절 시간 초과' }
        Assert-Condition ($rejected.ExitCode -eq 2) '설치 트리의 junction을 거절하지 않았습니다.'
        Assert-DataUnchanged $fingerprint
    } finally {
        # 비재귀 RemoveDirectory로 링크 자체만 제거한다. 대상 자료는 열지 않는다.
        if (Test-Path -LiteralPath $unsafeLink) { [IO.Directory]::Delete($unsafeLink) }
    }
    $phaseResults.Add('설치 내부 junction 대상에 접근하지 않고 거절 성공')

    $damagedFile = [IO.Path]::GetFullPath((Join-Path $installDirectory 'resources\brain\_internal\base_library.zip'))
    Assert-Condition ($damagedFile.StartsWith([IO.Path]::GetFullPath($installDirectory) + '\')) '손상 검증 경로 오류'
    Remove-Item -LiteralPath $damagedFile
    Invoke-Installer $currentInstaller
    Assert-Condition (Test-Path -LiteralPath $damagedFile) '같은 버전 재설치가 손상 파일을 복구하지 못했습니다.'
    Assert-DataUnchanged $fingerprint
    $brainProcess = Open-Brain
    Read-Fixture $brainProcess $sourceId
    Close-Brain $brainProcess
    $brainProcess = $null
    $phaseResults.Add('같은 버전 재설치·손상 파일 복구·SQLite 자료 보존 성공')
    $finalInstaller = $currentInstaller

    if (Test-Path -LiteralPath $upgradeInstaller) {
        $fingerprint = Get-ProfileFingerprint
        Invoke-Installer $upgradeInstaller
        $newVersion = (Get-Item -LiteralPath (Join-Path $installDirectory 'Kirian.exe')).VersionInfo.ProductVersion
        Assert-Condition ([version]($newVersion -split '-')[0] -gt [version]($initialVersion -split '-')[0]) '새 버전 업데이트 메타데이터 오류'
        Assert-DataUnchanged $fingerprint
        $brainProcess = Open-Brain
        Read-Fixture $brainProcess $sourceId
        Close-Brain $brainProcess
        $brainProcess = $null
        $finalInstaller = $upgradeInstaller
        $phaseResults.Add('테스트용 새 버전 업데이트·SQLite 자료 보존 성공')
    }

    $fingerprint = Get-ProfileFingerprint
    $uninstaller = [IO.Path]::GetFullPath((Join-Path $installDirectory 'Uninstall Kirian.exe'))
    Assert-Condition ($uninstaller.StartsWith([IO.Path]::GetFullPath($installDirectory) + '\')) '제거 검증 경로 오류'
    $process = Start-Process -FilePath $uninstaller -ArgumentList '/S','/currentuser',"_?=$installDirectory" -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(120000)) { $process.Kill(); throw '제거 시간 초과' }
    Assert-Condition ($process.ExitCode -eq 0) '제거 실패'
    Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $installDirectory 'Kirian.exe'))) '제거 뒤 앱 파일 잔존'
    Assert-DataUnchanged $fingerprint
    $phaseResults.Add('제거·appData 바이트 보존 성공')
    Invoke-Installer $finalInstaller
    Assert-DataUnchanged $fingerprint
    $brainProcess = Open-Brain
    Read-Fixture $brainProcess $sourceId
    Close-Brain $brainProcess
    $brainProcess = $null
    $phaseResults.Add('제거 후 재설치·SQLite 자료 복원 성공')
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
    # 실패 원인만 결과 공유 폴더에 남긴다. 게스트 보안 정책은 변경하지 않는다.
    $_ | Format-List * -Force | Out-String | Set-Content -LiteralPath (Join-Path $outputDirectory 'error.txt') -Encoding UTF8
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; StartTime = $testStartedAt } -ErrorAction Stop |
            Select-Object -First 30 TimeCreated, Id, Message)
        $events | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $outputDirectory 'code-integrity.json') -Encoding UTF8
    } catch {
        # 진단 로그를 읽지 못해도 원래 실패 결과는 보존한다.
    }
} finally {
    if ($null -ne $brainProcess -and -not $brainProcess.process.HasExited) { $brainProcess.process.Kill() }
    $report.phases = $phaseResults.ToArray()
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputDirectory 'result.json') -Encoding UTF8
}
