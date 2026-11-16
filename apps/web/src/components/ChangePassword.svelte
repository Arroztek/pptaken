<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Change the owner password. Other sessions are signed out; optionally every OAuth application too (ADR-0018). -->
<script lang="ts">
  import { Button, Notice, TextField, toast } from "@pptaken/ui";
  import { ApiError, api } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { handleAuthError, t } from "../lib/state.svelte";

  let { onchanged }: { onchanged?: () => void } = $props();

  let current = $state("");
  let next = $state("");
  let disconnectApps = $state(false);
  let submitted = $state(false);
  let busy = $state(false);
  let error = $state("");
  let currentError = $state("");

  const required = $derived(submitted && (!current || !next) ? t("password.required") : "");

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    submitted = true;
    error = "";
    currentError = "";
    if (!current || !next) return;
    busy = true;
    try {
      const r = await api.changePassword({ currentPassword: current, newPassword: next, disconnectApps });
      current = "";
      next = "";
      submitted = false;
      toast.show(
        r.disconnectedApps > 0 ? t("password.doneApps", { n: r.disconnectedApps }) : t("password.done"),
      );
      if (disconnectApps) onchanged?.();
      disconnectApps = false;
    } catch (e) {
      // A wrong current password is a 401 here, not an ended session.
      if (e instanceof ApiError && e.code === "UNAUTHENTICATED" && e.message === "Wrong password") {
        currentError = t("errors.wrongPassword");
      } else if (e instanceof ApiError && e.code === "VALIDATION_ERROR") {
        error = t("setup.weakPassword");
      } else if (!handleAuthError(e)) {
        error = errorMessage(e, t);
      }
    } finally {
      busy = false;
    }
  }
</script>

<section class="ppt-card token-create" aria-labelledby="password-title">
  <h2 class="ppt-h2" id="password-title">{t("password.title")}</h2>
  <form class="token-form" novalidate onsubmit={submit}>
    <TextField
      label={t("password.current")}
      error={currentError || (submitted && !current ? required : "")}
      bind:value={current}
      name="current-password"
      type="password"
      autocomplete="current-password"
      required
    />
    <TextField
      label={t("password.next")}
      hint={t("password.nextHint")}
      error={submitted && !next ? required : ""}
      bind:value={next}
      name="new-password"
      type="password"
      autocomplete="new-password"
      required
    />
    <label class="check">
      <input type="checkbox" bind:checked={disconnectApps} aria-describedby="disconnect-apps-hint" />
      <span>{t("password.disconnectApps")}</span>
    </label>
    <p class="ppt-field__hint" id="disconnect-apps-hint">{t("password.disconnectAppsHint")}</p>
    <div class="token-form__actions">
      <Button variant="secondary" type="submit" loading={busy}>{t("password.submit")}</Button>
    </div>
  </form>
  {#if error}<Notice tone="danger" title={error} />{/if}
</section>
