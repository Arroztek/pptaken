<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- /welcome, step 1: install code + owner password. -->
<script lang="ts">
  import { Button, Notice, TextField } from "@pptaken/ui";
  import { ApiError, api } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { loadSession, session, t } from "../lib/state.svelte";

  const MIN = 12;
  let installCode = $state("");
  let password = $state("");
  let confirm = $state("");
  let show = $state(false);
  let submitted = $state(false);
  let busy = $state(false);
  let serverError = $state<ApiError | null>(null);
  let formError = $state("");

  const codeError = $derived(submitted && !installCode.trim() ? t("setup.codeRequired") : "");
  const passwordError = $derived.by(() => {
    if (serverError?.code === "VALIDATION_ERROR") return serverError.hint ?? t("setup.weakPassword");
    return submitted && password.length < MIN ? t("setup.tooShort") : "";
  });
  const confirmError = $derived(submitted && confirm !== password ? t("setup.mismatch") : "");
  const passwordHint = $derived(
    password.length > 0 && password.length < MIN
      ? `${t("setup.passwordHint")} ${t("setup.passwordCount", { n: password.length })}`
      : t("setup.passwordHint"),
  );

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    submitted = true;
    serverError = null;
    formError = "";
    if (codeError || password.length < MIN || confirm !== password) return;
    busy = true;
    try {
      await api.setup(installCode.trim(), password);
      session.justInstalled = true;
      password = "";
      confirm = "";
      await loadSession();
    } catch (error) {
      if (error instanceof ApiError) serverError = error;
      if (error instanceof ApiError && error.code === "ALREADY_SETUP") {
        await loadSession();
        return;
      }
      // Weak password and wrong code are shown on their fields; everything else above the form.
      if (!(error instanceof ApiError && (error.code === "VALIDATION_ERROR" || error.code === "FORBIDDEN"))) {
        formError = errorMessage(error, t, "setup");
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="welcome">
  <section class="hero ppt-curtain-in">
    <p class="ppt-eyebrow">{t("welcome.step", { current: 1, total: 2 })}</p>
    <h1 class="ppt-display">{t("setup.title")}</h1>
    <p class="ppt-lead">{t("setup.lead")}</p>
  </section>

  <form class="form-card ppt-card" novalidate onsubmit={submit}>
    {#if formError}
      <Notice tone="danger" title={formError} />
    {/if}
    <TextField
      label={t("setup.installCode")}
      hint={t("setup.installCodeHint")}
      error={codeError || (serverError?.code === "FORBIDDEN" ? t("errors.wrongCode") : "")}
      bind:value={installCode}
      oninput={() => (serverError = null)}
      name="installCode"
      autocomplete="off"
      autocapitalize="characters"
      spellcheck={false}
      mono
      required
    />
    <TextField
      label={t("setup.password")}
      hint={passwordHint}
      error={passwordError}
      bind:value={password}
      oninput={() => (serverError = null)}
      name="password"
      type={show ? "text" : "password"}
      autocomplete="new-password"
      minlength={MIN}
      required
    />
    <TextField
      label={t("setup.confirm")}
      error={confirmError}
      bind:value={confirm}
      name="confirm"
      type={show ? "text" : "password"}
      autocomplete="new-password"
      required
    />
    <label class="check">
      <input type="checkbox" bind:checked={show} />
      <span>{t("setup.showPasswords")}</span>
    </label>
    <div class="form-actions">
      <Button variant="primary" type="submit" loading={busy} iconEnd="arrow-right">{t("setup.submit")}</Button>
    </div>
  </form>
</div>
