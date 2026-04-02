<#
.SYNOPSIS
    Automated workstream execution via Claude Code CLI.
    Builds the Swift Agent platform by running each workstream spec sequentially
    with verification gates and git checkpoints between each.

.PARAMETER StartFrom
    Workstream ID prefix to resume from (e.g., "ws-06"). Defaults to "ws-01".

.PARAMETER DryRun
    Print the execution plan without invoking Claude Code.

.PARAMETER SkipTests
    Skip `pnpm test` in verification gates (useful if Testcontainers/Docker isn't available).

.PARAMETER MaxTurns
    Max agentic turns per workstream. Default 200. No hard upper limit in Claude Code.

.PARAMETER BudgetPerWs
    Max USD spend per workstream invocation. Default 0 (no limit).
    Acts as a cost safety net independent of turn count.

.EXAMPLE
    .\build-product.ps1
    .\build-product.ps1 -StartFrom ws-06
    .\build-product.ps1 -DryRun
    .\build-product.ps1 -MaxTurns 300 -BudgetPerWs 5.00
#>
param(
    [string]$StartFrom = "ws-01",
    [switch]$DryRun,
    [switch]$SkipTests,
    [int]$MaxTurns = 300,
    [double]$BudgetPerWs = 30.00
)

$ErrorActionPreference = "Stop"

# --- Workstreams in dependency-safe execution order ---
$workstreams = @(
    @{ id = "ws-01"; file = "tasks/product-x/ws-01-foundation.md";          name = "Project Foundation & Monorepo Setup" }
    @{ id = "ws-02"; file = "tasks/product-x/ws-02-shared-types.md";        name = "Shared Types & Protocol Definitions" }
    @{ id = "ws-03"; file = "tasks/product-x/ws-03-database.md";            name = "Database & Data Access Layer" }
    @{ id = "ws-04a"; file = "tasks/product-x/ws-04a-model-types-registry.md"; name = "Model Types & Registry" }
    @{ id = "ws-05a"; file = "tasks/product-x/ws-05a-tool-executor.md";     name = "Tool Executor" }
    @{ id = "ws-04b"; file = "tasks/product-x/ws-04b-provider-implementations.md"; name = "Provider Implementations" }
    @{ id = "ws-05b"; file = "tasks/product-x/ws-05b-core-loop-engine.md";  name = "Core Loop, Engine & Memory" }
    @{ id = "ws-07"; file = "tasks/product-x/ws-07-control-plane-api.md";   name = "Control Plane API" }
    @{ id = "ws-08"; file = "tasks/product-x/ws-08-server-sdk.md";          name = "Server SDK" }
    @{ id = "ws-09"; file = "tasks/product-x/ws-09-client-sdks.md";         name = "Client SDKs" }
    @{ id = "ws-10"; file = "tasks/product-x/ws-10-observability-e2e.md";   name = "Observability E2E" }
    @{ id = "ws-06"; file = "tasks/product-x/ws-06-gateway.md";             name = "Realtime WebSocket Gateway" }
    @{ id = "ws-11"; file = "tasks/product-x/ws-11-service-composition.md"; name = "Service Composition" }
    @{ id = "ws-12"; file = "tasks/product-x/ws-12-ci-cd-deployment.md";    name = "CI/CD & Deployment" }
    @{ id = "ws-13a"; file = "tasks/product-x/ws-13a-terraform-foundation.md"; name = "Terraform Foundation" }
    @{ id = "ws-13b"; file = "tasks/product-x/ws-13b-ecs-deploy-workflows.md"; name = "ECS Deploy Workflows" }
)

# --- Resolve start index ---
$startIndex = -1
for ($i = 0; $i -lt $workstreams.Count; $i++) {
    if ($workstreams[$i].id -like "$StartFrom*") {
        $startIndex = $i
        break
    }
}
if ($startIndex -lt 0) {
    Write-Error "Unknown workstream: $StartFrom. Valid IDs: $($workstreams | ForEach-Object { $_.id } | Join-String -Separator ', ')"
    exit 1
}

# --- Setup ---
$logDir = "build-logs"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

$totalTime = [System.Diagnostics.Stopwatch]::StartNew()

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Swift Agent — Automated Build Pipeline"     -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Workstreams : $($startIndex + 1) to $($workstreams.Count) of $($workstreams.Count)"
Write-Host "  Start from  : $($workstreams[$startIndex].id) — $($workstreams[$startIndex].name)"
Write-Host "  Log dir     : $logDir/"
Write-Host "  Dry run     : $DryRun"
Write-Host "  Skip tests  : $SkipTests"
Write-Host "  Max turns   : $MaxTurns per workstream"
Write-Host "  Budget cap  : $(if ($BudgetPerWs -gt 0) { "`$$BudgetPerWs per workstream" } else { 'none (unlimited)' })"
Write-Host ""

if ($DryRun) {
    Write-Host "--- DRY RUN: Execution Plan ---" -ForegroundColor Yellow
    for ($i = $startIndex; $i -lt $workstreams.Count; $i++) {
        $ws = $workstreams[$i]
        Write-Host "  [$($i + 1)] $($ws.id) — $($ws.name)" -ForegroundColor White
        Write-Host "       Spec: $($ws.file)" -ForegroundColor Gray
    }
    Write-Host ""
    Write-Host "Run without -DryRun to execute." -ForegroundColor Yellow
    exit 0
}

# --- Main loop ---
for ($i = $startIndex; $i -lt $workstreams.Count; $i++) {
    $ws = $workstreams[$i]
    $specFile = $ws.file
    $logFile = Join-Path $logDir "$($ws.id).log"
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $wsTimer = [System.Diagnostics.Stopwatch]::StartNew()

    Write-Host ""
    Write-Host "[$timestamp] === $($ws.id): $($ws.name) ($($i + 1)/$($workstreams.Count)) ===" -ForegroundColor Cyan

    # --- Build the prompt ---
    $testInstruction = if ($SkipTests) { "Skip 'pnpm test' — test infrastructure not available." } else { "Run 'pnpm test' and fix any test failures." }

    $prompt = @"
You are implementing workstream '$($ws.id): $($ws.name)' for the Swift Agent platform.

STEP 1 — CONTEXT:
- Read the workstream spec: $specFile
- Read swift-agent.md for product context (architecture, data model, API surface)
- Read CLAUDE.md for coding conventions and dependency versions

STEP 2 — IMPLEMENT:
- Implement EVERY file listed in the spec's "Files Touched" section
- Follow the "Implementation Steps" precisely — they are ordered intentionally
- Where the spec references types or functions from other @swiftagent/* packages, import from whatever those packages currently export (they were built in prior workstreams)
- Write comprehensive tests as described in the "Tests" section of the spec

STEP 3 — VERIFY (mandatory, do not skip):
- Run: pnpm build
- Run: pnpm typecheck
- Run: pnpm lint --quiet (if eslint is configured; ignore if not yet set up)
- $testInstruction
- Fix ALL errors. Re-run verification after fixes. Repeat until clean.
- Do NOT report success until every verification command exits 0.

RULES:
- Read each file before editing. Re-read after editing to confirm the change applied.
- If you need to install new dependencies, use 'pnpm add' with exact version ranges from CLAUDE.md.
- If a prior workstream left a stub or placeholder that your workstream should replace, replace it fully.
- If a test requires infrastructure not yet available, mock it — but make the mock realistic enough to validate behavior.
"@

    # --- Execute Claude Code ---
    Write-Host "  Invoking Claude Code (max-turns $MaxTurns)..." -ForegroundColor Gray

    $claudeArgs = @("-p", $prompt, "--dangerously-skip-permissions", "--max-turns", $MaxTurns)
    if ($BudgetPerWs -gt 0) { $claudeArgs += @("--max-budget-usd", $BudgetPerWs) }

    & claude @claudeArgs 2>&1 | Tee-Object -FilePath $logFile

    $claudeExit = $LASTEXITCODE
    if ($claudeExit -ne 0) {
        Write-Host "  Claude Code exited with code $claudeExit" -ForegroundColor Red
    }

    # --- Verification gate ---
    Write-Host "  Running verification gate..." -ForegroundColor Gray
    $gatePass = $true

    # Build
    $buildOutput = pnpm build 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  FAIL: pnpm build" -ForegroundColor Red
        $gatePass = $false
    } else {
        Write-Host "  PASS: pnpm build" -ForegroundColor Green
    }

    # Typecheck
    $tcOutput = pnpm typecheck 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  FAIL: pnpm typecheck" -ForegroundColor Red
        $gatePass = $false
    } else {
        Write-Host "  PASS: pnpm typecheck" -ForegroundColor Green
    }

    # Tests (optional)
    if (-not $SkipTests) {
        $testOutput = pnpm test 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  FAIL: pnpm test" -ForegroundColor Red
            $gatePass = $false
        } else {
            Write-Host "  PASS: pnpm test" -ForegroundColor Green
        }
    }

    # --- Auto-fix attempt if gate failed ---
    if (-not $gatePass) {
        Write-Host "  Verification failed — attempting auto-fix..." -ForegroundColor Yellow

        $fixPrompt = @"
The verification gate failed after implementing workstream '$($ws.id): $($ws.name)'.

Run these commands, read the full error output, and fix every issue:
1. pnpm build
2. pnpm typecheck
3. pnpm test (if tests exist)

Common causes:
- Missing imports or exports in barrel files (index.ts)
- Type mismatches between packages (check @swiftagent/shared types)
- Missing dependencies in package.json (use 'pnpm add' with versions from CLAUDE.md)

Fix ALL errors. Re-run verification after each fix. Do not stop until every command exits 0.
"@

        $fixArgs = @("-p", $fixPrompt, "--dangerously-skip-permissions", "--max-turns", [math]::Floor($MaxTurns / 2))
        if ($BudgetPerWs -gt 0) { $fixArgs += @("--max-budget-usd", $BudgetPerWs) }

        & claude @fixArgs 2>&1 | Tee-Object -Append -FilePath $logFile

        # Re-verify
        Write-Host "  Re-running verification gate..." -ForegroundColor Gray
        $gatePass = $true

        pnpm build 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { $gatePass = $false; Write-Host "  STILL FAILING: pnpm build" -ForegroundColor Red }

        pnpm typecheck 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { $gatePass = $false; Write-Host "  STILL FAILING: pnpm typecheck" -ForegroundColor Red }

        if (-not $gatePass) {
            Write-Host ""
            Write-Host "  AUTO-FIX FAILED for $($ws.id). Manual intervention required." -ForegroundColor Red
            Write-Host "  Review: $logFile" -ForegroundColor Yellow
            Write-Host "  Resume: .\build-product.ps1 -StartFrom $($ws.id)" -ForegroundColor Yellow
            Write-Host ""
            $totalTime.Stop()
            Write-Host "  Total elapsed: $([math]::Round($totalTime.Elapsed.TotalMinutes, 1)) minutes" -ForegroundColor Gray
            exit 1
        }

        Write-Host "  Auto-fix succeeded." -ForegroundColor Green
    }

    # --- Git checkpoint ---
    git add -A 2>&1 | Out-Null
    $commitMsg = "feat($($ws.id)): $($ws.name)"
    git commit -m $commitMsg --no-verify 2>&1 | Out-Null

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Committed: $commitMsg" -ForegroundColor Green
    } else {
        Write-Host "  No changes to commit (already clean)" -ForegroundColor Gray
    }

    $wsTimer.Stop()
    Write-Host "  Duration: $([math]::Round($wsTimer.Elapsed.TotalMinutes, 1)) minutes" -ForegroundColor Gray
}

# --- Summary ---
$totalTime.Stop()
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  ALL WORKSTREAMS COMPLETE"                    -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Total elapsed: $([math]::Round($totalTime.Elapsed.TotalMinutes, 1)) minutes"
Write-Host "  Git log:"
git log --oneline -n $($workstreams.Count) 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
Write-Host ""
Write-Host "  Next steps:"
Write-Host "    1. Review the git log and spot-check key files"
Write-Host "    2. Run 'docker compose up' to test locally (after WS-12)"
Write-Host "    3. Set real API keys in .env for model provider testing"
Write-Host ""
