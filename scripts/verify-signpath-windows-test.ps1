# Only for this workflow's disposable GitHub-hosted Windows runner.
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $ArtifactDirectory,
    [Parameter(Mandatory)] [string] $EvidenceDirectory,
    [Parameter(Mandatory)]
    [ValidatePattern('\A[0-9A-Fa-f]{64}\z')]
    [string] $ExpectedSignerSha256
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Temporary certificate trust is allowed only on this disposable GitHub-hosted Windows runner. Do not run on a workstation or self-hosted runner.'
}

$names = @('codex-taskboard-launcher.exe', 'codex-taskboard-test-setup.exe')
$entries = @(Get-ChildItem -LiteralPath $ArtifactDirectory -Force)
if ($entries.Count -ne 2 -or @($entries | Where-Object { $_.PSIsContainer }).Count -ne 0 -or
    @(Compare-Object -ReferenceObject $names -DifferenceObject @($entries.Name) -CaseSensitive).Count -ne 0) {
    throw 'Signed artifact must contain exactly the two expected PE files at its root.'
}

# The Windows SDK is included in windows-2025. Use the latest installed x64 tool.
$sdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$signTool = Get-ChildItem -Path "$sdkBin/*/x64/signtool.exe" -File |
    Sort-Object { [version]$_.Directory.Parent.Name } -Descending |
    Select-Object -First 1
if ($null -eq $signTool) { throw 'Windows SDK x64 signtool.exe was not found.' }

New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$records = @()
$testCertificate = $null
foreach ($name in $names) {
    $path = Join-Path $ArtifactDirectory $name
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($null -eq $signature.SignerCertificate) { throw "No signer certificate on ${name}." }
    $certificate = $signature.SignerCertificate
    $fingerprint = $certificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256)
    if ($fingerprint -ne $ExpectedSignerSha256) { throw "Unexpected signer on ${name}: $fingerprint" }
    if ($signature.SignatureType -ne 'Authenticode') { throw "Expected an embedded Authenticode signature on ${name}." }
    $testCertificate = $certificate
    $records += [ordered]@{
        artifact_path = $name
        file_sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        signer_sha256 = $fingerprint
        signer_subject = $certificate.Subject
        signer_issuer = $certificate.Issuer
        signer_serial_number = $certificate.SerialNumber
        signer_not_before_utc = $certificate.NotBefore.ToUniversalTime().ToString('o')
        signer_not_after_utc = $certificate.NotAfter.ToUniversalTime().ToString('o')
        status_before_temporary_trust = [string]$signature.Status
        status_message_before_temporary_trust = $signature.StatusMessage
        status_after_temporary_trust = $null
        signtool_exit_code = $null
    }
}

# Fingerprint equality identifies the independently approved public certificate;
# it is NOT proof that the PE signature or file digest is valid.
$certificatePath = Join-Path $EvidenceDirectory 'test-signer.cer'
[IO.File]::WriteAllBytes($certificatePath, $testCertificate.RawData)
$storePath = "Cert:\LocalMachine\Root\$($testCertificate.Thumbprint)"
$addedTrust = -not (Test-Path -LiteralPath $storePath)
Write-Host ('{0} TRUST store={1} addedTrust={2}' -f [DateTime]::UtcNow.ToString('o'), $storePath, $addedTrust)
$verified = $false
try {
    if ($addedTrust) {
        Write-Host ('{0} BEFORE Import-Certificate LocalMachine/Root' -f [DateTime]::UtcNow.ToString('o'))
        Import-Certificate -FilePath $certificatePath -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
        Write-Host ('{0} AFTER Import-Certificate LocalMachine/Root' -f [DateTime]::UtcNow.ToString('o'))
    }
    foreach ($record in $records) {
        $path = Join-Path $ArtifactDirectory $record.artifact_path
        # /pa checks Authenticode rather than driver policy; no /a catalog fallback.
        # /all checks every embedded signature. Any nonzero exit, even a warning, fails.
        Write-Host ('{0} BEFORE SignTool file={1}' -f [DateTime]::UtcNow.ToString('o'), $record.artifact_path)
        & $signTool.FullName verify /pa /all /v $path 2>&1 |
            Tee-Object -FilePath (Join-Path $EvidenceDirectory "$($record.artifact_path).signtool.txt")
        $record.signtool_exit_code = $LASTEXITCODE
        Write-Host ('{0} AFTER SignTool file={1} exit={2}' -f [DateTime]::UtcNow.ToString('o'), $record.artifact_path, $record.signtool_exit_code)
        if ($LASTEXITCODE -ne 0) { throw "SignTool integrity/policy verification failed for $($record.artifact_path)." }
        Write-Host ('{0} BEFORE Get-AuthenticodeSignature file={1}' -f [DateTime]::UtcNow.ToString('o'), $record.artifact_path)
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        $record.status_after_temporary_trust = [string]$signature.Status
        Write-Host ('{0} AFTER Get-AuthenticodeSignature file={1} status={2}' -f [DateTime]::UtcNow.ToString('o'), $record.artifact_path, $record.status_after_temporary_trust)
        if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or
            $null -eq $signature.SignerCertificate -or
            $signature.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256) -ne $ExpectedSignerSha256) {
            throw "Signature verification failed for $($record.artifact_path): $($signature.Status) / $($signature.StatusMessage)"
        }
    }
    $verified = $true
}
finally {
    Write-Host ('{0} BEFORE cleanup store={1} addedTrust={2}' -f [DateTime]::UtcNow.ToString('o'), $storePath, $addedTrust)
    if ($addedTrust -and (Test-Path -LiteralPath $storePath)) {
        Remove-Item -LiteralPath $storePath
    }
    Write-Host ('{0} AFTER cleanup store={1}' -f [DateTime]::UtcNow.ToString('o'), $storePath)
    [ordered]@{
        verified = $verified
        expected_signer_sha256 = $ExpectedSignerSha256.ToUpperInvariant()
        trust_scope = 'Disposable GitHub-hosted runner LocalMachine/Root only; not public trust.'
        temporary_trust_removed = $addedTrust -and -not (Test-Path -LiteralPath $storePath)
        files = $records
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'verification.json') -Encoding utf8
}
Write-Host 'PASS: both PE signatures are intact and match the pinned test certificate; temporary runner trust has been cleaned up.'
