# What the EC2 image's scripts share: where things are, and the decisions they
# make. The decisions are plain functions, tested by Pester in tests/; the
# scripts around them only do the I/O.

$Script:UatRoot = 'C:\Uat'              # scripts, Python, the harness, the FlaUI server (Build-UatEc2Image.ps1)
$Script:RunRoot = 'C:\UatRun'           # per-instance state: config, ready marker, runs
$Script:InstallRoot = 'C:\UatInstall'   # the build under test, machine-wide
$Script:RunnerUser = 'uatrunner'        # local account whose autologon session runs scenarios
$Script:TaskName = 'DesktopUat-Session' # scheduled task that runs Uat-Session.ps1 in that session
$Script:ExpiresTag = 'desktop-uat-expires-at'

$Script:DefaultLifetimeSeconds = 4 * 3600
$Script:MaxLifetimeSeconds = 24 * 3600

function Get-UatPaths {
    [pscustomobject]@{
        UatRoot = $Script:UatRoot; RunRoot = $Script:RunRoot; InstallRoot = $Script:InstallRoot
        RunnerUser = $Script:RunnerUser; TaskName = $Script:TaskName
        Config = Join-Path $Script:RunRoot 'config.json'
        Ready = Join-Path $Script:RunRoot 'ready'
        Current = Join-Path $Script:RunRoot 'current.txt'
        Python = Join-Path $Script:UatRoot 'python\python.exe'
        Harness = Join-Path $Script:UatRoot 'harness'
        FlauiServer = Join-Path $Script:UatRoot 'flaui\FlaUiMcpServer.exe'
    }
}

# NetBIOS names are at most 15 characters. Instance ids end in 17 hex digits;
# the last 11 are unique enough among one OU's live instances.
function Get-UatComputerName {
    param([Parameter(Mandatory)][string]$InstanceId)
    if ($InstanceId -notmatch '^i-[0-9a-f]{8,17}$') { throw "Not an instance id: $InstanceId" }
    $hex = $InstanceId.Substring(2)
    'UAT-' + $hex.Substring([Math]::Max(0, $hex.Length - 11)).ToUpperInvariant()
}

# The settings Terraform writes to the config parameter (cdktn/lib/desktop.ts).
function Read-UatConfig {
    param([Parameter(Mandatory)][string]$Json)
    $config = $Json | ConvertFrom-Json
    foreach ($key in 'Domain', 'JoinOu', 'JoinSecretId', 'TesterGroup', 'Bucket', 'Region') {
        if ([string]::IsNullOrWhiteSpace($config.$key)) { throw "The config parameter has no $key" }
    }
    $config
}

# Seconds until the instance must shut down (and so terminate). ec2-uat.sh tags
# the instance with an absolute expiry, so a reboot never extends its life; an
# instance with no readable expiry still goes, after the default lifetime.
function Get-UatSecondsLeft {
    param($ExpiresAt, [Parameter(Mandatory)][long]$Now)
    $expires = 0L
    if (-not [long]::TryParse([string]$ExpiresAt, [ref]$expires)) { return $Script:DefaultLifetimeSeconds }
    [long][Math]::Min($Script:MaxLifetimeSeconds, [Math]::Max(0, $expires - $Now))
}

# An instance tag, through IMDSv2 (the launch template enables tags in metadata).
function Get-UatInstanceTag {
    param([Parameter(Mandatory)][string]$Key)
    $token = Invoke-RestMethod -Method Put -Uri 'http://169.254.169.254/latest/api/token' `
        -Headers @{ 'X-aws-ec2-metadata-token-ttl-seconds' = '60' }
    try {
        Invoke-RestMethod -Uri "http://169.254.169.254/latest/meta-data/tags/instance/$Key" `
            -Headers @{ 'X-aws-ec2-metadata-token' = $token }
    } catch { $null }
}

function Get-UatMetadata {
    param([Parameter(Mandatory)][string]$Path)
    $token = Invoke-RestMethod -Method Put -Uri 'http://169.254.169.254/latest/api/token' `
        -Headers @{ 'X-aws-ec2-metadata-token-ttl-seconds' = '60' }
    Invoke-RestMethod -Uri "http://169.254.169.254/latest/meta-data/$Path" -Headers @{ 'X-aws-ec2-metadata-token' = $token }
}

function Get-UatExpiresAt { Get-UatInstanceTag -Key $Script:ExpiresTag }

# The autologon account's password: new on every instance, never stored outside it.
function New-UatPassword {
    $sets = 'ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%+-.:=?@_'
    $all = -join $sets
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $pick = {
        param([string]$from)
        $b = [byte[]]::new(4); $rng.GetBytes($b)
        $from[[BitConverter]::ToUInt32($b, 0) % $from.Length]
    }
    $chars = @($sets | ForEach-Object { & $pick $_ }) + @(1..28 | ForEach-Object { & $pick $all })
    # Shuffle, so the guaranteed characters are not always first.
    -join ($chars | Sort-Object { $b = [byte[]]::new(4); $rng.GetBytes($b); [BitConverter]::ToUInt32($b, 0) })
}

# The command line for one walkthrough run (harness/uat_harness/cli.py, `local`).
function New-UatHarnessArgs {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)][string]$Scenarios,
        [Parameter(Mandatory)][string]$Out
    )
    $paths = Get-UatPaths
    $a = @(
        '-m', 'uat_harness.cli', 'local',
        '--scenarios', $Scenarios,
        '--flaui-server', $paths.FlauiServer,
        # The build comes from its presigned URL; install_build may fetch from that host only.
        '--allowed-hosts', ([uri]$Request.BuildUrl).Host,
        '--build-url', $Request.BuildUrl,
        '--build-sha256', $Request.BuildSha256,
        '--state-root', $Request.StateRoot,
        # Machine-wide: testers RDP in as themselves, not as the autologon account.
        '--install-root', $paths.InstallRoot,
        '--run-id', $Request.RunId,
        '--git-ref', $Request.GitRef,
        '--git-sha', $Request.GitSha,
        '--out', $Out
    )
    if ($Request.Tags) { $a += @('--tags', $Request.Tags) }
    $a
}

function Wait-UatFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (-not (Test-Path $Path)) {
        if ((Get-Date) -gt $deadline) { throw "Timed out after ${TimeoutSeconds}s waiting for $Path" }
        Start-Sleep -Seconds 5
    }
}

Export-ModuleMember -Function Get-UatPaths, Get-UatComputerName, Read-UatConfig, Get-UatSecondsLeft,
    Get-UatInstanceTag, Get-UatMetadata, Get-UatExpiresAt, New-UatPassword, New-UatHarnessArgs, Wait-UatFile
