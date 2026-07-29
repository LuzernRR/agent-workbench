[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$ContainerName = 'agent-workbench-live-xiaohongshu-mcp'
)

$ErrorActionPreference = 'Stop'
$qrPath = $null

function Get-XiaohongshuSessionFingerprint {
    $raw = & docker exec $ContainerName sha256sum /app/data/cookies.json 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($raw | Out-String))) {
        return ''
    }
    return (($raw | Out-String).Trim() -split '\s+')[0]
}

function Test-XiaohongshuSessionHasCookies {
    & docker exec $ContainerName grep --quiet '"name"' /app/data/cookies.json
    return $LASTEXITCODE -eq 0
}

function Invoke-XiaohongshuInternalApi {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('/api/v1/login/qrcode', '/api/v1/login/status')]
        [string]$Path
    )

    $raw = & docker exec $ContainerName curl `
        --silent `
        --show-error `
        --max-time 65 `
        "http://127.0.0.1:18060$Path"
    if ($LASTEXITCODE -ne 0) {
        throw 'The internal Xiaohongshu login service is unavailable.'
    }
    try {
        return ($raw | Out-String | ConvertFrom-Json)
    }
    catch {
        throw 'The Xiaohongshu login service returned an invalid response.'
    }
}

try {
    $sessionBefore = Get-XiaohongshuSessionFingerprint
    $qrcode = Invoke-XiaohongshuInternalApi -Path '/api/v1/login/qrcode'
    if ($qrcode.success -ne $true) {
        throw 'Failed to generate the Xiaohongshu login QR code.'
    }
    if ($qrcode.data.is_logged_in -eq $true) {
        Write-Output 'Xiaohongshu is already logged in.'
        return
    }

    $prefix = 'data:image/png;base64,'
    $image = [string]$qrcode.data.img
    if (-not $image.StartsWith($prefix, [StringComparison]::Ordinal)) {
        throw 'The Xiaohongshu login QR code has an invalid format.'
    }
    try {
        $bytes = [Convert]::FromBase64String($image.Substring($prefix.Length))
    }
    catch {
        throw 'The Xiaohongshu login QR code cannot be decoded.'
    }
    if ($bytes.Length -lt 64 -or $bytes.Length -gt 3MB) {
        throw 'The Xiaohongshu login QR code has an invalid size.'
    }

    $fileName = "agent-workbench-xiaohongshu-login-$([Guid]::NewGuid().ToString('N')).png"
    $qrPath = [IO.Path]::Combine([IO.Path]::GetTempPath(), $fileName)
    [IO.File]::WriteAllBytes($qrPath, $bytes)

    Write-Output "The QR code was opened from the system temp directory: $qrPath"
    Write-Output 'Scan it in the Xiaohongshu app. The file is deleted after login or timeout.'
    Start-Process -FilePath $qrPath

    $deadline = [DateTimeOffset]::Now.AddMinutes(4)
    while ([DateTimeOffset]::Now -lt $deadline) {
        Start-Sleep -Seconds 3
        $sessionAfter = Get-XiaohongshuSessionFingerprint
        if (
            -not [string]::IsNullOrWhiteSpace($sessionAfter) -and
            $sessionAfter -ne $sessionBefore -and
            (Test-XiaohongshuSessionHasCookies)
        ) {
            Write-Output 'Login succeeded. The session is stored in the private Docker volume.'
            return
        }
    }
    throw 'The QR code expired. Run this script again to retry.'
}
finally {
    if ($qrPath -and [IO.Path]::GetDirectoryName($qrPath) -eq [IO.Path]::GetTempPath().TrimEnd('\')) {
        Remove-Item -LiteralPath $qrPath -Force -ErrorAction SilentlyContinue
    }
}
