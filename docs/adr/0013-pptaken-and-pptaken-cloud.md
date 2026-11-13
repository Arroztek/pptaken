# ADR-013 · Relationship between `pptaken` (public) and `pptaken-cloud` (private)

**Decision.**
- `pptaken` publishes the `@pptaken/*` packages on npm with semantic versioning (Changesets) and the Docker image.
- `pptaken-cloud` **consumes those packages as dependencies**. It never copies code or maintains a *fork*.
- The cloud has its own composition app (`apps/cloud-server`) that wires the same core with other adapters: `storage-postgres`, `blob-s3`, `auth-oidc`, `realtime-redis`, plus the control plane (accounts, plans, limits, billing).
- **Golden rule:** if the cloud needs an extension point that does not exist, it is added as an interface in the public repo (with its public PR) and the cloud implements it. The cloud never patches the core.
- **Anti-divergence:** the cloud's CI runs every night against the public repo's `main` branch (canary) in addition to the latest published version.
- What is paid is decided by **operating cost or business value** (hosting, domains, SSO, teams, analytics), never by removing features that are already in the core.

Interface detail: `02-architecture.md` §9. Community management: `06-open-source-guide.md` §11.
