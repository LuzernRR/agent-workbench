[CmdletBinding(DefaultParameterSetName = "Create")]
param(
    [string]$MilvusDataDirectory = "D:/001-agent/milvus",

    [Parameter(Mandatory = $true, ParameterSetName = "Upgrade")]
    [switch]$UpgradeTenantAssertionSecret,

    [Parameter(Mandatory = $true, ParameterSetName = "Rotate")]
    [switch]$RotateTenantAssertionSecret
)

$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "deploy/new-local-env.ps1 requires Windows with an ACL-capable NTFS/ReFS target."
}

function New-HexSecret {
    param([int]$Bytes = 24)
    $buffer = [byte[]]::new($Bytes)
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($buffer)
    }
    finally {
        $generator.Dispose()
    }
    return ([BitConverter]::ToString($buffer)).Replace('-', '')
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Get-CurrentUserSid {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity.User) {
        throw "Unable to resolve the current Windows user SID."
    }
    return $identity.User.Value
}

function Get-RequiredSecretFileSids {
    $currentUserSid = Get-CurrentUserSid
    return @($currentUserSid, "S-1-5-32-544", "S-1-5-18") | Select-Object -Unique
}

function Convert-IdentityReferenceToSid {
    param([Parameter(Mandatory = $true)][Security.Principal.IdentityReference]$Identity)
    if ($Identity -is [Security.Principal.SecurityIdentifier]) {
        return $Identity.Value
    }
    return $Identity.Translate([Security.Principal.SecurityIdentifier]).Value
}

function Convert-OwnerToSid {
    param([Parameter(Mandatory = $true)][string]$Owner)
    if ($Owner -match '^S-\d(?:-\d+)+$') {
        return [Security.Principal.SecurityIdentifier]::new($Owner).Value
    }
    return [Security.Principal.NTAccount]::new($Owner).Translate(
        [Security.Principal.SecurityIdentifier]
    ).Value
}

function Assert-SecretFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $acl = Get-Acl -LiteralPath $Path
        if (-not $acl.AreAccessRulesProtected) {
            throw "ACL inheritance is still enabled."
        }

        $required = @{}
        foreach ($sid in Get-RequiredSecretFileSids) {
            $required[$sid] = $false
        }
        $ownerSid = Convert-OwnerToSid $acl.Owner
        if (-not $required.ContainsKey($ownerSid)) {
            throw "The file owner is not the current user, Administrators, or SYSTEM."
        }
        $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
        foreach ($rule in $acl.Access) {
            $sid = Convert-IdentityReferenceToSid $rule.IdentityReference
            if ($rule.IsInherited) {
                throw "An inherited ACL entry remains for $sid."
            }
            if (-not $required.ContainsKey($sid)) {
                throw "An unexpected ACL principal remains: $sid."
            }
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
                throw "A deny ACL entry remains for $sid."
            }
            if (($rule.FileSystemRights -band $fullControl) -ne $fullControl) {
                throw "The required principal $sid does not have FullControl."
            }
            $required[$sid] = $true
        }
        foreach ($sid in $required.Keys) {
            if (-not $required[$sid]) {
                throw "The required ACL principal is missing: $sid."
            }
        }
    }
    catch {
        throw "Secret file ACL verification failed. The target must support Windows ACLs and only the current user, Administrators, and SYSTEM may access it. $($_.Exception.Message)"
    }
}

function Protect-SecretFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $currentUserSid = Get-CurrentUserSid
        $sections = [Security.AccessControl.AccessControlSections]::Access -bor `
            [Security.AccessControl.AccessControlSections]::Owner
        $security = [Security.AccessControl.FileSecurity]::new($Path, $sections)
        $security.SetAccessRuleProtection($true, $false)
        foreach ($existingRule in @($security.Access)) {
            [void]$security.RemoveAccessRuleSpecific($existingRule)
        }
        $allowedOwnerSids = @(Get-RequiredSecretFileSids)
        $ownerSid = Convert-OwnerToSid $security.Owner
        if ($ownerSid -notin $allowedOwnerSids) {
            $security.SetOwner([Security.Principal.SecurityIdentifier]::new($currentUserSid))
        }
        foreach ($sidValue in Get-RequiredSecretFileSids) {
            $sid = [Security.Principal.SecurityIdentifier]::new($sidValue)
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow
            )
            [void]$security.AddAccessRule($rule)
        }
        [IO.File]::SetAccessControl($Path, $security)
        Assert-SecretFileAcl $Path
    }
    catch {
        throw "Unable to restrict the secret file to the current user, Administrators, and SYSTEM. The target must be an ACL-capable Windows volume and the current user must be allowed to change its ACL. $($_.Exception.Message)"
    }
}

function New-ProtectedEmptyFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = $null
    try {
        $stream = [IO.File]::Open(
            $Path,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
    try {
        Protect-SecretFile $Path
    }
    catch {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Write-AtomicUtf8File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text,
        [string]$ExpectedSha256
    )
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "Target directory does not exist: $directory"
    }
    $tempPath = Join-Path $directory (".{0}.{1}.{2}.tmp" -f ([IO.Path]::GetFileName($Path)), $PID, [Guid]::NewGuid().ToString("N"))
    $backupPath = Join-Path $directory (".{0}.{1}.{2}.bak" -f ([IO.Path]::GetFileName($Path)), $PID, [Guid]::NewGuid().ToString("N"))
    $restorePath = Join-Path $directory (".{0}.{1}.{2}.restore" -f ([IO.Path]::GetFileName($Path)), $PID, [Guid]::NewGuid().ToString("N"))
    $failedPath = Join-Path $directory (".{0}.{1}.{2}.failed" -f ([IO.Path]::GetFileName($Path)), $PID, [Guid]::NewGuid().ToString("N"))
    $succeeded = $false
    $rollbackVerified = $false
    try {
        New-ProtectedEmptyFile $tempPath
        [IO.File]::WriteAllText($tempPath, $Text, [Text.UTF8Encoding]::new($false))
        Assert-SecretFileAcl $tempPath

        if ($ExpectedSha256) {
            if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
                throw "The existing environment file disappeared before the atomic update."
            }
            if ((Get-FileSha256 $Path) -cne $ExpectedSha256) {
                throw "The existing environment file changed during the update; no replacement was performed."
            }
            # Do not ignore metadata errors: if the filesystem cannot complete
            # the replacement, the original file must remain recoverable.
            [IO.File]::Replace($tempPath, $Path, $backupPath, $false)
        }
        else {
            if (Test-Path -LiteralPath $Path) {
                throw "The target appeared during creation; refusing to overwrite it."
            }
            [IO.File]::Move($tempPath, $Path)
        }
        Protect-SecretFile $Path
        Assert-SecretFileAcl $Path
        $succeeded = $true
    }
    catch {
        $originalError = $_
        $rollbackError = $null
        if ($ExpectedSha256 -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
            try {
                # Keep the original backup in place until the restored file has
                # itself passed ACL verification. File.Replace then makes the
                # rollback atomic and leaves the failed new file disposable.
                [IO.File]::Copy($backupPath, $restorePath, $false)
                Protect-SecretFile $restorePath
                Assert-SecretFileAcl $restorePath
                [IO.File]::Replace($restorePath, $Path, $failedPath, $false)
                Protect-SecretFile $Path
                Assert-SecretFileAcl $Path
                $rollbackVerified = $true
            }
            catch {
                $rollbackError = $_
            }
        }
        if ($rollbackError) {
            throw "Atomic environment update failed and rollback could not be verified. Preserve backup '$backupPath'. Original error: $($originalError.Exception.Message) Rollback error: $($rollbackError.Exception.Message)"
        }
        throw $originalError
    }
    finally {
        if (Test-Path -LiteralPath $tempPath) {
            Remove-Item -LiteralPath $tempPath -Force
        }
        if (Test-Path -LiteralPath $restorePath) {
            Remove-Item -LiteralPath $restorePath -Force
        }
        if (Test-Path -LiteralPath $failedPath) {
            Remove-Item -LiteralPath $failedPath -Force
        }
        if (($succeeded -or $rollbackVerified) -and (Test-Path -LiteralPath $backupPath)) {
            Remove-Item -LiteralPath $backupPath -Force
        }
    }
}

function Get-EnvAssignmentMatch {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$Required
    )
    $pattern = "(?m)^[\t ]*{0}[\t ]*=(?<value>[^\r\n]*)(?=\r?$)" -f [regex]::Escape($Name)
    $matches = [regex]::Matches($Content, $pattern)
    if ($matches.Count -gt 1) {
        throw "The environment file contains duplicate $Name assignments."
    }
    if ($Required -and $matches.Count -ne 1) {
        throw "The environment file must contain exactly one $Name assignment."
    }
    if ($matches.Count -eq 0) {
        return $null
    }
    return $matches[0]
}

function ConvertFrom-EnvLiteral {
    param([AllowEmptyString()][string]$Value)
    $trimmed = $Value.Trim()
    if ($trimmed.Length -ge 2) {
        $first = $trimmed[0]
        $last = $trimmed[$trimmed.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            return $trimmed.Substring(1, $trimmed.Length - 2)
        }
    }
    return $trimmed
}

function New-IndependentTenantAssertionSecret {
    param(
        [Parameter(Mandatory = $true)][string]$InternalToken,
        [string]$PreviousSecret
    )
    do {
        $secret = New-HexSecret 32
    } while ($secret -ceq $InternalToken -or ($PreviousSecret -and $secret -ceq $PreviousSecret))
    return $secret
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$configDirectory = Join-Path $repositoryRoot "config"
$target = Join-Path $configDirectory "deploy.local.env"

if ($PSCmdlet.ParameterSetName -eq "Create") {
    if (Test-Path -LiteralPath $target) {
        throw "config/deploy.local.env already exists; refusing to overwrite secrets. Use -UpgradeTenantAssertionSecret or -RotateTenantAssertionSecret explicitly."
    }

    $resolvedDataDirectory = [IO.Path]::GetFullPath($MilvusDataDirectory).TrimEnd([char[]]'\/')
    $protectedLegacyDirectory = [IO.Path]::GetFullPath('D:/milvus').TrimEnd([char[]]'\/')
    if (-not $resolvedDataDirectory.StartsWith('D:\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Milvus data must be stored on drive D."
    }
    if ($resolvedDataDirectory.Equals($protectedLegacyDirectory, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to reuse protected legacy directory D:/milvus."
    }

    $postgresPassword = "PgA1" + (New-HexSecret 20)
    $milvusPassword = "MvA1!" + (New-HexSecret 20)
    $minioPassword = "MnA1!" + (New-HexSecret 20)
    $internalToken = New-HexSecret 32
    $tenantAssertionSecret = New-IndependentTenantAssertionSecret -InternalToken $internalToken
    $portableDataDirectory = $resolvedDataDirectory.Replace('\', '/')

    $lines = @(
        "# Generated by deploy/new-local-env.ps1. Git ignored; never commit or share.",
        "POSTGRES_DB=agent_workbench",
        "POSTGRES_USER=workbench",
        "POSTGRES_PASSWORD=$postgresPassword",
        "POSTGRES_BIND_ADDRESS=127.0.0.1",
        "POSTGRES_HOST_PORT=15432",
        "POSTGRES_VOLUME_NAME=001-agent-live-postgres-v1",
        "WORKBENCH_DATABASE_URL=postgresql://workbench:$postgresPassword@postgres:5432/agent_workbench",
        "WORKBENCH_DATABASE_SSL=false",
        "WORKBENCH_DATABASE_POOL_MAX=10",
        "",
        "SEARCH_AGENT_IMAGE=agent-workbench/search-agent:local",
        "SEARCH_AGENT_BIND_ADDRESS=127.0.0.1",
        "SEARCH_AGENT_HOST_PORT=8080",
        "SEARCH_AGENT_DATABASE_URL=postgresql://workbench:$postgresPassword@postgres:5432/agent_workbench",
        "SEARCH_AGENT_MILVUS_URI=http://milvus:19530",
        "WORKBENCH_INTERNAL_TOKEN=$internalToken",
        "WORKBENCH_TENANT_ASSERTION_SECRET=$tenantAssertionSecret",
        "",
        "WEB_IMAGE=agent-workbench/web:local",
        "WEB_BIND_ADDRESS=127.0.0.1",
        "WEB_PORT=3000",
        "",
        "MILVUS_DATA_DIRECTORY=$portableDataDirectory",
        "MILVUS_ROOT_PASSWORD=$milvusPassword",
        "MILVUS_MINIO_ROOT_USER=agentminio",
        "MILVUS_MINIO_ROOT_PASSWORD=$minioPassword",
        "",
        "AGENT_BACKEND_NETWORK=001-agent-live-backend",
        "AGENT_MILVUS_NETWORK=001-agent-live-milvus"
    )

    Write-AtomicUtf8File -Path $target -Text (($lines -join "`n") + "`n")
    Write-Host "Generated Git-ignored config/deploy.local.env without printing secrets."
    Write-Host "Restricted the file ACL to the current user, Administrators, and SYSTEM."
    Write-Host "Milvus isolated data directory: $portableDataDirectory"
    return
}

if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw "config/deploy.local.env does not exist; run the script without an upgrade/rotation switch for first-time creation."
}

Protect-SecretFile $target
$expectedSha256 = Get-FileSha256 $target
$content = [IO.File]::ReadAllText($target, [Text.UTF8Encoding]::new($false, $true))
$internalMatch = Get-EnvAssignmentMatch -Content $content -Name "WORKBENCH_INTERNAL_TOKEN" -Required
$internalToken = ConvertFrom-EnvLiteral $internalMatch.Groups["value"].Value
if ([string]::IsNullOrWhiteSpace($internalToken)) {
    throw "WORKBENCH_INTERNAL_TOKEN must be configured before upgrading the tenant assertion secret."
}

$assertionMatch = Get-EnvAssignmentMatch -Content $content -Name "WORKBENCH_TENANT_ASSERTION_SECRET"
$previousSecret = if ($null -ne $assertionMatch) {
    ConvertFrom-EnvLiteral $assertionMatch.Groups["value"].Value
}
else {
    ""
}

$isCompliant = $previousSecret `
    -and [Text.Encoding]::UTF8.GetByteCount($previousSecret) -ge 32 `
    -and $previousSecret -cne $internalToken

if ($PSCmdlet.ParameterSetName -eq "Upgrade" -and $isCompliant) {
    Assert-SecretFileAcl $target
    Write-Host "Tenant assertion secret is already compliant; preserved all values and verified the restricted ACL."
    return
}
if ($PSCmdlet.ParameterSetName -eq "Rotate" -and [string]::IsNullOrWhiteSpace($previousSecret)) {
    throw "WORKBENCH_TENANT_ASSERTION_SECRET is missing; use -UpgradeTenantAssertionSecret to add it safely."
}

$tenantAssertionSecret = New-IndependentTenantAssertionSecret `
    -InternalToken $internalToken `
    -PreviousSecret $previousSecret
$assignment = "WORKBENCH_TENANT_ASSERTION_SECRET=$tenantAssertionSecret"
if ($null -ne $assertionMatch) {
    $updated = $content.Remove($assertionMatch.Index, $assertionMatch.Length).Insert($assertionMatch.Index, $assignment)
}
else {
    $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
    $separator = if ($content.EndsWith("`n")) { "" } else { $newline }
    $updated = $content + $separator + $assignment + $newline
}

Write-AtomicUtf8File -Path $target -Text $updated -ExpectedSha256 $expectedSha256
$operation = if ($PSCmdlet.ParameterSetName -eq "Rotate") { "Rotated" } else { "Added or repaired" }
Write-Host "$operation WORKBENCH_TENANT_ASSERTION_SECRET without printing it or changing other configuration."
Write-Host "Restricted the file ACL to the current user, Administrators, and SYSTEM."
