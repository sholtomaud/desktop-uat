# Runs at every boot, as SYSTEM, from the launch template's user data
# (EC2Launch v2, <persist>true</persist>).
#
# First boot: set up the autologon session the scripted runs use, join the
# domain, restart. Every boot after: let the tester group RDP in, and mark the
# instance ready. Every boot: schedule the shutdown at the instance's expiry,
# which terminates it (the launch template's shutdown behaviour).
param(
    [Parameter(Mandatory)][string]$ConfigParameter
)
$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot\UatEc2.psm1"
$p = Get-UatPaths
New-Item -ItemType Directory -Force -Path $p.RunRoot | Out-Null
Start-Transcript -Append -Path "$($p.RunRoot)\boot.log" | Out-Null

# The lifetime first, so that whatever fails below, the instance still goes.
$left = Get-UatSecondsLeft -ExpiresAt (Get-UatExpiresAt) -Now ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
& shutdown.exe /a 2>$null | Out-Null
& shutdown.exe /s /t $left /d p:0:0 /c 'desktop-uat: instance lifetime reached'
Write-Output "Shutting down (and so terminating) in $left s"

$region = Get-UatMetadata -Path 'placement/region'
$config = Read-UatConfig -Json (Get-SSMParameter -Name $ConfigParameter -Region $region).Value
# Uat-Run.ps1 and Uat-Leave.ps1 read it from here.
$config | ConvertTo-Json | Set-Content -Path $p.Config

if (-not (Get-CimInstance Win32_ComputerSystem).PartOfDomain) {
    $name = Get-UatComputerName -InstanceId (Get-UatMetadata -Path 'instance-id')

    # The scripted runs' desktop: a local account that logs on at boot. Its password
    # is new on every instance. Winlogon keeps it readable by administrators only;
    # testers are not administrators.
    $password = New-UatPassword
    Set-LocalUser -Name $p.RunnerUser -Password (ConvertTo-SecureString $password -AsPlainText -Force)
    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    Set-ItemProperty -Path $winlogon -Name AutoAdminLogon -Value '1'
    Set-ItemProperty -Path $winlogon -Name DefaultUserName -Value $p.RunnerUser
    Set-ItemProperty -Path $winlogon -Name DefaultDomainName -Value $name   # a local account, on the new name
    Set-ItemProperty -Path $winlogon -Name DefaultPassword -Value $password

    $secret = (Get-SECSecretValue -SecretId $config.JoinSecretId -Region $config.Region).SecretString | ConvertFrom-Json
    $credential = New-Object System.Management.Automation.PSCredential(
        $secret.username, (ConvertTo-SecureString $secret.password -AsPlainText -Force))
    Write-Output "Joining $($config.Domain) as $name, in $($config.JoinOu)"
    Stop-Transcript | Out-Null
    Add-Computer -DomainName $config.Domain -OUPath $config.JoinOu -NewName $name -Credential $credential -Force -Restart
    return
}

# Testers RDP in with their own AD accounts.
$group = "$($config.Domain)\$($config.TesterGroup)"
try {
    Add-LocalGroupMember -Group 'Remote Desktop Users' -Member $group
    Write-Output "$group may RDP in"
} catch [Microsoft.PowerShell.Commands.MemberExistsException] {
    Write-Output "$group may already RDP in"
}

Set-Content -Path $p.Ready -Value (Get-Date -Format o)
Write-Output 'Ready'
Stop-Transcript | Out-Null
