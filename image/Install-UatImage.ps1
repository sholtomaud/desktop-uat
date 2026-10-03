<#
.SYNOPSIS
  Prepare a WorkSpaces Applications image builder (Windows Server) as the UAT desktop image.
  Run as Administrator on the image builder, then let it create the image.

.DESCRIPTION
  - Installs the FlaUI MCP server and registers it for MCP tool forwarding
  - Installs C++ runtime prerequisites (bake prerequisites here; the app itself is
    installed per session from the release under test)
  - Removes first-run noise that would confuse a computer-use agent
  - Creates the image with Image Assistant CLI

.EXAMPLE
  .\Install-UatImage.ps1 -ServerZip C:\staging\flaui-mcp-server.zip `
      -BuildsBucketHost "desktopuat-prod-desktop-buildsxxxx.s3.ap-southeast-2.amazonaws.com" `
      -StateRootSuffix "UatDemo" -VcRedist C:\staging\vc_redist.x64.exe `
      -ImageName "desktop-uat-base-2026-10-01" -CreateImage
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ServerZip,          # dotnet publish output of image/flaui-mcp-server, zipped
  [Parameter(Mandatory)] [string] $BuildsBucketHost,   # CDK output BuildsBucket + ".s3.<region>.amazonaws.com"
  [string] $StateRootSuffix = "UatDemo",               # %APPDATA%\<this> is wiped by reset_app_state (the example app's state dir)
  [string] $VcRedist,                                  # path to vc_redist.x64.exe (no internet on fleet)
  [string] $ImageName,
  [switch] $CreateImage
)
$ErrorActionPreference = 'Stop'

$serverDir = 'C:\UAT\flaui-mcp'
$logRoot   = 'C:\UAT\logs'

Write-Host '== FlaUI MCP server'
New-Item -ItemType Directory -Force -Path $serverDir, $logRoot | Out-Null
Expand-Archive -Path $ServerZip -DestinationPath $serverDir -Force
if (-not (Test-Path "$serverDir\FlaUiMcpServer.exe")) { throw 'FlaUiMcpServer.exe not found in zip root' }
# Session users are non-admin: let them write logs.
icacls $logRoot /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null   # BUILTIN\Users

Write-Host '== MCP tool forwarding manifest'
$manifestDir = 'C:\ProgramData\NICE\dcv'
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
$manifest = @{
  mcpServers = @{
    flaui = @{
      command = "$serverDir/FlaUiMcpServer.exe" -replace '\\','/'
      args    = @(
        '--allowed-hosts', $BuildsBucketHost,
        '--state-root',    "%APPDATA%\$StateRootSuffix",
        '--log-root',      $logRoot,
        '--install-root',  '%LOCALAPPDATA%\UatInstall',
        '--launch-roots',  '%LOCALAPPDATA%\UatInstall;%LOCALAPPDATA%\Programs'
      )
    }
  }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 "$manifestDir\mcp_server_redirection_config.json"

if ($VcRedist) {
  Write-Host '== VC++ runtime'
  $p = Start-Process -FilePath $VcRedist -ArgumentList '/install','/quiet','/norestart' -Wait -PassThru
  if ($p.ExitCode -notin 0,3010,1638) { throw "vc_redist failed: $($p.ExitCode)" }
}

Write-Host '== Reduce first-run noise for the agent'
Get-ScheduledTask -TaskName 'ServerManager' -ErrorAction SilentlyContinue | Disable-ScheduledTask | Out-Null
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' -Force | Out-Null
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' -Name HideFirstRunExperience -Value 1 -Type DWord
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' -Force | Out-Null
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' -Name DisableWindowsConsumerFeatures -Value 1 -Type DWord

if ($CreateImage) {
  if (-not $ImageName) { throw '-ImageName is required with -CreateImage' }
  $ia = 'C:\Program Files\Amazon\Photon\ConsoleImageBuilder\image-assistant.exe'
  if (-not (Test-Path $ia)) { throw "Image Assistant CLI not found at $ia" }
  # Verify flags with: & $ia help create-image   (CLI options vary by agent version)
  & $ia create-image --name $ImageName --description 'Desktop UAT base (FlaUI MCP)' --use-latest-agent-version
  if ($LASTEXITCODE -ne 0) { throw "create-image failed ($LASTEXITCODE)" }
  Write-Host "Image '$ImageName' is being created; the image builder will shut down. Put the name in cdk.json fleet.imageName."
}
