# Pester 5. The decisions in the EC2 image's scripts, tested on Windows (CI's
# `windows` job). What needs a real instance (the domain join, autologon, the
# scheduled task, SSM) is proven only by a run on AWS.

BeforeAll {
    Import-Module "$PSScriptRoot\..\UatEc2.psm1" -Force
}

Describe 'Get-UatComputerName' {
    It 'is UAT- and the end of the instance id, upper case, within NetBIOS''s 15 characters' {
        Get-UatComputerName -InstanceId 'i-0123456789abcdef0' | Should -Be 'UAT-6789ABCDEF0'
        (Get-UatComputerName -InstanceId 'i-0123456789abcdef0').Length | Should -BeLessOrEqual 15
    }

    It 'differs for instances that differ only at the end' {
        Get-UatComputerName -InstanceId 'i-0123456789abcdef0' |
            Should -Not -Be (Get-UatComputerName -InstanceId 'i-0123456789abcdef1')
    }

    It 'refuses something that is not an instance id' {
        { Get-UatComputerName -InstanceId 'not-an-id' } | Should -Throw '*instance id*'
    }
}

Describe 'Read-UatConfig' {
    BeforeAll {
        $good = @{ Domain = 'corp.example.com'; JoinOu = 'OU=UAT,DC=corp,DC=example,DC=com'; JoinSecretId = 'uat/join'
                   TesterGroup = 'UAT-Testers'; Bucket = 'desktop-uat-uat-1'; Region = 'ap-southeast-2' }
    }

    It 'reads the settings Terraform writes' {
        $c = Read-UatConfig -Json ($good | ConvertTo-Json)
        $c.Domain | Should -Be 'corp.example.com'
        $c.TesterGroup | Should -Be 'UAT-Testers'
    }

    It 'names the setting that is missing' {
        $partial = $good.Clone(); $partial.Remove('JoinOu')
        { Read-UatConfig -Json ($partial | ConvertTo-Json) } | Should -Throw '*JoinOu*'
    }
}

Describe 'Get-UatSecondsLeft' {
    It 'is the time until the expiry' {
        Get-UatSecondsLeft -ExpiresAt 1000 -Now 400 | Should -Be 600
    }

    It 'is 0 once expired: shut down now' {
        Get-UatSecondsLeft -ExpiresAt 1000 -Now 5000 | Should -Be 0
    }

    It 'without an expiry, uses the default lifetime, never forever' {
        Get-UatSecondsLeft -ExpiresAt $null -Now 0 | Should -Be (4 * 3600)
    }

    It 'caps a far-off expiry at the longest lifetime allowed' {
        Get-UatSecondsLeft -ExpiresAt (30 * 86400) -Now 0 | Should -Be (24 * 3600)
    }

    It 'treats an unreadable expiry as no expiry' {
        Get-UatSecondsLeft -ExpiresAt 'soon' -Now 0 | Should -Be (4 * 3600)
    }
}

Describe 'New-UatPassword' {
    It 'is long, and has every character class Windows complexity asks for' {
        $p = New-UatPassword
        $p.Length | Should -BeGreaterOrEqual 32
        $p | Should -MatchExactly '[A-Z]'
        $p | Should -MatchExactly '[a-z]'
        $p | Should -Match '[0-9]'
        $p | Should -Match '[^A-Za-z0-9]'
    }

    It 'is different every time' {
        New-UatPassword | Should -Not -Be (New-UatPassword)
    }
}

Describe 'New-UatHarnessArgs' {
    BeforeAll {
        $request = [pscustomobject]@{
            RunId = '42-1'; BuildUrl = 'https://b.s3.ap-southeast-2.amazonaws.com/staging/42-1/build.zip?X-Amz-Signature=x'
            BuildSha256 = ('a' * 64); Tags = 'smoke'; StateRoot = '%APPDATA%/UatDemo'; GitRef = 'refs/heads/main'; GitSha = ('f' * 40)
        }
        $a = New-UatHarnessArgs -Request $request -Scenarios 'C:\UatRun\runs\42-1\scenarios' -Out 'C:\UatRun\runs\42-1\reports'
        $value = { param($flag) $a[[array]::IndexOf($a, $flag) + 1] }
    }

    It 'runs walkthrough mode' {
        $a[0..2] | Should -Be @('-m', 'uat_harness.cli', 'local')
    }

    It 'installs machine-wide, so testers who RDP in as themselves see the build' {
        & $value '--install-root' | Should -Be 'C:\UatInstall'
    }

    It 'downloads the build from its presigned URL, allowing only that URL''s host' {
        & $value '--build-url' | Should -Be $request.BuildUrl
        & $value '--build-sha256' | Should -Be $request.BuildSha256
        & $value '--allowed-hosts' | Should -Be 'b.s3.ap-southeast-2.amazonaws.com'
    }

    It 'passes the run''s identity and the FlaUI server' {
        & $value '--run-id' | Should -Be '42-1'
        & $value '--git-ref' | Should -Be 'refs/heads/main'
        & $value '--git-sha' | Should -Be ('f' * 40)
        & $value '--flaui-server' | Should -Be 'C:\Uat\flaui\FlaUiMcpServer.exe'
        & $value '--state-root' | Should -Be '%APPDATA%/UatDemo'
        & $value '--scenarios' | Should -Be 'C:\UatRun\runs\42-1\scenarios'
        & $value '--out' | Should -Be 'C:\UatRun\runs\42-1\reports'
    }

    It 'leaves out --tags when there are none: every scenario runs' {
        $none = $request.PSObject.Copy(); $none.Tags = ''
        New-UatHarnessArgs -Request $none -Scenarios 's' -Out 'o' | Should -Not -Contain '--tags'
        & $value '--tags' | Should -Be 'smoke'
    }
}
