# Git Routine

Small standalone scripts for everyday git workflows. No dependencies — plain Node.js.

## install.sh

Symlinks every script in `scripts/` into `/usr/local/bin`, named after the file without
its extension (e.g. `scripts/fixup-changes.cjs` -> `fixup-changes`), so you can run them
by name from anywhere. Run it again after adding new scripts. Won't overwrite a file at
the target path unless it's already a symlink.

```bash
./install.sh
```

## scripts/fixup-changes.cjs

Groups your unstaged changes by the commit that last touched those lines (via `git blame`)
and turns each group into a `git commit --fixup=<sha>`. Hunks that don't belong to a commit
on your branch (new files, or lines that trace back to a commit outside your branch) are
left unstaged and reported instead.

```bash
node scripts/fixup-changes.cjs --dry-run [--base=<ref>]   # show the plan, change nothing
node scripts/fixup-changes.cjs [--base=<ref>]              # create the fixup commits,
                                                             # then autosquash-rebase and push
```

Refuses to run on the repo's default branch.

More git scripts will be added here over time.
