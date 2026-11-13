# ADR-012 · License: AGPL-3.0 for the application, Apache-2.0 for the format and client libraries; license-grant CLA

**Context.** *Open core* model: open core + paid cloud service. A jargon-free explanation of the options:

| License | In one sentence | For the founder | For whoever contributes/uses |
|---|---|---|---|
| **MIT / Apache-2.0** (permissive) | "Do whatever you want, just keep the notice" | Maximum adoption; anyone can run a closed PPTaken-cloud with your code | No restrictions. Apache adds patent protection |
| **AGPL-3.0** (network *copyleft*) | "If you modify it and offer it as a service, publish your changes" | A competitor cannot close their improvements; you remain genuinely open source (OSI-approved) | Using or self-hosting it unmodified obliges nothing. Some large companies ban AGPL by policy |
| **BUSL / FSL / SSPL** (*source-available*) | "You can see the code but not compete with me" | Maximum commercial protection | **Not open source**: the community perceives it that way and contributes less |

**Decision.**
1. **AGPL-3.0-or-later** for `apps/*` and the server packages. It protects the business model while remaining genuine open source, and it is the de facto standard in comparable self-hosted open-core projects.
2. **Apache-2.0** for what we want the ecosystem to adopt without hesitation: `@pptaken/schema` (the deck format), `@pptaken/player` (the player engine) and the future `pptaken-mcp` bridge. Letting anyone generate or play `pptaken.deck` decks makes the project bigger.
3. **Contributions: license-grant CLA** (not a copyright assignment), signed with one click through a bot. The contributor keeps authorship and grants the project the right to license their contribution under other terms as well. It is accompanied by a public commitment in `GOVERNANCE.md`: **the community edition will remain under an OSI-approved license**.

**Why a CLA and not just a DCO.** The **DCO** (*Developer Certificate of Origin*) is a `Signed-off-by` line on each commit saying "I have the right to contribute this"; it is lightweight but contributions enter only under AGPL. With that, any cloud code that runs **in the same process** as the core would also have to be published under AGPL, and selling commercial licenses to companies that do not accept AGPL would require each contributor's permission. The CLA preserves those options. Its cost is friction and some wariness in part of the community; it is mitigated with the public commitment and with transparency.

**Valid alternative if the founder prioritizes trust over optionality:** AGPL + DCO, publishing as open source all the adapters that run in-process (Postgres, S3, OIDC) and leaving private only the cloud's control plane (sign-up, billing, operations) as a separate service. It is a sound architecture in any case and I recommend it also with a CLA.

**Notices.** I am not a lawyer: before accepting the first external contribution, a brief legal review of the CLA is advisable. The content users create (their presentations) is not affected by the software's license.
