<#
.SYNOPSIS
  Prepares a Windows Server 2022 builder instance to become the desktop UAT EC2
  image (cdktn/'s launch template boots it). The EC2 counterpart of
  ../Install-UatImage.ps1, which prepares the AppStream image for infra/.

.DESCRIPTION
  - Python 3.11 and the harness, private to the image, under C:\Uat
  - the FlaUI MCP server (dist/flaui-mcp-server.zip, from `make flaui-zip`)
  - the boot, run, session and leave scripts the user data and SSM documents call
  - the local autologon account and the scheduled task that runs scenarios in its
    session; its password is set per instance, at boot, by Uat-Boot.ps1
  - RDP on, with Network Level Authentication

  Run as Administrator on the builder, then:

    & "$env:ProgramFiles\Amazon\EC2Launch\EC2Launch.exe" sysprep --shutdown
    aws ec2 create-image --instance-id <builder> --name desktop-uat-<date>
    aws ec2 enable-fast-launch --image-id <ami> --max-parallel-launches 6 \
        --snapshot-configuration TargetResourceCount=5
    aws ssm put-parameter --name /desktop-uat/ami/windows --value <ami> --type String --overwrite

  The launch template resolves the image from that parameter at each launch, so a
  new image needs no Terraform change.

.EXAMPLE
  .\Build-UatEc2Image.ps1 -PythonInstaller C:\staging\python-3.11.9-amd64.exe `
      -HarnessDir C:\staging\desktop-uat\harness -ServerZip C:\staging\flaui-mcp-server.zip
#>
param(
    [Parameter(Mandatory)][string]$PythonInstaller,   # python-3.11.x-amd64.exe, e.g. from Artifactory
    [Parameter(Mandatory)][string]$HarnessDir,        # a checkout's harness/
    [Parameter(Mandatory)][string]$ServerZip,         # dist/flaui-mcp-server.zip
    [string]$PipIndexUrl = ''                         # an internal PyPI mirror, if there is one
)
$ErrorActionPreference = 'Stop'

# Where the user data and the SSM documents call the scripts (cdktn/lib/desktop.ts, UAT_ROOT).
$UatRoot = 'C:\Uat'
Import-Module "$PSScriptRoot\UatEc2.psm1"
$p = Get-UatPaths
if ($p.UatRoot -ne $UatRoot) { throw "UatEc2.psm1 says the scripts live in $($p.UatRoot), not $UatRoot" }

New-Item -ItemType Directory -Force -Path $UatRoot, $p.RunRoot, $p.InstallRoot | Out-Null

# ---------------------------------------------------------------- scripts
foreach ($file in 'UatEc2.psm1', 'Uat-Boot.ps1', 'Uat-Run.ps1', 'Uat-Session.ps1', 'Uat-Leave.ps1') {
    Copy-Item -Path "$PSScriptRoot\$file" -Destination $UatRoot -Force
}

# ---------------------------------------------------------------- Python 3.11 and the harness
$installer = Start-Process -FilePath $PythonInstaller -Wait -PassThru -ArgumentList @(
    '/quiet', 'InstallAllUsers=1', "TargetDir=$UatRoot\python", 'PrependPath=0', 'Include_test=0', 'Include_launcher=0')
if ($installer.ExitCode -ne 0) { throw "Python installer failed: $($installer.ExitCode)" }

Copy-Item -Path $HarnessDir -Destination $p.Harness -Recurse -Force
$pip = @('-m', 'pip', 'install', '--quiet', '--no-warn-script-location', '-r', "$($p.Harness)\requirements.txt")
if ($PipIndexUrl) { $pip += @('--index-url', $PipIndexUrl) }
& $p.Python @pip
if ($LASTEXITCODE -ne 0) { throw "pip install failed: $LASTEXITCODE" }

# ---------------------------------------------------------------- FlaUI MCP server
Expand-Archive -Path $ServerZip -DestinationPath "$UatRoot\flaui" -Force
if (-not (Test-Path $p.FlauiServer)) { throw "$ServerZip has no FlaUiMcpServer.exe" }

# ---------------------------------------------------------------- the autologon account
if (-not (Get-LocalUser -Name $p.RunnerUser -ErrorAction SilentlyContinue)) {
    # A throwaway password: Uat-Boot.ps1 sets a new one on every instance.
    New-LocalUser -Name $p.RunnerUser -Password (ConvertTo-SecureString (New-UatPassword) -AsPlainText -Force) `
        -PasswordNeverExpires -AccountNeverExpires -Description 'Desktop UAT: scripted runs' | Out-Null
}
# It writes runs and installs builds; testers may read and run what it installed.
& icacls.exe $p.RunRoot /grant "$($p.RunnerUser):(OI)(CI)M" | Out-Null
& icacls.exe $p.InstallRoot /grant "$($p.RunnerUser):(OI)(CI)M" /grant 'Users:(OI)(CI)RX' | Out-Null

# ---------------------------------------------------------------- the session task
$task = @{
    TaskName  = $p.TaskName
    Action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File $UatRoot\Uat-Session.ps1"
    # Interactive: it runs in the account's logged-on session, which has a desktop.
    Principal = New-ScheduledTaskPrincipal -UserId $p.RunnerUser -LogonType Interactive -RunLevel Limited
    Settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
    Force     = $true
}
Register-ScheduledTask @task | Out-Null

# ---------------------------------------------------------------- RDP, for testers
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication -Value 1
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'

Write-Output "Ready to sysprep: & `"`$env:ProgramFiles\Amazon\EC2Launch\EC2Launch.exe`" sysprep --shutdown"
