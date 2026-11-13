# ADR-016 · Observability and privacy

**Decision.** JSON logs to standard output (pino) with a request identifier; `/healthz` and `/readyz`; optional Prometheus metrics at `/metrics` protected by a token; an **audit log** in the database (which actor, with which token, did what). **No telemetry to the project by default.** If one is ever added, it will be optional, anonymous and documented.

**Why:** in self-hosted software, trust is part of the product. Auditing is especially valuable when the one acting is an agent.
