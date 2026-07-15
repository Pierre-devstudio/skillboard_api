param(
    [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path,
    [string]$OutputDirectory = "$env:USERPROFILE\Desktop",
    [switch]$IncludeUntrackedSources
)

$ErrorActionPreference = "Stop"

function Test-ExcludedPath {
    param([string]$RelativePath)

    $normalized = $RelativePath.Replace("/", "\")

    $excludedDirectories = @(
        ".git",
        ".venv",
        "venv",
        "env",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".idea",
        "node_modules",
        "dist",
        "build",
        "coverage",
        ".coverage",
        "htmlcov",
        "tmp",
        "temp"
    )

    foreach ($directory in $excludedDirectories) {
        if (
            $normalized -eq $directory -or
            $normalized.StartsWith("$directory\") -or
            $normalized.Contains("\$directory\")
        ) {
            return $true
        }
    }

    $fileName = [System.IO.Path]::GetFileName($normalized)
    $extension = [System.IO.Path]::GetExtension($normalized).ToLowerInvariant()

    $excludedNames = @(
        ".env",
        ".env.local",
        ".env.production",
        ".env.development",
        "secrets.json",
        "credentials.json",
        "service-account.json"
    )

    if ($fileName.ToLowerInvariant() -in $excludedNames) {
        return $true
    }

    $excludedExtensions = @(
        ".pyc",
        ".pyo",
        ".log",
        ".tmp",
        ".bak",
        ".patch",
        ".zip",
        ".7z",
        ".rar",
        ".sqlite",
        ".sqlite3",
        ".db"
    )

    if ($extension -in $excludedExtensions) {
        return $true
    }

    return $false
}

function Copy-ProjectFile {
    param(
        [string]$RelativePath,
        [string]$SourceRoot,
        [string]$TargetRoot
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        return
    }

    $relative = $RelativePath.Replace("/", "\").TrimStart("\")
    if (Test-ExcludedPath $relative) {
        return
    }

    $source = Join-Path $SourceRoot $relative
    if (-not (Test-Path $source -PathType Leaf)) {
        return
    }

    $target = Join-Path $TargetRoot $relative
    $targetDirectory = Split-Path $target -Parent

    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    Copy-Item $source $target -Force
}

if (-not (Test-Path (Join-Path $ProjectRoot ".git"))) {
    throw "Le dossier '$ProjectRoot' n'est pas la racine d'un dépôt Git."
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$archiveName = "skillboard_api_sources_completes_$timestamp.zip"
$archivePath = Join-Path $OutputDirectory $archiveName
$tempRoot = Join-Path $env:TEMP "skillboard_api_sources_completes_$timestamp"

Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

Push-Location $ProjectRoot

try {
    # Tous les fichiers suivis par Git constituent la source de vérité du projet.
    $trackedFiles = git ls-files
    if ($LASTEXITCODE -ne 0) {
        throw "Impossible de lire la liste des fichiers suivis par Git."
    }

    foreach ($relativePath in $trackedFiles) {
        Copy-ProjectFile `
            -RelativePath $relativePath `
            -SourceRoot $ProjectRoot `
            -TargetRoot $tempRoot
    }

    # Inclut en option les fichiers source non suivis, mais jamais les archives,
    # patches, secrets, caches ou fichiers de base locale.
    if ($IncludeUntrackedSources) {
        $untrackedFiles = git ls-files --others --exclude-standard

        foreach ($relativePath in $untrackedFiles) {
            $extension = [System.IO.Path]::GetExtension($relativePath).ToLowerInvariant()

            $sourceExtensions = @(
                ".py",
                ".html",
                ".css",
                ".js",
                ".mjs",
                ".json",
                ".sql",
                ".md",
                ".txt",
                ".csv",
                ".xml",
                ".yaml",
                ".yml",
                ".toml",
                ".ini",
                ".cfg",
                ".svg",
                ".ps1",
                ".bat",
                ".cmd",
                ".sh",
                ".xlsx"
            )

            if ($extension -in $sourceExtensions) {
                Copy-ProjectFile `
                    -RelativePath $relativePath `
                    -SourceRoot $ProjectRoot `
                    -TargetRoot $tempRoot
            }
        }
    }

    # Manifeste pour contrôler immédiatement le contenu de l'archive.
    $manifestPath = Join-Path $tempRoot "_MANIFESTE_EXPORT_NOVOSKILL.txt"
    $exportedFiles = Get-ChildItem $tempRoot -Recurse -File |
        Where-Object { $_.FullName -ne $manifestPath } |
        ForEach-Object {
            $_.FullName.Substring($tempRoot.Length).TrimStart("\")
        } |
        Sort-Object

    $pythonCount = ($exportedFiles | Where-Object {
        [System.IO.Path]::GetExtension($_).ToLowerInvariant() -eq ".py"
    }).Count

    $manifest = @(
        "EXPORT SOURCES NOVOSKILL"
        "Date : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        "Dépôt : $ProjectRoot"
        "Fichiers exportés : $($exportedFiles.Count)"
        "Fichiers Python : $pythonCount"
        "Fichiers non suivis inclus : $IncludeUntrackedSources"
        ""
        "LISTE DES FICHIERS"
        "=================="
    ) + $exportedFiles

    [System.IO.File]::WriteAllLines(
        $manifestPath,
        $manifest,
        (New-Object System.Text.UTF8Encoding($false))
    )

    if ($pythonCount -eq 0) {
        throw "Aucun fichier Python n'a été exporté. L'archive n'est pas créée."
    }

    Compress-Archive -Path "$tempRoot\*" -DestinationPath $archivePath -Force

    if (-not (Test-Path $archivePath -PathType Leaf)) {
        throw "L'archive n'a pas été créée."
    }

    $archiveSizeMb = [Math]::Round(
        (Get-Item $archivePath).Length / 1MB,
        2
    )

    Write-Host ""
    Write-Host "Archive créée avec succès" -ForegroundColor Green
    Write-Host "Chemin      : $archivePath"
    Write-Host "Fichiers    : $($exportedFiles.Count)"
    Write-Host "Python      : $pythonCount"
    Write-Host "Taille      : $archiveSizeMb Mo"
    Write-Host ""
    Write-Host "Le fichier _MANIFESTE_EXPORT_NOVOSKILL.txt permet de vérifier le contenu."
}
finally {
    Pop-Location
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
