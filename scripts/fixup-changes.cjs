#!/usr/bin/env node

/**
 * Groups unstaged changes by the commit that last touched those lines (via `git
 * blame`) and stages+commits each group as `git commit --fixup=<sha>`.
 *
 * Only commits between the branch's merge-base with `--base` (default: the
 * remote's default branch, e.g. origin/main) and HEAD are considered fixup
 * targets. A hunk that blames to a commit outside that range, or to no
 * commit at all (new file / new lines), is left as a regular unstaged
 * change and reported instead, since rewriting shared history is unsafe.
 * Refuses to run at all on the repo's default branch (detected the same way
 * as `--base`, via origin/HEAD).
 *
 * Usage:
 *   node scripts/fixup-changes.cjs --dry-run [--base=<ref>] [--target=<sha>]
 *   node scripts/fixup-changes.cjs [--base=<ref>] [--target=<sha>]
 *
 * --dry-run prints the grouping and the exact commands that would run,
 * without staging, committing, or pushing anything. Without --dry-run, it
 * creates the fixup commits, then runs `git rebase --autosquash` and
 * `git push --force-with-lease` to squash and push them.
 *
 * --target=<sha> restricts the run to a single target commit's hunks (match
 * by any unique sha prefix), leaving every other group unstaged. Useful on a
 * branch where autosquash conflicts a lot: fix up and rebase one commit at a
 * time instead of all of them in one rebase.
 *
 * Note: the order fixup commits are *created* in has no effect on rebase
 * conflicts — `--autosquash` always replays each one right after its target,
 * regardless of creation order. Conflicts happen when some *other* commit on
 * the branch also touched the same lines after the target commit; the
 * "later commits touch this file" count next to each group is a rough proxy
 * for that risk.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const { writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

/**
 * Runs a git command and returns its stdout, throwing with stderr on failure.
 * @param {string[]} args
 * @returns {string}
 */
const git = (args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });

/**
 * @param {string[]} argv
 * @returns {{ dryRun: boolean, base: string | null }}
 */
const parseArgs = (argv) => {
  const dryRun = argv.includes('--dry-run');
  const baseArg = argv.find((arg) => arg.startsWith('--base='));
  const base = baseArg ? baseArg.slice('--base='.length) : null;
  const targetArg = argv.find((arg) => arg.startsWith('--target='));
  const target = targetArg ? targetArg.slice('--target='.length) : null;
  return { dryRun, base, target };
};

/**
 * Aborts if the index already has staged changes, since this script only
 * groups unstaged changes and would otherwise mix the two.
 * @returns {void}
 */
const ensureNoStagedChanges = () => {
  const staged = git(['diff', '--cached', '--name-only']).trim();

  if (staged) {
    console.error(
      'Aborting: you have staged changes. Commit or unstage them first — ' +
        'this script only groups unstaged changes.',
    );
    process.exit(1);
  }
};

/**
 * @param {string | null} base
 * @returns {string}
 */
const resolveBase = (base) => {
  if (base) return base;

  try {
    return git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
  } catch {
    return 'main';
  }
};

/**
 * Aborts if run directly on the repo's default branch (the same one `--base`
 * resolves to), since fixup commits only make sense relative to a feature
 * branch's own commits.
 * @returns {void}
 */
const ensureNotOnDefaultBranch = () => {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const defaultBranch = resolveBase(null).replace(/^origin\//, '');

  if (branch === defaultBranch) {
    console.error(
      `Aborting: you're on '${branch}', this repo's default branch. Check out ` +
        'a feature branch first — fixup commits only make sense relative to ' +
        "that branch's own commits.",
    );
    process.exit(1);
  }
};

/**
 * @param {string} sha
 * @returns {string}
 */
const shortSha = (sha) => sha.slice(0, 7);

/**
 * Commits unique to the current branch, keyed by full sha, newest first —
 * these are the only valid fixup targets.
 * @param {string} mergeBase
 * @returns {Map<string, string>}
 */
const getCandidateCommits = (mergeBase) => {
  const out = git(['log', '--format=%H%x1f%s', `${mergeBase}..HEAD`]);
  const map = new Map();

  for (const line of out.split('\n')) {
    if (!line) continue;
    const [sha, subject] = line.split('\x1f');
    map.set(sha, subject);
  }

  return map;
};

/**
 * Resolves --target to a full candidate sha by unique prefix match, or
 * aborts if it doesn't match exactly one candidate commit.
 * @param {string | null} targetArg
 * @param {Map<string, string>} candidateShas
 * @returns {string | null}
 */
const resolveTarget = (targetArg, candidateShas) => {
  if (!targetArg) return null;

  const matches = [...candidateShas.keys()].filter((sha) =>
    sha.startsWith(targetArg),
  );
  if (matches.length !== 1) {
    console.error(
      `Aborting: --target=${targetArg} matches ${matches.length} candidate commit(s), expected exactly 1.`,
    );
    process.exit(1);
  }
  return matches[0];
};

/**
 * Counts commits strictly after `sha` that also touched `file` — a rough
 * proxy for how likely `--autosquash` is to conflict when replaying a fixup
 * for `sha` back to that point in history.
 * @param {string} sha
 * @param {string} file
 * @returns {number}
 */
const countLaterTouches = (sha, file) =>
  git(['log', '--format=%H', `${sha}..HEAD`, '--', file])
    .split('\n')
    .filter(Boolean).length;

/**
 * @typedef {{ oldStart: number, oldLines: number, newStart: number, newLines: number, text: string }} Hunk
 * @typedef {{ path: string, headerLines: string[], isNewFile: boolean, isDeletedFile: boolean, isBinary: boolean, isRename: boolean, hunks: Hunk[] }} FileDiff
 */

/**
 * Parses `git diff` output into per-file hunks. Each hunk keeps its original
 * header line and body verbatim so it can be reassembled into a standalone
 * patch later.
 * @param {string} diffText
 * @returns {FileDiff[]}
 */
const parseDiff = (diffText) => {
  const lines = diffText.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  /** @type {FileDiff[]} */
  const files = [];
  /** @type {FileDiff | null} */
  let current = null;
  /** @type {Hunk | null} */
  let currentHunk = null;

  const pushHunk = () => {
    if (current && currentHunk) current.hunks.push(currentHunk);
    currentHunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      pushHunk();
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      current = {
        path: match ? match[2] : '',
        headerLines: [line],
        isNewFile: false,
        isDeletedFile: false,
        isBinary: false,
        isRename: false,
        hunks: [],
      };
      files.push(current);
      continue;
    }

    if (!current) continue;

    if (line.startsWith('@@ ')) {
      pushHunk();
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      currentHunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        text: `${line}\n`,
      };
      continue;
    }

    if (currentHunk) {
      currentHunk.text += `${line}\n`;
      continue;
    }

    current.headerLines.push(line);
    if (line.startsWith('new file mode')) current.isNewFile = true;
    if (line.startsWith('deleted file mode')) current.isDeletedFile = true;
    if (line.startsWith('rename from') || line.startsWith('rename to')) {
      current.isRename = true;
    }
    if (line.startsWith('Binary files')) current.isBinary = true;
  }
  pushHunk();

  return files.filter((f) => f.path);
};

/**
 * Maps each line number in `file` at HEAD to the sha that last touched it.
 * Returns null if the file has no HEAD history (e.g. it's new).
 * @param {string} file
 * @returns {string[] | null}
 */
const getBlameShas = (file) => {
  let out;
  try {
    out = git(['blame', '--line-porcelain', 'HEAD', '--', file]);
  } catch {
    return null;
  }

  const shas = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (m) shas[Number(m[2])] = m[1];
  }
  return shas;
};

/**
 * @param {string[]} shas
 * @param {number} from
 * @param {number} to
 * @returns {string | null}
 */
const majoritySha = (shas, from, to) => {
  const counts = new Map();
  for (let i = from; i <= to; i += 1) {
    const sha = shas[i];
    if (!sha) continue;
    counts.set(sha, (counts.get(sha) || 0) + 1);
  }

  let best = null;
  let bestCount = 0;
  for (const [sha, count] of counts) {
    if (count > bestCount) {
      best = sha;
      bestCount = count;
    }
  }
  return best;
};

/**
 * @param {string[]} shas
 * @param {Hunk} hunk
 * @returns {string | null}
 */
const targetForHunk = (shas, hunk) => {
  if (hunk.oldLines > 0) {
    return majoritySha(shas, hunk.oldStart, hunk.oldStart + hunk.oldLines - 1);
  }
  // Pure insertion: attribute it to whoever owns the line right before it.
  const anchor = Math.max(1, Math.min(hunk.oldStart, shas.length - 1));
  return majoritySha(shas, anchor, anchor);
};

/**
 * @typedef {{ sha: string, hunks: Hunk[] }} Run
 */

/**
 * @typedef {{ category: 'external' | 'new' | 'manual', reason: string, hunks: Hunk[] }} SkippedEntry
 */

/**
 * Splits a file's hunks into runs of consecutive hunks that blame to the same
 * candidate commit. Hunks that don't belong to a commit on this branch are
 * reported as skipped instead of turned into a run:
 *  - 'external': blames to a real commit, but one outside this branch
 *  - 'new': no prior history to blame at all (new file, or new lines with
 *    nothing above them to anchor to)
 *  - 'manual': renames/binary files, which this script doesn't attempt to split
 * @param {FileDiff} fileDiff
 * @param {Set<string>} candidateShas
 * @returns {{ runs: Run[], skipped: SkippedEntry[] }}
 */
const buildFileRuns = (fileDiff, candidateShas) => {
  if (fileDiff.isBinary || fileDiff.isRename) {
    const reason = fileDiff.isRename
      ? 'rename, handle manually'
      : 'binary file';
    return {
      runs: [],
      skipped: fileDiff.hunks.length
        ? [{ category: 'manual', reason, hunks: fileDiff.hunks }]
        : [],
    };
  }

  if (fileDiff.isNewFile) {
    return {
      runs: [],
      skipped: fileDiff.hunks.length
        ? [
            {
              category: 'new',
              reason: 'new file, no prior history',
              hunks: fileDiff.hunks,
            },
          ]
        : [],
    };
  }

  const shas = getBlameShas(fileDiff.path);
  if (!shas) {
    return {
      runs: [],
      skipped: [
        { category: 'manual', reason: 'blame failed', hunks: fileDiff.hunks },
      ],
    };
  }

  const sortedHunks = [...fileDiff.hunks].sort(
    (a, b) => a.oldStart - b.oldStart,
  );
  /** @type {Run[]} */
  const runs = [];
  /** @type {SkippedEntry[]} */
  const skipped = [];
  /** @type {Run | null} */
  let currentRun = null;

  for (const hunk of sortedHunks) {
    const sha = targetForHunk(shas, hunk);
    const isCandidate = sha && candidateShas.has(sha);

    if (!isCandidate) {
      const entry = sha
        ? {
            category: 'external',
            reason: `belongs to ${shortSha(sha)}, outside this branch`,
          }
        : { category: 'new', reason: 'no prior history at this location' };
      skipped.push({ ...entry, hunks: [hunk] });
      currentRun = null;
      continue;
    }

    if (currentRun && currentRun.sha === sha) {
      currentRun.hunks.push(hunk);
    } else {
      currentRun = { sha, hunks: [hunk] };
      runs.push(currentRun);
    }
  }

  return { runs, skipped };
};

/**
 * Reassembles a run into a standalone patch git can apply on its own.
 * @param {FileDiff} fileDiff
 * @param {Run} run
 * @returns {string}
 */
const buildRunPatch = (fileDiff, run) =>
  `${fileDiff.headerLines.join('\n')}\n${run.hunks.map((h) => h.text).join('')}`;

/**
 * @param {Hunk} hunk
 * @returns {string}
 */
const describeRange = (hunk) => {
  if (hunk.oldLines === 0) return `insert near line ${hunk.oldStart}`;
  if (hunk.oldLines === 1) return `line ${hunk.oldStart}`;
  return `lines ${hunk.oldStart}-${hunk.oldStart + hunk.oldLines - 1}`;
};

/**
 * @param {string} title
 * @param {{ file: string, reason: string, hunks: Hunk[] }[]} entries
 * @returns {void}
 */
const printSkippedSection = (title, entries) => {
  if (!entries.length) return;
  console.log(title);
  for (const e of entries) {
    console.log(
      `    ${e.file}: ${e.hunks.map(describeRange).join(', ')} — ${e.reason}`,
    );
  }
  console.log('');
};

/**
 * Prints, upfront, everything that will be left unstaged, then the fixup
 * grouping, then the exact commands that either would run (--dry-run) or
 * are about to run.
 * @param {object} params
 * @param {Map<string, { file: string, hunks: Hunk[] }[]>} params.groups
 * @param {Map<string, string>} params.candidateShas
 * @param {{ fileDiff: FileDiff, skipped: SkippedEntry[] }[]} params.perFile
 * @param {{ file: string, run: Run }[]} params.queue
 * @param {string} params.mergeBase
 * @param {string} params.base
 * @param {boolean} params.dryRun
 * @returns {void}
 */
const printPlan = ({
  groups,
  candidateShas,
  perFile,
  queue,
  mergeBase,
  base,
  dryRun,
}) => {
  console.log(`Base: ${base} (merge-base ${shortSha(mergeBase)})\n`);

  const skippedByCategory = { external: [], new: [], manual: [] };
  for (const { fileDiff, skipped } of perFile) {
    for (const s of skipped) {
      skippedByCategory[s.category].push({ file: fileDiff.path, ...s });
    }
  }
  const skippedTotal =
    skippedByCategory.external.length +
    skippedByCategory.new.length +
    skippedByCategory.manual.length;

  if (skippedTotal) {
    console.log(
      `${skippedTotal} hunk(s) will be left unstaged — the rest will still be fixed up:\n`,
    );
    printSkippedSection(
      "Not part of this branch (belong to a commit already on '" + base + "'):",
      skippedByCategory.external,
    );
    printSkippedSection(
      'Completely new (no prior commit to fix up):',
      skippedByCategory.new,
    );
    printSkippedSection(
      'Needs manual handling (rename/binary/blame failure):',
      skippedByCategory.manual,
    );
  }

  const orderedShas = [...candidateShas.keys()]
    .reverse()
    .filter((sha) => groups.has(sha));

  if (orderedShas.length === 0) {
    console.log('No unstaged hunks matched a commit in this branch.\n');
  }

  orderedShas.forEach((sha, index) => {
    console.log(
      `[${index + 1}/${orderedShas.length}] fixup! ${shortSha(sha)} ${candidateShas.get(sha)}`,
    );
    for (const { file, hunks } of groups.get(sha)) {
      console.log(`    ${file}: ${hunks.map(describeRange).join(', ')}`);
    }
    console.log(`    -> git commit --fixup=${sha}\n`);
  });

  if (queue.length) {
    console.log(
      `Commands that would run, in order (${dryRun ? 'dry run' : 'executing'}):`,
    );
    for (const { file, run } of queue) {
      console.log(
        `  git apply --cached   # ${file}: ${run.hunks.map(describeRange).join(', ')}`,
      );
      console.log(`  git commit --fixup=${shortSha(run.sha)} --no-edit`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log(
      'After the fixup commits exist, review them, then squash and push yourself:',
    );
    console.log(`  git rebase --autosquash ${shortSha(mergeBase)}`);
    console.log('  git push --force-with-lease');
  } else {
    console.log(
      `Then: git rebase --autosquash ${shortSha(mergeBase)} && git push --force-with-lease`,
    );
  }
};

/**
 * Applies and commits each queued run, bottom-of-file first so an already
 * applied run never shifts the line numbers a not-yet-applied run above it
 * was computed against.
 * @param {{ fileDiff: FileDiff, run: Run }[]} queue
 * @returns {void}
 */
const executeQueue = (queue) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fixup-changes-'));
  try {
    queue.forEach(({ fileDiff, run }, index) => {
      const patchPath = path.join(dir, `patch-${index}.diff`);
      writeFileSync(patchPath, buildRunPatch(fileDiff, run));
      git(['apply', '--cached', patchPath]);
      git(['commit', `--fixup=${run.sha}`, '--no-edit']);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Squashes every fixup commit into its target (autosquash reorders and
 * squashes purely from the `fixup!` subjects, so no editor is needed), then
 * pushes the result.
 * @param {string} mergeBase
 * @returns {void}
 */
const rebaseAndPush = (mergeBase) => {
  // Repeated/near-identical conflicts (common on branches with many small
  // mechanical commits) auto-resolve after the first fix once rerere is on.
  git(['config', 'rerere.enabled', 'true']);

  execFileSync('git', ['rebase', '--autosquash', mergeBase], {
    stdio: 'inherit',
    env: { ...process.env, GIT_SEQUENCE_EDITOR: 'true' },
  });
  execFileSync('git', ['push', '--force-with-lease'], { stdio: 'inherit' });
};

const main = () => {
  const {
    dryRun,
    base: baseArg,
    target: targetArg,
  } = parseArgs(process.argv.slice(2));

  ensureNotOnDefaultBranch();
  ensureNoStagedChanges();

  const base = resolveBase(baseArg);
  const mergeBase = git(['merge-base', 'HEAD', base]).trim();
  const candidateShas = getCandidateCommits(mergeBase);
  const target = resolveTarget(targetArg, candidateShas);

  const diffText = git(['diff', '--no-color', '-U3']);
  if (!diffText.trim()) {
    console.log('No unstaged changes.');
    return;
  }

  const fileDiffs = parseDiff(diffText);
  const candidateShaSet = new Set(candidateShas.keys());
  const perFile = fileDiffs.map((fileDiff) => ({
    fileDiff,
    ...buildFileRuns(fileDiff, candidateShaSet),
  }));

  const groups = new Map();
  for (const { fileDiff, runs } of perFile) {
    for (const run of runs) {
      if (!groups.has(run.sha)) groups.set(run.sha, []);
      groups.get(run.sha).push({ file: fileDiff.path, hunks: run.hunks });
    }
  }

  const queue = [];
  for (const { fileDiff, runs } of perFile) {
    // Bottom of the file first; independent files can interleave freely.
    const sorted = [...runs]
      .filter((run) => !target || run.sha === target)
      .sort((a, b) => b.hunks[0].oldStart - a.hunks[0].oldStart);
    for (const run of sorted)
      queue.push({ file: fileDiff.path, fileDiff, run });
  }

  if (target) {
    console.log(
      `--target=${shortSha(target)}: only that commit's fixups will be created now.\n`,
    );
  }

  printPlan({ groups, candidateShas, perFile, queue, mergeBase, base, dryRun });

  if (dryRun) {
    console.log('\nDry run only — no commits were created.');
    return;
  }

  if (queue.length === 0) {
    console.log('\nNothing to fix up.');
    return;
  }

  executeQueue(queue);
  console.log(`\nCreated ${queue.length} fixup commit(s).`);

  rebaseAndPush(mergeBase);
};

main();
