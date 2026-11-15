<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { Button, Notice, TextField } from "@pptaken/ui";
  import { onDestroy } from "svelte";
  import { ApiError, api } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { loadSession, session, t } from "../lib/state.svelte";

  let password = $state("");
  let submitted = $state(false);
  let busy = $state(false);
  let error = $state("");
  let fieldError = $state("");
  /** While rate-limited, the button stays disabled until this time (ms). */
  let lockedUntil = $state(0);
  let lockTimer: ReturnType<typeof setTimeout> | undefined;

  const required = $derived(submitted && !password ? t("login.required") : "");

  onDestroy(() => clearTimeout(lockTimer));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    submitted = true;
    error = "";
    fieldError = "";
    session.notice = null;
    if (!password || Date.now() < lockedUntil) return;
    busy = true;
    try {
      await api.login(password);
      password = "";
      await loadSession();
    } catch (e) {
      if (e instanceof ApiError && e.code === "SETUP_REQUIRED") {
        await loadSession();
        return;
      }
      if (e instanceof ApiError && e.code === "UNAUTHENTICATED") fieldError = errorMessage(e, t, "login");
      else error = errorMessage(e, t, "login");
      if (e instanceof ApiError && e.code === "RATE_LIMITED") {
        const wait = (e.retryAfter ?? 30) * 1000;
        lockedUntil = Date.now() + wait;
        clearTimeout(lockTimer);
        lockTimer = setTimeout(() => {
          lockedUntil = 0;
        }, wait);
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="welcome auth">
  <section class="hero ppt-curtain-in">
    <h1 class="ppt-display">{t("login.title")}</h1>
    <p class="ppt-lead">{t("login.lead")}</p>
  </section>

  <form class="form-card ppt-card" novalidate onsubmit={submit}>
    {#if session.notice === "sessionEnded"}
      <Notice tone="warning" title={t("errors.sessionEnded")} />
    {/if}
    {#if error}
      <Notice tone="danger" title={error} />
    {/if}
    <TextField
      label={t("login.password")}
      error={required || fieldError}
      bind:value={password}
      name="password"
      type="password"
      autocomplete="current-password"
      required
    />
    <div class="form-actions">
      <Button variant="primary" type="submit" loading={busy} disabled={lockedUntil > 0}>{t("login.submit")}</Button>
    </div>
  </form>
</div>
