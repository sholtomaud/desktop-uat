# One scripted UAT run, sent by scripts/ec2-uat.sh through the run document
# (cdktn/lib/documents.ts). Runs as SYSTEM.
#
# The app needs a desktop, and SYSTEM's session 0 has none. So this hands the run
# to the autologon session's scheduled task (Uat-Session.ps1), waits for it, and
# uploads the reports with the instance role. Its exit code is the harness's.
param(
    [Parameter(Mandatory)][string]$RunId,
    [Parameter(Mandatory)][string]$BuildUrl,
    [Parameter(Mandatory)][string]$BuildSha256,
    [Parameter(Mandatory)][string]$ScenariosUrl,
    [string]$Tags = '',
    [Parameter(Mandatory)][string]$StateRoot,
    [string]$GitRef = '',
    [string]$GitSha = ''
)
$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot\UatEc2.psm1"
$p = Get-UatPaths

# A fresh instance may still be joining the domain and logging on.
Wait-UatFile -Path $p.Ready -TimeoutSeconds 1200
$config = Get-Content -Path $p.Config -Raw | ConvertFrom-Json

$dir = "$($p.RunRoot)\runs\$RunId"
if (Test-Path $dir) { throw "Run $RunId has already run on this instance" }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
[pscustomobject]@{
    RunId = $RunId; BuildUrl = $BuildUrl; BuildSha256 = $BuildSha256; ScenariosUrl = $ScenariosUrl
    Tags = $Tags; StateRoot = $StateRoot; GitRef = $GitRef; GitSha = $GitSha
} | ConvertTo-Json | Set-Content -Path "$dir\request.json"
Set-Content -Path $p.Current -Value $dir

Start-ScheduledTask -TaskName $p.TaskName
$done = "$dir\done.json"
try {
    # Within the run document's 7200 s.
    Wait-UatFile -Path $done -TimeoutSeconds 6900
} finally {
    # Whatever happened, what there is goes to S3: a failed run's log matters most.
    if (Test-Path "$dir\reports") {
        Write-S3Object -BucketName $config.Bucket -KeyPrefix "runs/$RunId/" -Folder "$dir\reports" -Recurse -Region $config.Region
    }
    foreach ($log in 'session.log', 'harness.log') {
        if (Test-Path "$dir\$log") {
            Write-S3Object -BucketName $config.Bucket -Key "runs/$RunId/$log" -File "$dir\$log" -Region $config.Region
        }
    }
}

$result = Get-Content -Path $done -Raw | ConvertFrom-Json
Write-Output "Run $RunId finished: harness exit code $($result.ExitCode); reports in s3://$($config.Bucket)/runs/$RunId/"
exit $result.ExitCode
