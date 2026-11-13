# ADR-015 · Compiled audience modules with a common contract

**Decision.** Quiz and questions are **modules** that implement the same contract (manifest + pure server-side state reducer + three views: presenter, audience, projector). In v1 they are packages of the repo itself, **compiled into the application**: there is no dynamic loading of third-party plugins.

**Why not dynamic plugins yet:** running third-party code on the server is a security and API-stability problem we cannot take on before having two or three real modules that validate the contract. The contract is designed as if they were external, to open it in v2.

Detail: `02-architecture.md` §8.
