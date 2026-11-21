<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  /settings: appearance (language, theme: also in the app bar), interactive presentations (ADR-024: allow
  interactive updates automatically, default on, stored on the server and changeable only from this session),
  sharing (ADR-026: allow links that open without an account, default on), and Developer details (per browser,
  default off): technical detail across the panel.
-->
<script lang="ts">
  import { Notice, ThemeToggle, toast } from "@pptaken/ui";
  import { onMount } from "svelte";
  import LangSwitch from "../components/LangSwitch.svelte";
  import PageLayout from "../components/PageLayout.svelte";
  import PageSection from "../components/PageSection.svelte";
  import { api, type Settings } from "../lib/api";
  import { handleAuthError, network, prefs, session, setDeveloperMode, t } from "../lib/state.svelte";

  let settings = $state<Settings | null>(null);
  let saving = $state(false);
  let error = $state("");

  onMount(async () => {
    try {
      settings = await api.settings();
    } catch (e) {
      if (!handleAuthError(e)) error = t("settings.autoError");
    }
  });

  async function setAuto(on: boolean) {
    if (!settings) return;
    const before = settings.autoApproveUpdates;
    settings = { ...settings, autoApproveUpdates: on };
    saving = true;
    error = "";
    try {
      settings = await api.saveSettings({ autoApproveUpdates: on });
      toast.show(on ? t("settings.autoOnToast") : t("settings.autoOffToast"));
    } catch (e) {
      settings = { ...settings, autoApproveUpdates: before };
      if (!handleAuthError(e)) error = t("settings.autoError");
    } finally {
      saving = false;
    }
  }

  // ADR-026: the owner's switch for public links (the operator's PPTAKEN_PUBLIC_LINKS wins when it is off).
  async function setLinks(on: boolean) {
    if (!settings) return;
    const before = settings.publicLinks ?? true;
    settings = { ...settings, publicLinks: on };
    saving = true;
    error = "";
    try {
      settings = await api.saveSettings({ publicLinks: on });
      toast.show(on ? t("settings.linksOnToast") : t("settings.linksOffToast"));
    } catch (e) {
      settings = { ...settings, publicLinks: before };
      if (!handleAuthError(e)) error = t("settings.autoError");
    } finally {
      saving = false;
    }
  }

  const host = $derived.by(() => {
    try {
      return new URL(session.status?.publicUrl ?? location.origin).host;
    } catch {
      return location.host;
    }
  });
</script>

<PageLayout title={t("settings.title")} subtitle={t("settings.subtitle")} width="column">
  <PageSection id="appearance" title={t("settings.appearanceTitle")} card>
    <div class="setting-row">
      <span class="setting-row__label" id="lang-label">{t("settings.languageLabel")}</span>
      <LangSwitch />
    </div>
    <div class="setting-row">
      <span class="setting-row__label">{t("settings.themeLabel")}</span>
      <ThemeToggle bind:value={prefs.theme} />
    </div>
  </PageSection>

  <PageSection id="interactive" title={t("settings.interactiveTitle")} card>
    {#if error}<Notice tone="danger" title={error} ondismiss={() => (error = "")} />{/if}
    <div class="check-field">
      <label class="check">
        <input
          type="checkbox"
          name="auto-approve"
          checked={settings?.autoApproveUpdates ?? true}
          disabled={settings === null || saving}
          aria-describedby="auto-hint"
          onchange={(e) => setAuto((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>{t("settings.autoLabel")}</span>
      </label>
      <p class="check-field__hint" id="auto-hint">{t("settings.autoHint")}</p>
    </div>
    {#if settings && settings.scripts === "off"}
      <p class="ppt-small ppt-muted">{t("settings.scriptsOff")}</p>
    {/if}
  </PageSection>

  <PageSection id="sharing" title={t("settings.sharingTitle")} card>
    <div class="check-field">
      <label class="check">
        <input
          type="checkbox"
          name="public-links"
          checked={settings?.publicLinks ?? true}
          disabled={settings === null || saving || settings.publicLinksInstance === "off"}
          aria-describedby="links-hint"
          onchange={(e) => setLinks((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>{t("settings.linksLabel")}</span>
      </label>
      <p class="check-field__hint" id="links-hint">{t("settings.linksHint")}</p>
    </div>
    {#if settings?.publicLinksInstance === "off"}
      <p class="ppt-small ppt-muted" data-testid="links-instance-off">{t("settings.linksInstanceOff")}</p>
    {/if}
  </PageSection>

  <PageSection id="developer" title={t("settings.devTitle")} card>
    <div class="check-field">
      <label class="check">
        <input
          type="checkbox"
          name="developer-details"
          checked={prefs.dev}
          aria-describedby="dev-hint"
          onchange={(e) => setDeveloperMode((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>{t("settings.devLabel")}</span>
      </label>
      <p class="check-field__hint" id="dev-hint">{t("settings.devHint")}</p>
    </div>
  </PageSection>

  <PageSection id="about" title={t("settings.aboutTitle")} card>
    <dl class="facts" data-testid="about">
      <div class="facts__row"><dt>{t("settings.address")}</dt><dd translate="no">{host}</dd></div>
      <div class="facts__row">
        <dt>{t("settings.status")}</dt>
        <dd>
          <span class="ppt-dot" class:ppt-dot--success={network.online} class:ppt-dot--warning={!network.online} aria-hidden="true"></span>
          {network.online ? t("nav.online") : t("nav.offline")}
        </dd>
      </div>
      {#if session.status?.version}
        <div class="facts__row"><dt>{t("settings.version")}</dt><dd>{session.status.version}</dd></div>
      {/if}
    </dl>
  </PageSection>
</PageLayout>
