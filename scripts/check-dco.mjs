#!/usr/bin/env node
// DCO trailer check (WS-44, SC-13) — a small OWNED script, deliberately not a
// CLA bot or third-party DCO GitHub App.
//
// Asserts every commit in a range carries a Developer Certificate of Origin
// sign-off trailer:
//
//     Signed-off-by: Name <email@host>
//
// Usage:
//     node scripts/check-dco.mjs <rev-range>      # e.g. origin/main..HEAD
//     node scripts/check-dco.mjs --self-test      # deterministic accept/reject proof
//
// Exit codes: 0 = every commit signed off; 1 = at least one offender (each is
// printed as "<sha> <first message line>") or a usage/self-test failure.
//
// EXEMPTIONS (both stated in CONTRIBUTING.md):
//   1. Merge commits (any commit with more than one parent). GitHub's merge
//      button, merge queue, and pull_request test-merge commits ("Merge <sha>
//      into <sha>") are authored by the platform and cannot be signed off;
//      exempting on parent count matches standard DCO-bot behavior.
//   2. History predating DCO adoption. The DCO was adopted in commit
//      626eb9c2 (WS-44); commits that are ancestors of that commit were
//      authored before the requirement existed and are not retroactively
//      rejected. The boundary is skipped gracefully in forks/repos where the
//      adoption commit is unknown.
//
// --self-test creates a throwaway git repo containing one commit WITH the
// trailer and one WITHOUT, runs the same check logic against each, and asserts
// accept/reject respectively — so CI demonstrates the check "actually running"
// on every PR, independent of that PR's own commits.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIGNOFF_RE = /^Signed-off-by: .+ <.+@.+>$/m;

/** Run git with args in cwd, returning trimmed stdout. */
function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// The commit that adopted the DCO (WS-44). Commits that are ancestors of it
// predate the requirement and are exempt.
const DCO_ADOPTION_COMMIT = '626eb9c2edfed1fc15e7ff729dd05dee1a4870b9';

/** True when `sha` is an ancestor of the DCO adoption commit (pre-adoption
 * history). Returns false when the adoption commit is unknown (fork/self-test
 * repos) so the check simply applies to everything. */
function predatesAdoption(sha, cwd) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, DCO_ADOPTION_COMMIT], {
      cwd,
      stdio: 'ignore',
    });
    return sha !== DCO_ADOPTION_COMMIT; // the adoption commit itself is signed
  } catch {
    return false;
  }
}

/**
 * Check every commit in `range` (git rev-range syntax) inside `cwd`.
 * Returns { checked, offenders } where offenders is [{ sha, firstLine }].
 */
export function checkRange(range, cwd = process.cwd()) {
  const shas = git(['rev-list', '--reverse', range], cwd).split('\n').filter(Boolean);
  const offenders = [];
  let checked = 0;
  for (const sha of shas) {
    const message = git(['show', '-s', '--format=%B', sha], cwd);
    const parents = git(['show', '-s', '--format=%P', sha], cwd).trim();
    const parentCount = parents === '' ? 0 : parents.split(/\s+/).length;
    if (parentCount >= 2) {
      console.log(`  – ${sha.slice(0, 10)} exempt (merge commit)`);
      continue;
    }
    if (predatesAdoption(sha, cwd)) {
      console.log(`  – ${sha.slice(0, 10)} exempt (predates DCO adoption)`);
      continue;
    }
    checked += 1;
    if (!SIGNOFF_RE.test(message)) {
      offenders.push({ sha, firstLine: message.split('\n')[0] ?? '' });
    }
  }
  return { checked, offenders };
}

function reportAndExit({ checked, offenders }) {
  if (offenders.length > 0) {
    console.error(`\nDCO check FAILED — ${offenders.length} commit(s) lack a Signed-off-by trailer:`);
    for (const o of offenders) console.error(`  ✗ ${o.sha} ${o.firstLine}`);
    console.error(
      '\nEvery commit must carry "Signed-off-by: Name <email>" (git commit -s).\n' +
        'Fix with `git commit --amend -s --no-edit` or `git rebase --signoff`.\n' +
        'See CONTRIBUTING.md and the DCO file.',
    );
    process.exit(1);
  }
  console.log(`DCO check passed — ${checked} commit(s) signed off. ✓`);
}

// ── --self-test: deterministic accept/reject proof (SC-13) ──────────────────
function selfTest() {
  const repo = mkdtempSync(join(tmpdir(), 'dco-selftest-'));
  try {
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'user.name', 'DCO Self Test'], repo);
    git(['config', 'user.email', 'dco-self-test@example.com'], repo);
    // git commit runs hooks/signing from the ambient config; disable both so
    // the self-test is hermetic.
    git(['config', 'commit.gpgsign', 'false'], repo);

    // Base commit so both test commits have a parent to range from.
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(['add', 'base.txt'], repo);
    git(['commit', '-q', '-m', 'base\n\nSigned-off-by: DCO Self Test <dco-self-test@example.com>'], repo);
    const baseSha = git(['rev-parse', 'HEAD'], repo).trim();

    writeFileSync(join(repo, 'a.txt'), 'signed\n');
    git(['add', 'a.txt'], repo);
    git(
      ['commit', '-q', '-m', 'signed commit\n\nSigned-off-by: DCO Self Test <dco-self-test@example.com>'],
      repo,
    );
    const signedSha = git(['rev-parse', 'HEAD'], repo).trim();

    writeFileSync(join(repo, 'b.txt'), 'unsigned\n');
    git(['add', 'b.txt'], repo);
    git(['commit', '-q', '-m', 'unsigned commit'], repo);
    const unsignedSha = git(['rev-parse', 'HEAD'], repo).trim();

    // 1) The signed commit alone must be ACCEPTED.
    const accept = checkRange(`${baseSha}..${signedSha}`, repo);
    if (accept.offenders.length !== 0 || accept.checked !== 1) {
      console.error('SELF-TEST FAILED: the signed-off commit was not accepted.');
      process.exit(1);
    }
    console.log(`  ✓ self-test: signed commit ${signedSha.slice(0, 10)} accepted`);

    // 2) The unsigned commit must be REJECTED, with its SHA named.
    const reject = checkRange(`${signedSha}..${unsignedSha}`, repo);
    if (reject.offenders.length !== 1 || reject.offenders[0].sha !== unsignedSha) {
      console.error('SELF-TEST FAILED: the unsigned commit was not rejected.');
      process.exit(1);
    }
    console.log(
      `  ✓ self-test: unsigned commit ${unsignedSha.slice(0, 10)} rejected ` +
        `("${reject.offenders[0].firstLine}")`,
    );

    console.log('DCO self-test passed: accepts signed-off commits, rejects unsigned ones. ✓');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── entrypoint ───────────────────────────────────────────────────────────────
const arg = process.argv[2];
if (arg === '--self-test') {
  selfTest();
} else if (arg) {
  console.log(`Checking DCO sign-off on range: ${arg}`);
  reportAndExit(checkRange(arg));
} else {
  console.error('Usage: node scripts/check-dco.mjs <rev-range> | --self-test');
  process.exit(1);
}
