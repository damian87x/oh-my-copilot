---
name: worktree
description: Guides worktree-based workflow for parallel branch work. Use when user wants to start a new ticket, review a PR, or work on a branch without switching. Also use when user mentions worktree, branch switching, or parallel branch work.
---

# Worktree Workflow

Use `/worktree` to set up a git worktree for a new ticket, PR review, or any branch work.

## Why worktrees?

- Your `main` branch stays untouched
- Work on multiple tickets or reviews in parallel — no stashing, no context-switching
- Each worktree is a full working copy — run tests, build, etc. independently

## New ticket

```bash
cd <repo>
git fetch origin
git worktree add ../<repo>-<ticket-id> -b <ticket-id>
cd ../<repo>-<ticket-id>
```

## PR review

```bash
cd <repo>
git fetch origin
git worktree add ../<repo>-review-<branch> origin/<branch>
cd ../<repo>-review-<branch>
```

## Cleanup

```bash
cd <repo>
git worktree remove ../<repo>-<ticket-id>
# or list all worktrees
git worktree list
```

## Agent behaviour

When the user asks to work on a ticket or review a PR:

1. `cd` into the repo's main clone
2. `git fetch origin`
3. Create a worktree with a descriptive name (ticket number or PR branch)
4. Do all work inside the worktree, not the main clone
5. Remind the user to clean up when the work is done
