# Update Dependencies

A shared job to update all dependencies, build, test, create a pull request, merge it, and delete the update branch.

If you like this, we recommend making your own fork and customizing it to your needs.

# Usage

To use this action, add the following to your workflow file:

```yaml
name: Update Dependencies

on:
  schedule:
    - cron: '0 12 * * 6'  # Every Saturday at 12:00 PM UTC
  workflow_dispatch:

jobs:
  update-dependencies:
    runs-on: ubuntu-latest
    permissions:
      contents: write       # Push branches, merge PRs, delete branches
      pull-requests: write  # Create and merge PRs
      actions: write        # Run optional check workflows
    steps:
      - name: Run dependency update
        uses: cloud-copilot/update-dependencies@main
        with:
          check-workflow: ci.yml
```

By default, the action merges after its own `npm run build` and `npm test` steps pass. If `check-workflow` is set, the action also runs that workflow on the update branch and waits for it to pass before merging.

## Repository setup

Repositories using this action need:

- The workflow permissions above.
- Settings > Actions > General > Workflow permissions > Allow GitHub Actions to create and approve pull requests.
- Branch protection rules that allow this workflow actor to merge after the action's build and test steps pass. Required approving reviews, required PR-only checks, or merge queues can block the final merge step.
- If `check-workflow` is set, that workflow must exist on the default branch and include `workflow_dispatch`.

## Inputs

```yaml
- name: Run dependency update
  uses: cloud-copilot/update-dependencies@main
  with:
    base-branch: main
    merge-method: squash
    check-workflow: ci.yml
    post-merge-workflow: release.yml
```

Available inputs:

- `base-branch`: PR base branch. Defaults to `main`.
- `merge-method`: `squash`, `merge`, or `rebase`. Defaults to `squash`.
- `check-workflow`: optional workflow name, ID, or filename to run on the update branch before merging. Workflow filenames are relative to `.github/workflows`, so use `ci.yml`, not `.github/workflows/ci.yml`.
- `post-merge-workflow`: optional workflow name, ID, or filename to run on the base branch after merging. Workflow filenames are relative to `.github/workflows`, so use `release.yml`, not `.github/workflows/release.yml`.

Example check and post-merge workflow trigger:

```yaml
on:
  pull_request:
  workflow_dispatch:
```

Because merges created with `github.token` do not trigger `push` workflows, use `post-merge-workflow` for workflows such as releases that should run after the dependency PR is merged.
