<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  /welcome (signed in): "Connect Claude". The shortest path first: three steps for Claude Desktop and Claude on the
  web (copy the address, add it as a connector, allow access), with the live connection status. Claude Code and
  other MCP clients (setup prompt, access keys, client configuration) are tucked under "Developer".
-->
<script lang="ts">
  import { Button, CopyField, Icon, Notice, Tabs } from "@pptaken/ui";
  import { onDestroy, onMount } from "svelte";
  import ConnectStatus from "../components/ConnectStatus.svelte";
  import CopyButton from "../components/CopyButton.svelte";
  import PageLayout from "../components/PageLayout.svelte";
  import SecretBlock from "../components/SecretBlock.svelte";
  import { api, type ConnectStatus as Status, SCOPES } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { buildClientConfig, buildSetupPrompt, MASKED_SECRET, mcpUrlFrom } from "../lib/prompts";
  import { handleAuthError, prefs, secrets, session, t } from "../lib/state.svelte";

  const POLL_MS = 2000;

  let tab = $state("code");
  let status = $state<Status | null>(null);
  let pollError = $state(false);
  let now = $state(Date.now());
  let codeError = $state("");
  let otherError = $state("");
  let creatingOther = $state(false);
  // The Developer fold stays open while a one-time key is on screen, or with Developer details on.
  let devOpen = $state(prefs.dev || secrets.code !== null || secrets.other !== null);

  const mcpUrl = $derived(status?.mcpUrl ?? mcpUrlFrom(session.status?.publicUrl ?? location.origin));
  const https = $derived(session.status?.https ?? false);
  const connected = $derived(status?.agentConnected === true);
  const codeScopes = $derived((secrets.code?.token.scopes ?? SCOPES).join(" "));

  const tabs = $derived([
    { id: "code", label: t("devConnect.tabCode"), icon: "terminal-window" as const },
    { id: "other", label: t("devConnect.tabOther"), icon: "squares-four" as const },
  ]);

  // ------------------------------------------------------------ polling
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let inFlight = false;

  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || connected || document.visibilityState !== "visible") return;
    timer = setTimeout(poll, POLL_MS);
  }

  async function poll() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      status = await api.connectStatus();
      pollError = false;
      now = Date.now();
    } catch (error) {
      if (handleAuthError(error)) {
        stopped = true;
        return;
      }
      pollError = true;
    } finally {
      inFlight = false;
    }
    schedule();
  }

  function onVisibility() {
    if (document.visibilityState === "visible") {
      if (!timer && !connected) void poll();
    } else {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  onMount(() => {
    void poll();
    document.addEventListener("visibilitychange", onVisibility);
    ticker = setInterval(() => {
      if (connected) now = Date.now();
    }, 10_000);
  });

  onDestroy(() => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(ticker);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  // ------------------------------------------------------------ developer actions
  async function setupPrompt(): Promise<string> {
    codeError = "";
    if (!secrets.code) secrets.code = await api.createToken(t("devConnect.tokenNameCode"));
    return buildSetupPrompt({ mcpUrl, secret: secrets.code.secret });
  }

  function onCodeError(error: unknown) {
    if (handleAuthError(error)) return;
    codeError = error instanceof Error && error.name === "CopyError" ? t("errors.copyFailed") : errorMessage(error, t);
  }

  async function createOther() {
    otherError = "";
    creatingOther = true;
    try {
      secrets.other = await api.createToken(t("devConnect.tokenNameOther"));
    } catch (error) {
      if (!handleAuthError(error)) otherError = errorMessage(error, t);
    } finally {
      creatingOther = false;
    }
  }
</script>

<PageLayout
  title={t("connect.title")}
  subtitle={t("connect.lead")}
  eyebrow={session.justInstalled ? t("welcome.step", { current: 2, total: 2 }) : undefined}
  width="column"
>
  {#if !https}
    <Notice title={t("connect.publicMissingTitle")} text={t("connect.publicMissingText")} />
  {/if}

  <ol class="steps steps--spaced" data-testid="connect-steps">
    <li class="step">
      <h2 class="step__title">{t("connect.step1Title")}</h2>
      <p class="step__text">{t("connect.step1Text")}</p>
      <CopyField label={t("connect.addressLabel")} value={mcpUrl} primary />
    </li>
    <li class="step">
      <h2 class="step__title">{t("connect.step2Title")}</h2>
      <p class="step__text">{t("connect.step2Desktop")}</p>
      <p class="step__text">{t("connect.step2Web")}</p>
      <p class="step__text">{t("connect.step2Name")}</p>
    </li>
    <li class="step">
      <h2 class="step__title">{t("connect.step3Title")}</h2>
      <p class="step__text">{t("connect.step3Text")}</p>
      <ConnectStatus {status} {pollError} {now} />
    </li>
  </ol>

  {#if connected}
    <section class="ppt-card next-card ppt-curtain-in" aria-labelledby="next-title">
      <svg viewBox="0 0 240 160" fill="none" aria-hidden="true"
        ><path
          d="M20 148V52C20 28 64 12 120 12C176 12 220 28 220 52V148"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
        /><path
          d="M28 40C40 52 52 52 64 42C76 52 88 52 100 42C112 52 128 52 140 42C152 52 164 52 176 42C188 52 200 52 212 40"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        /><path
          d="M30 56C38 90 36 120 30 148M44 56C50 92 48 122 42 148M210 56C202 90 204 120 210 148M196 56C190 92 192 122 198 148"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        /><ellipse cx="120" cy="96" rx="56" ry="34" fill="#FFB224" fill-opacity=".16" /><rect
          x="84"
          y="76"
          width="72"
          height="40.5"
          rx="3"
          fill="#FFB224"
        /><path
          d="M116 87.5L124.5 96.25L116 105"
          stroke="#16181D"
          stroke-width="4"
          stroke-linecap="round"
          stroke-linejoin="round"
        /><path d="M20 148H220" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg
      >
      <div class="stack stack--tight">
        <h2 class="ppt-h2" id="next-title">{t("connect.nextTitle")}</h2>
        <p class="ppt-muted ppt-small">{t("connect.nextText")}</p>
        <div class="row">
          <CopyButton label={t("connect.copyExample")} text={t("connect.examplePrompt")} />
          <Button variant="ghost" href="/decks" iconEnd="arrow-right">{t("welcome.goToDecks")}</Button>
        </div>
      </div>
    </section>
  {/if}

  <p class="connect-quiet">{t("connect.managedThere")}</p>

  <details class="fold" bind:open={devOpen} data-testid="developer-fold">
    <summary class="fold__summary">
      <span class="fold__title"><Icon name="terminal-window" size={18} />{t("connect.developerTitle")}</span>
      <span class="fold__text">{t("connect.developerText")}</span>
    </summary>
    <div class="fold__body">
      <Tabs {tabs} bind:selected={tab} label={t("devConnect.tabsLabel")}>
        {#snippet panel(id)}
          {#if id === "code"}
            <ol class="steps">
              <li class="step">
                <h3 class="step__title">{t("devConnect.codeCopyTitle")}</h3>
                <p class="step__text">{t("devConnect.codeCopyText")}</p>
                <div class="stack">
                  <div class="ppt-copyblock">
                    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                    <pre
                      class="ppt-copyblock__value"
                      id="setup-prompt"
                      role="region"
                      aria-label={t("devConnect.promptLabel")}
                      tabindex="0">{buildSetupPrompt({ mcpUrl, secret: null })}</pre>
                    <div class="ppt-copyblock__bar">
                      <span class="ppt-small ppt-muted"
                        >{t("devConnect.permissions")} <span class="ppt-mono">{codeScopes}</span></span
                      >
                      <CopyButton
                        variant="primary"
                        label={t("devConnect.copySetupPrompt")}
                        text={setupPrompt}
                        describedby="setup-prompt"
                        onerror={onCodeError}
                      />
                    </div>
                  </div>
                  {#if codeError}
                    <Notice tone="danger" title={codeError} />
                  {/if}
                  {#if secrets.code}
                    <div class="field-block">
                      <span class="field-block__label" aria-hidden="true">{t("devConnect.tokenLabel")}</span>
                      <SecretBlock label={t("devConnect.tokenLabel")} masked={MASKED_SECRET} secret={secrets.code.secret} />
                      <span class="field-block__hint">{t("devConnect.tokenOnce")}</span>
                    </div>
                  {/if}
                </div>
              </li>
              <li class="step">
                <h3 class="step__title">{t("devConnect.codePasteTitle")}</h3>
                <p class="step__text">{t("devConnect.codePasteText")}</p>
              </li>
            </ol>
          {:else}
            <ol class="steps">
              <li class="step">
                <h3 class="step__title">{t("devConnect.otherUrlTitle")}</h3>
                <p class="step__text">{t("devConnect.otherUrlText")}</p>
                <CopyField label={t("devConnect.connectorUrl")} value={mcpUrl} />
              </li>
              <li class="step">
                <h3 class="step__title">{t("devConnect.otherTokenTitle")}</h3>
                <p class="step__text">{t("devConnect.otherTokenText")}</p>
                <div class="stack">
                  {#if secrets.other}
                    <SecretBlock label={t("devConnect.tokenLabel")} masked={MASKED_SECRET} secret={secrets.other.secret} />
                  {:else}
                    <div>
                      <Button variant="secondary" loading={creatingOther} onclick={createOther}>
                        {t("devConnect.createToken")}
                      </Button>
                    </div>
                  {/if}
                  {#if otherError}
                    <Notice tone="danger" title={otherError} />
                  {/if}
                </div>
              </li>
              <li class="step">
                <h3 class="step__title">{t("devConnect.otherConfigTitle")}</h3>
                <p class="step__text">{t("devConnect.otherConfigText")}</p>
                {#if secrets.other}
                  <SecretBlock
                    label={t("devConnect.configLabel")}
                    masked={buildClientConfig({ mcpUrl, secret: null })}
                    secret={buildClientConfig({ mcpUrl, secret: secrets.other.secret })}
                    multiline
                  />
                {:else}
                  <CopyField label={t("devConnect.configLabel")} value={buildClientConfig({ mcpUrl, secret: null })} multiline />
                {/if}
              </li>
            </ol>
          {/if}
        {/snippet}
      </Tabs>
    </div>
  </details>

  <footer class="welcome-foot">
    <a href="/decks">{t("welcome.later")}</a>
  </footer>
</PageLayout>
