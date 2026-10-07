# Runs in the autologon session, the desktop the app needs: the DesktopUat-Session
# scheduled task, started by Uat-Run.ps1. Fetches the scenarios, runs the
# harness in walkthrough mode, and writes done.json with its exit code, which
# Uat-Run.ps1 is waiting for.
$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot\UatEc2.psm1"
$p = Get-UatPaths
$dir = (Get-Content -Path $p.Current -Raw).Trim()
$code = 2
Start-Transcript -Path "$dir\session.log" | Out-Null
try {
    $request = Get-Content -Path "$dir\request.json" -Raw | ConvertFrom-Json

    Invoke-WebRequest -Uri $request.ScenariosUrl -OutFile "$dir\scenarios.zip" -UseBasicParsing
    Expand-Archive -Path "$dir\scenarios.zip" -DestinationPath "$dir\scenarios"

    $harnessArgs = New-UatHarnessArgs -Request $request -Scenarios "$dir\scenarios" -Out "$dir\reports"
    Push-Location $p.Harness
    try {
        # A native command's stderr is not an error here: the harness logs to it.
        $ErrorActionPreference = 'Continue'
        & $p.Python @harnessArgs *>&1 | Out-File -FilePath "$dir\harness.log" -Encoding utf8
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = 'Stop'
        Pop-Location
    }
} catch {
    Write-Output "Session failed before the harness finished: $_"
} finally {
    Stop-Transcript | Out-Null
    [pscustomobject]@{ ExitCode = $code } | ConvertTo-Json | Set-Content -Path "$dir\done.json"
}
