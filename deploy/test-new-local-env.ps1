[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Read-EnvAssignments {
    param([Parameter(Mandatory = $true)][string]$Path)
    $assignments = @{}
    foreach ($line in [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)) {
        if ($line -match '^([^#=][^=]*)=(.*)$') {
            $assignments[$matches[1]] = $matches[2]
        }
    }
    return $assignments
}

function Assert-RestrictedAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) {
        throw "ACL inheritance remains enabled."
    }
    $allowed = @(
        [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
        "S-1-5-32-544",
        "S-1-5-18"
    ) | Select-Object -Unique
    $actual = @(
        $acl.Access |
            ForEach-Object {
                $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            } |
            Select-Object -Unique
    )
    if (@($actual | Where-Object { $_ -notin $allowed }).Count -ne 0) {
        throw "An unexpected ACL principal remains."
    }
    if (@($allowed | Where-Object { $_ -notin $actual }).Count -ne 0) {
        throw "A required ACL principal is missing."
    }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("agent-env-test-" + [Guid]::NewGuid().ToString("N"))
$deployDirectory = Join-Path $tempRoot "deploy"
$configDirectory = Join-Path $tempRoot "config"
try {
    New-Item -ItemType Directory -Path $deployDirectory, $configDirectory -Force | Out-Null
    $scriptPath = Join-Path $deployDirectory "new-local-env.ps1"
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "new-local-env.ps1") -Destination $scriptPath

    $createOutput = (& $scriptPath -MilvusDataDirectory "D:/001-agent/test-new-local-env" | Out-String)
    $target = Join-Path $configDirectory "deploy.local.env"
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        throw "Create mode did not produce deploy.local.env."
    }

    $created = Read-EnvAssignments $target
    $internalToken = [string]$created["WORKBENCH_INTERNAL_TOKEN"]
    $createdAssertion = [string]$created["WORKBENCH_TENANT_ASSERTION_SECRET"]
    if (
        [Text.Encoding]::UTF8.GetByteCount($createdAssertion) -lt 32 -or
        $createdAssertion -ceq $internalToken
    ) {
        throw "Create mode produced a missing, weak, or reused assertion secret."
    }
    Assert-RestrictedAcl $target

    $defaultRefused = $false
    try {
        & $scriptPath -MilvusDataDirectory "D:/001-agent/test-new-local-env" | Out-Null
    }
    catch {
        $defaultRefused = $_.Exception.Message -match "already exists"
    }
    if (-not $defaultRefused) {
        throw "Create mode did not refuse to overwrite the existing file."
    }

    $hashBeforeEnsure = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    $ensureOutput = (& $scriptPath -UpgradeTenantAssertionSecret | Out-String)
    $hashAfterEnsure = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    if ($hashBeforeEnsure -cne $hashAfterEnsure) {
        throw "Idempotent upgrade changed a compliant file."
    }
    Assert-RestrictedAcl $target

    $content = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)
    $withoutAssertion = [regex]::Replace(
        $content,
        '(?m)^WORKBENCH_TENANT_ASSERTION_SECRET=[^\r\n]*(?:\r?\n)?',
        ''
    )
    $withoutAssertion = [regex]::Replace($withoutAssertion, '\r?\n', "`r`n") +
        "CUSTOM_KEEP=value`r`n"
    [IO.File]::WriteAllText($target, $withoutAssertion, [Text.UTF8Encoding]::new($false))

    $upgradeOutput = (& $scriptPath -UpgradeTenantAssertionSecret | Out-String)
    $afterUpgradeContent = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)
    $afterUpgradeWithoutAssertion = [regex]::Replace(
        $afterUpgradeContent,
        '(?m)^WORKBENCH_TENANT_ASSERTION_SECRET=[^\r\n]*(?:\r?\n)?',
        ''
    )
    if ($afterUpgradeWithoutAssertion -cne $withoutAssertion) {
        throw "Upgrade mode did not preserve unrelated content and line endings."
    }
    $upgraded = Read-EnvAssignments $target
    $upgradedAssertion = [string]$upgraded["WORKBENCH_TENANT_ASSERTION_SECRET"]
    if (
        [Text.Encoding]::UTF8.GetByteCount($upgradedAssertion) -lt 32 -or
        $upgradedAssertion -ceq $internalToken
    ) {
        throw "Upgrade mode did not add a valid independent assertion secret."
    }
    if ([string]$upgraded["CUSTOM_KEEP"] -cne "value") {
        throw "Upgrade mode changed unrelated configuration."
    }
    Assert-RestrictedAcl $target

    $beforeRotate = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)
    $rotateOutput = (& $scriptPath -RotateTenantAssertionSecret | Out-String)
    $afterRotate = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)
    $rotated = Read-EnvAssignments $target
    $rotatedAssertion = [string]$rotated["WORKBENCH_TENANT_ASSERTION_SECRET"]
    if (
        $rotatedAssertion -ceq $upgradedAssertion -or
        $rotatedAssertion -ceq $internalToken -or
        [Text.Encoding]::UTF8.GetByteCount($rotatedAssertion) -lt 32
    ) {
        throw "Rotation did not produce a new valid independent assertion secret."
    }
    $redactionPattern = '(?m)^WORKBENCH_TENANT_ASSERTION_SECRET=[^\r\n]*'
    $beforeRedacted = [regex]::Replace(
        $beforeRotate,
        $redactionPattern,
        'WORKBENCH_TENANT_ASSERTION_SECRET=<redacted>'
    )
    $afterRedacted = [regex]::Replace(
        $afterRotate,
        $redactionPattern,
        'WORKBENCH_TENANT_ASSERTION_SECRET=<redacted>'
    )
    if ($beforeRedacted -cne $afterRedacted) {
        throw "Rotation changed unrelated configuration."
    }
    Assert-RestrictedAcl $target

    $combinedOutput = @($createOutput, $ensureOutput, $upgradeOutput, $rotateOutput) -join "`n"
    foreach ($secret in @($internalToken, $createdAssertion, $upgradedAssertion, $rotatedAssertion)) {
        if ($secret -and $combinedOutput.IndexOf($secret, [StringComparison]::Ordinal) -ge 0) {
            throw "The environment helper printed a generated secret value."
        }
    }

    $stagingFiles = @(
        Get-ChildItem -LiteralPath $configDirectory -Force |
            Where-Object { $_.Name -match '^\.deploy\.local\.env\..+\.(?:tmp|bak)$' }
    )
    if ($stagingFiles.Count -ne 0) {
        throw "An atomic-write temporary or backup file remains."
    }

    [pscustomobject]@{
        Create = $true
        DefaultOverwriteRefused = $true
        UpgradeAddedSecret = $true
        UpgradeIdempotent = $true
        RotationPreservedOtherConfig = $true
        SecretsNotPrinted = $true
        RestrictedAcl = $true
        TemporaryFilesClean = $true
    } | ConvertTo-Json -Compress
}
finally {
    $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
    $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $leaf = Split-Path -Leaf $resolvedTemp
    if (
        $resolvedTemp.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase) -and
        $leaf.StartsWith("agent-env-test-", [StringComparison]::Ordinal) -and
        (Test-Path -LiteralPath $resolvedTemp)
    ) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}
