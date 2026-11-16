<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- /welcome, step 2: "Connect your agent" with three tabs and the live connection status. -->
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
  import { handleAuthError, secrets, session, t } from "../lib/state.svelte";

  const POLL_MS = 2000;

  let tab = $state("code");
  let status = $state<Status | null>(null);
  let pollError = $state(false);
  let now = $state(Date.now());
  let codeError = $state("");
  let otherError = $state("");
  let creatingOther = $state(false);

  const mcpUrl = $derived(status?.mcpUrl ?? mcpUrlFrom(session.status?.publicUrl ?? location.origin));
  const https = $derived(session.status?.https ?? false);
  const connected = $derived(status?.agentConnected === true);
  const codeScopes = $derived((secrets.code?.token.scopes ?? SCOPES).join(" "));

  const tabs = $derived([
    { id: "code", label: t("welcome.tabCode"), icon: "terminal-window" as const },
    { id: "web", label: t("connect.tabWeb"), icon: "globe" as const },
    { id: "other", label: t("connect.tabOther"), icon: "squares-four" as const },
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

  // ------------------------------------------------------------ actions
  async function setupPrompt(): Promise<string> {
    codeError = "";
    if (!secrets.code) secrets.code = await api.createToken(t("connect.tokenNameCode"));
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
      secrets.other = await api.createToken(t("connect.tokenNameOther"));
    } catch (error) {
      if (!handleAuthError(error)) otherError = errorMessage(error, t);
    } finally {
      creatingOther = false;
    }
  }
</script>

<PageLayout
  title={t("welcome.title")}
  subtitle={t("welcome.lead")}
  eyebrow={session.justInstalled ? t("welcome.step", { current: 2, total: 2 }) : undefined}
  width="column"
>
  <Tabs {tabs} bind:selected={tab} label={t("welcome.tabsLabel")}>
    {#snippet panel(id)}
      {#if id === "code"}
        <ol class="steps">
          <li class="step">
            <h2 class="step__title">{t("welcome.codeCopyTitle")}</h2>
            <p class="step__text">{t("welcome.codeCopyText")}</p>
            <div class="stack">
              <div class="ppt-copyblock">
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <pre
                  class="ppt-copyblock__value"
                  id="setup-prompt"
                  role="region"
                  aria-label={t("connect.promptLabel")}
                  tabindex="0">{buildSetupPrompt({ mcpUrl, secret: null })}</pre>
                <div class="ppt-copyblock__bar">
                  <span class="ppt-small ppt-muted"
                    >{t("welcome.permissions")} <span class="ppt-mono">{codeScopes}</span></span
                  >
                  <CopyButton
                    variant="primary"
                    label={t("connect.copySetupPrompt")}
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
                  <span class="field-block__label" aria-hidden="true">{t("connect.tokenLabel")}</span>
                  <SecretBlock
                    label={t("connect.tokenLabel")}
                    masked={MASKED_SECRET}
                    secret={secrets.code.secret}
                  />
                  <span class="field-block__hint">{t("connect.tokenOnce")}</span>
                </div>
              {/if}
            </div>
          </li>
          <li class="step">
            <h2 class="step__title">{t("welcome.codePasteTitle")}</h2>
            <p class="step__text">{t("welcome.codePasteText")}</p>
          </li>
          <li class="step">
            <h2 class="step__title">{t("welcome.cueTitle")}</h2>
            <p class="step__text">{t("welcome.cueText")}</p>
            <ConnectStatus {status} {pollError} {now} />
          </li>
        </ol>
      {:else if id === "web"}
        <div class="stack">
          {#if https}
            <Notice title={t("welcome.httpsOk")} text={t("welcome.httpsOkText")} />
          {:else}
            <Notice tone="warning" title={t("welcome.httpsMissing")} text={t("welcome.httpsMissingText")}>
              <!-- Guide not written yet: placeholder target, no external link. -->
              <a class="ppt-link ppt-small" href="#publish-guide">{t("connect.guide")}</a>
            </Notice>
          {/if}
          <ol class="steps steps--spaced">
            <li class="step">
              <h2 class="step__title">{t("welcome.webCopyTitle")}</h2>
              <CopyField label={t("connect.connectorUrl")} value={mcpUrl} primary />
            </li>
            <li class="step">
              <h2 class="step__title">{t("welcome.webAddTitle")}</h2>
              <p class="step__text">{t("welcome.webAddText")}</p>
            </li>
            <li class="step">
              <h2 class="step__title">{t("welcome.webPasteTitle")}</h2>
              <p class="step__text">{t("welcome.webPasteText")}</p>
            </li>
            <li class="step">
              <h2 class="step__title">{t("welcome.webAuthTitle")}</h2>
              <p class="step__text">{t("welcome.webAuthText")}</p>
              <ConnectStatus {status} {pollError} {now} />
            </li>
          </ol>
        </div>
      {:else}
        <ol class="steps">
          <li class="step">
            <h2 class="step__title">{t("connect.otherUrlTitle")}</h2>
            <p class="step__text">{t("connect.otherUrlText")}</p>
            <CopyField label={t("connect.connectorUrl")} value={mcpUrl} />
          </li>
          <li class="step">
            <h2 class="step__title">{t("connect.otherTokenTitle")}</h2>
            <p class="step__text">{t("connect.otherTokenText")}</p>
            <div class="stack">
              {#if secrets.other}
                <SecretBlock
                  label={t("connect.tokenLabel")}
                  masked={MASKED_SECRET}
                  secret={secrets.other.secret}
                />
              {:else}
                <div>
                  <Button variant="primary" loading={creatingOther} onclick={createOther}>
                    {t("connect.createToken")}
                  </Button>
                </div>
              {/if}
              {#if otherError}
                <Notice tone="danger" title={otherError} />
              {/if}
            </div>
          </li>
          <li class="step">
            <h2 class="step__title">{t("connect.otherConfigTitle")}</h2>
            <p class="step__text">{t("connect.otherConfigText")}</p>
            {#if secrets.other}
              <SecretBlock
                label={t("connect.configLabel")}
                masked={buildClientConfig({ mcpUrl, secret: null })}
                secret={buildClientConfig({ mcpUrl, secret: secrets.other.secret })}
                multiline
              />
            {:else}
              <CopyField label={t("connect.configLabel")} value={buildClientConfig({ mcpUrl, secret: null })} multiline />
            {/if}
          </li>
          <li class="step">
            <h2 class="step__title">{t("welcome.cueTitle")}</h2>
            <p class="step__text">{t("welcome.cueText")}</p>
            <ConnectStatus {status} {pollError} {now} />
          </li>
        </ol>
      {/if}
    {/snippet}
  </Tabs>

  <div class="connect-note">
    <Icon name="info" size={18} />
    <p>{t("connect.managedThere")}</p>
  </div>

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
        <h2 class="ppt-h2" id="next-title">{t("welcome.nextTitle")}</h2>
        <p class="ppt-muted ppt-small">{t("welcome.nextText")}</p>
        <div class="row">
          <CopyButton label={t("welcome.copyExample")} text={t("connect.examplePrompt")} />
          <Button variant="ghost" href="/decks" iconEnd="arrow-right">{t("welcome.goToDecks")}</Button>
        </div>
      </div>
    </section>
  {/if}

  <footer class="welcome-foot">
    <a href="/decks">{t("welcome.later")}</a>
  </footer>
</PageLayout>
