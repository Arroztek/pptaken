# Releasing PPTaken

How a release of the Docker image `ghcr.io/arroztek/pptaken` is cut, what the automation does, and the few clicks
that only the organization owner can make. Everything here is free: the repository is public, the image is a public
package and the workflows use standard GitHub-hosted Linux runners only.

## Versioning policy

- [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`, tags are `vMAJOR.MINOR.PATCH`.
- **Before 1.0.0:** the API and the data format may still change. A **minor** bump (`0.1.0` to `0.2.0`) may contain
  breaking changes, always listed in the changelog under "Changed" or "Removed" together with what to do. A **patch**
  bump (`0.1.0` to `0.1.1`) is only fixes and never needs action from the operator. Database migrations always run
  forward at start after a backup copy of the database, so a downgrade needs a restored backup.
- **From 1.0.0:** breaking changes only in a major release.
- **Pre-releases** use a suffix: `v0.2.0-rc.1`. They get only their exact tag on the registry (no `latest`, no `0.2`,
  no `0`), so nobody gets one by accident.
- The Docker tags of a stable release `X.Y.Z` are `X.Y.Z`, `X.Y`, `X` and `latest`. Pin `X.Y.Z` in production; use
  `X.Y` to follow patch fixes only. Before 1.0.0 the `0` tag moves across minor releases that may break, so avoid it.
- A published tag is **never moved or deleted** (see Rolling back).

Only two `package.json` files carry the product version and are kept in sync: the root `package.json` and
`apps/server/package.json`. The server reports its own version at runtime (startup log, MCP server info) and the
workflow compares the git tag with `apps/server/package.json`. The libraries under `packages/` and `apps/web` stay
at `0.0.0` (private, never published separately).

## Cutting a release, step by step

1. Start from an up-to-date `main` with a green CI, in a clean working tree.
2. Run the full check locally: `pnpm check`.
3. Bump the versions: `node scripts/bump-version.mjs 0.2.0` (add `--dry-run` to preview). It updates the two files
   above and refuses to run on a dirty tree.
4. Update `CHANGELOG.md`: move the entries of `## [Unreleased]` under a new heading `## [0.2.0] - YYYY-MM-DD` and
   write them from the conventional commits since the last tag (`feat:` goes to Added, `fix:` to Fixed,
   `feat!:`/`BREAKING CHANGE` and behavior changes to Changed or Removed; skip `chore:`, `docs:` and `test:` unless
   users care). Add the compare link at the bottom and start a fresh empty Unreleased section.
5. Commit: `chore(release): 0.2.0`, and merge it to `main` (pull request or direct push, as the repository allows).
6. Optional rehearsal: GitHub, Actions, Release, "Run workflow" on `main` with `dry_run` on (the default). It builds
   both architectures and runs the smoke test without pushing anything.
7. Tag exactly that commit and push the tag:
   ```sh
   git tag -a v0.2.0 -m "PPTaken 0.2.0"
   git push origin v0.2.0
   ```
8. Watch the Release run (Actions tab). When it is green, the job summary lists the image reference and digests.
9. Check it from a clean machine: `docker pull ghcr.io/arroztek/pptaken:0.2.0` (and `docker run --rm
   ghcr.io/arroztek/pptaken:0.2.0 node -v`). Optionally publish a GitHub Release for the tag with the changelog
   entry as its notes.

## What the workflow does

`.github/workflows/release.yml`, on a pushed tag `v*.*.*` (or manually):

1. **Check version**: the tag must look like `vX.Y.Z[-pre]` and equal `version` in `apps/server/package.json`;
   otherwise it stops at once with a message that says what to fix.
2. **Build**, once per architecture, each on a native runner (`ubuntu-24.04` for amd64, `ubuntu-24.04-arm` for
   arm64; no QEMU emulation): build the image, run `docker/smoke-test.sh` against it, and only then push it **by
   digest** (no tag yet). Layers are cached in the GitHub Actions cache, one scope per architecture.
3. **Publish manifest**: merges the two digests into one multi-arch manifest list with `docker buildx imagetools
   create` and applies the tags (`X.Y.Z`, `X.Y`, `X`, `latest`; only the exact tag for a pre-release). The image
   carries OCI labels (source, licenses `AGPL-3.0-or-later`, title, description, version, revision, created). It
   then attaches a signed build provenance attestation to the manifest list (first-party
   `actions/attest-build-provenance`, free for public repositories). Verify it with
   `gh attestation verify oci://ghcr.io/arroztek/pptaken:0.2.0 --owner Arroztek`. No SBOM is generated yet.
4. **Summary**: writes the image reference, the manifest list digest and the per-architecture digests to the job
   summary.

Re-running a failed release run is safe (tags are overwritten with the same content). Two runs for the same tag never
overlap (`concurrency`). The pull-request workflow `docker-check.yml` builds the amd64 image and runs the same smoke
test whenever `docker/**`, `apps/**` or `packages/**` change, so the release should not be the first time the
Dockerfile is exercised.

Third-party actions are pinned by commit SHA. To update one, look up the new release on its repository, take the
commit SHA of the release tag and replace both the SHA and the version in the trailing comment.

## One-time setup (only the organization owner can do this)

Do these once, right after the **first** tag has been pushed and the run has published the image:

1. **Make the package public.** GitHub, the `Arroztek` organization, Packages, `pptaken`, Package settings,
   "Change package visibility", Public. A new package on ghcr.io is created **private** by default, and Dokploy,
   Coolify and `docker compose pull` cannot pull a private package without a login. This cannot be done from the
   workflow.
2. **Check the link to the repository.** The image carries the label `org.opencontainers.image.source` pointing to
   `https://github.com/Arroztek/pptaken`, which makes GitHub connect the package to the repository automatically on
   the first publish. Confirm on the package page that the repository is shown ("Connected repository"); if not, use
   "Connect repository" in the package settings. Also check that "Manage Actions access" lists the repository with
   write access (it is added automatically when the package is linked).
3. **Set the spending budget to $0** so nothing can ever be charged: organization Settings, Billing and plans (the
   "Budgets and alerts" / spending limit section), set the Actions and Packages budgets to $0 and keep "stop usage
   when the budget is reached" on. *To be verified in the UI:* GitHub moves these screens around, so look for the
   Actions and Packages (storage and data transfer) limits.
4. Organization Settings, Packages: make sure members are allowed to create **public** packages (otherwise the first
   publish from the workflow can be refused).
5. Optional: Settings, Actions, General, "Workflow permissions": leave "Read repository contents" as default (the
   workflows declare their own permissions).

After that, every release is just "bump, tag, push".

## Cost note

- GitHub Actions on **public** repositories with standard GitHub-hosted runners (including the Linux arm64 runner)
  are free and not metered. The workflows use no larger runners, no self-hosted runners and no paid features.
- Storage and bandwidth of **public** packages on ghcr.io are free. Do not put anything private on ghcr.io: a private
  package counts against the plan's storage and transfer quotas, and everything in this image is open source.
- The GitHub Actions build cache has a fixed size limit per repository; old entries are evicted, and it is not
  billed for a public repository.
- The $0 budget above is a safety net in case a setting is ever changed by mistake.

## Rolling back

- **Never delete or move a published tag** (git tag or image tag): operators pin them, and a moved tag breaks
  reproducibility and attestations.
- **A bad release `0.2.0`:** fix forward. Revert or fix on `main`, bump to `0.2.1`, tag `v0.2.1`. The workflow moves
  `0.2`, `0` and `latest` to the new image, which is the rollback for everybody who follows those tags.
- **An operator who wants the previous version now:** set `PPTAKEN_VERSION=0.1.2` (the previous good version) and run
  `docker compose pull && docker compose up -d`. If the bad release ran a database migration, restore the backup
  copy first (`pptaken.db.pre-v<N>-<time>.bak` in the data volume).
- **Deprecating a release:** edit its GitHub Release notes to say "do not use, fixed in 0.2.1" and mark it
  "pre-release" there. In the CHANGELOG add `### Yanked` or a note under that version. If a version is truly
  dangerous (a security issue), also publish a GitHub Security Advisory (see `SECURITY.md`). Deleting an image
  version from the package page is a last resort, only for something that must not be pulled at all (for example a
  leaked secret), and it is done by the owner by hand, never by the workflow.
- **A release run that failed halfway:** nothing is tagged until the "Publish manifest" job succeeds, so nobody can
  have pulled a half release. Fix the cause and push a new patch tag (do not reuse the tag of a run that already
  published). A run that failed before publishing can be re-run from the Actions page.

## Troubleshooting

- *"Tag and package version differ"*: run `node scripts/bump-version.mjs X.Y.Z`, commit, and tag the new commit. If
  the wrong tag was already pushed, it never published anything (the check runs first), so delete it **only in this
  case** (`git push --delete origin vX.Y.Z`) and tag again.
- *push denied / `permission_denied: write_package`*: the package exists but is not linked to the repository with
  write access; open the package settings, "Manage Actions access", add the repository with the Write role.
- *arm64 job waits for a runner*: arm64 runners are shared and free for public repositories; wait or re-run.
