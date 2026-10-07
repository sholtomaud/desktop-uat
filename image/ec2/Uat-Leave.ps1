# Sent by scripts/ec2-uat.sh (the leave document) before it terminates an
# instance; runs as SYSTEM. Deletes this computer's object from the UAT OU, so
# ephemeral instances leave nothing behind in AD. An instance that reaches its
# expiry instead leaves a stale object: the OU needs a stale-object clean-up too.
$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot\UatEc2.psm1"
$p = Get-UatPaths
$config = Get-Content -Path $p.Config -Raw | ConvertFrom-Json

# The join account: it created the object, and may delete objects in its OU.
$secret = (Get-SECSecretValue -SecretId $config.JoinSecretId -Region $config.Region).SecretString | ConvertFrom-Json
$root = New-Object System.DirectoryServices.DirectoryEntry("LDAP://$($config.Domain)", $secret.username, $secret.password)
$search = New-Object System.DirectoryServices.DirectorySearcher(
    $root, "(&(objectCategory=computer)(sAMAccountName=$env:COMPUTERNAME`$))")
$found = $search.FindOne()
if (-not $found) {
    Write-Output "No computer object for $env:COMPUTERNAME"
    exit 0
}
$found.GetDirectoryEntry().DeleteTree()
Write-Output "Deleted $($found.Path)"
exit 0
