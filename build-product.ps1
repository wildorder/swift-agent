<#
.SYNOPSIS
    Automated workstream execution via Claude Code CLI.

.PARAMETER Program
    Program ID to execute. Reads workstreams from docs/programs/{Program}-manifest.json.

.PARAMETER StartFrom
    Workstream ID to resume from. Defaults to the first workstream.

.PARAMETER DryRun
    Print the execution plan without invoking Claude Code.

.PARAMETER SkipTests
    Skip test commands in verification gates.

.PARAMETER MaxTurns
    Max agentic turns per workstream. Default 300.

.PARAMETER BudgetPerWs
    Max USD spend per workstream. Default 30.
#>
param(
    [Parameter(Mandatory)][string]$Program,
    [string]$StartFrom = "",
    [switch]$DryRun,
    [switch]$SkipTests,
    [int]$MaxTurns = 300,
    [double]$BudgetPerWs = 30.00
)

$ErrorActionPreference = "Stop"

# --- Load manifest ---
$manifestPath = "docs/programs/$Program-manifest.json"
if (-not (Test-Path $manifestPath)) {
    Write-Error "Manifest not found: $manifestPath"
    exit 1
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$workstreams = $manifest.workstreams | ForEach-Object {
    @{ id = $_.id; file = $_.taskFile; name = $_.name }
}

# --- Resolve start index ---
$startIndex = 0
if ($StartFrom) {
    for ($i = 0; $i -lt $workstreams.Count; $i++) {
        if ($workstreams[$i].id -like "$StartFrom*") {
            $startIndex = $i
            break
        }
    }
}

# --- Setup ---
$logDir = "build-logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$totalTime = [System.Diagnostics.Stopwatch]::StartNew()

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  $($manifest.program.name) — Automated Build" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Program     : $Program"
Write-Host "  Workstreams : $($startIndex + 1) to $($workstreams.Count) of $($workstreams.Count)"
Write-Host "  Start from  : $($workstreams[$startIndex].id) — $($workstreams[$startIndex].name)"
Write-Host "  Log dir     : $logDir/"
Write-Host "  Max turns   : $MaxTurns per workstream"
Write-Host "  Budget cap  : $(if ($BudgetPerWs -gt 0) { "`$$BudgetPerWs" } else { 'none' })"
Write-Host ""

if ($DryRun) {
    Write-Host "--- DRY RUN ---" -ForegroundColor Yellow
    for ($i = $startIndex; $i -lt $workstreams.Count; $i++) {
        $ws = $workstreams[$i]
        Write-Host "  [$($i + 1)] $($ws.id) — $($ws.name)" -ForegroundColor White
        Write-Host "       Spec: $($ws.file)" -ForegroundColor Gray
    }
    exit 0
}

# --- Main loop ---
for ($i = $startIndex; $i -lt $workstreams.Count; $i++) {
    $ws = $workstreams[$i]
    $logFile = Join-Path $logDir "$Program-$($ws.id).log"
    $wsTimer = [System.Diagnostics.Stopwatch]::StartNew()

    Write-Host ""
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] === $($ws.id): $($ws.name) ($($i+1)/$($workstreams.Count)) ===" -ForegroundColor Cyan

    $testInstruction = if ($SkipTests) { "Skip tests." } else { "Run the project's test command and fix failures." }

    $prompt = @"
You are implementing workstream '$($ws.id): $($ws.name)'.

STEP 1 — CONTEXT:
- Read the workstream spec: $($ws.file)
- Read CLAUDE.md for coding conventions
- Read any additional files listed in the spec's "Context Files" section

STEP 2 — IMPLEMENT:
- Implement every file listed in "Files Touched"
- Follow "Implementation Steps" precisely
- Write tests as described in "Tests"

STEP 3 — VERIFY (mandatory):
- Run the project's build command
- Run the project's type-check command
- $testInstruction
- Fix ALL errors. Repeat until clean.

RULES:
- Read each file before editing. Re-read after to confirm.
- (NEW) files: create from scratch. (MODIFY) files: edit existing code.
- If a prior workstream left a stub, replace it fully.
"@

    Write-Host "  Invoking Claude Code..." -ForegroundColor Gray
    $claudeArgs = @("-p", $prompt, "--dangerously-skip-permissions", "--max-turns", $MaxTurns)
    if ($BudgetPerWs -gt 0) { $claudeArgs += @("--max-budget-usd", $BudgetPerWs) }

    & claude @claudeArgs 2>&1 | Tee-Object -FilePath $logFile
    $claudeExit = $LASTEXITCODE

    if ($claudeExit -ne 0) {
        Write-Host "  Claude exited with code $claudeExit — attempting auto-fix..." -ForegroundColor Yellow
        $fixPrompt = "Verification failed after workstream '$($ws.id)'. Run build, typecheck, and tests. Read errors and fix everything. Repeat until all commands exit 0."
        $fixArgs = @("-p", $fixPrompt, "--dangerously-skip-permissions", "--max-turns", [math]::Floor($MaxTurns / 2))
        if ($BudgetPerWs -gt 0) { $fixArgs += @("--max-budget-usd", $BudgetPerWs) }
        & claude @fixArgs 2>&1 | Tee-Object -Append -FilePath $logFile
    }

    # Git checkpoint
    git add -A 2>&1 | Out-Null
    git commit -m "feat($($ws.id)): $($ws.name)" --no-verify 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Committed: feat($($ws.id)): $($ws.name)" -ForegroundColor Green
    }

    $wsTimer.Stop()
    Write-Host "  Duration: $([math]::Round($wsTimer.Elapsed.TotalMinutes, 1)) min" -ForegroundColor Gray
}

$totalTime.Stop()
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  ALL WORKSTREAMS COMPLETE" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Total: $([math]::Round($totalTime.Elapsed.TotalMinutes, 1)) minutes"
Write-Host ""
Write-Host "  Next: test the build, then run /update-as-built"
