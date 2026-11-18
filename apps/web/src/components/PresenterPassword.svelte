<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  The presenter password (ADR-021): one instance-wide secret that unlocks approved interactive code on screens
  without the owner's session. Separate from the owner password (the server refuses equal values both ways), at
  least 12 characters, stored as a hash. It never opens the panel.
-->
<script lang="ts">
  import { Button, Dialog, Icon, Notice, TextField } from "@pptaken/ui";
  import { onMount } from "svelte";
  import { ApiError, api } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { handleAuthError, t } from "../lib/state.svelte";
  import PageSection from "./PageSection.svelte";

  let isSet = $state<boolean | null>(null);
  let next = $state("");
  let again = $state("");
  let submitted = $state(false);
  let busy = $state(false);
  let error = $state("");
  let fieldError = $state("");
  let done = $state("");
  let removeOpen = $state(false);
  let removing = $state(false);

  onMount(async () => {
    try {
      isSet = (await api.presenterPassword()).set;
    } catch (e) {
      if (!handleAuthError(e)) error = errorMessage(e, t);
    }
  });

  const requiredError = $derived(submitted && (!next || !again) ? t("presenter.required") : "");
  const mismatch = $derived(submitted && next && again && next !== again ? t("presenter.mismatch") : "");

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    submitted = true;
    error = "";
    fieldError = "";
    done = "";
    if (!next || !again || next !== again) return;
    busy = true;
    try {
      const r = await api.setPresenterPassword(next);
      next = "";
      again = "";
      submitted = false;
      isSet = true;
      done = r.change === "set" ? t("presenter.doneSet") : t("presenter.doneChanged");
    } catch (e) {
      if (e instanceof ApiError && e.code === "VALIDATION_ERROR") {
        fieldError = /owner password/i.test(e.message) ? t("presenter.sameAsOwner") : t("presenter.weak");
      } else if (!handleAuthError(e)) {
        error = errorMessage(e, t);
      }
    } finally {
      busy = false;
    }
  }

  async function remove() {
    removing = true;
    error = "";
    done = "";
    try {
      await api.removePresenterPassword();
      isSet = false;
      removeOpen = false;
      done = t("presenter.doneRemoved");
    } catch (e) {
      removeOpen = false;
      if (!handleAuthError(e)) error = errorMessage(e, t);
    } finally {
      removing = false;
    }
  }
</script>

<PageSection id="presenter" title={t("presenter.title")} description={t("presenter.lead")} card>
  <div class="presenter-notes">
    <p><strong>{t("presenter.notOwner")}</strong></p>
    <p>{t("presenter.offline")}</p>
  </div>
  {#if isSet !== null}
    <p class="presenter-status" data-testid="presenter-status" data-set={isSet}>
      <span class="ppt-badge" class:badge-ok={isSet} class:badge-off={!isSet}>
        <Icon name={isSet ? "check" : "key"} size={14} />
        {isSet ? t("presenter.statusSet") : t("presenter.statusUnset")}
      </span>
    </p>
  {/if}
  <form class="form-stack" novalidate onsubmit={submit} aria-label={t("presenter.title")}>
    {#if done}
      <Notice tone="success" title={done} ondismiss={() => (done = "")} />
    {/if}
    {#if error}
      <Notice tone="danger" title={error} />
    {/if}
    <TextField
      label={t("presenter.next")}
      hint={t("presenter.nextHint")}
      error={fieldError || (submitted && !next ? requiredError : "")}
      bind:value={next}
      name="presenter-password"
      type="password"
      autocomplete="new-password"
      required
    />
    <TextField
      label={t("presenter.confirm")}
      error={mismatch || (submitted && !again ? requiredError : "")}
      bind:value={again}
      name="presenter-password-again"
      type="password"
      autocomplete="new-password"
      required
    />
    <div class="form-actions form-actions--start">
      <Button variant="primary" type="submit" loading={busy}>
        {isSet ? t("presenter.submitChange") : t("presenter.submitSet")}
      </Button>
      {#if isSet}
        <Button variant="ghost" onclick={() => (removeOpen = true)}>{t("presenter.remove")}</Button>
      {/if}
    </div>
  </form>
</PageSection>

<Dialog bind:open={removeOpen} title={t("presenter.removeTitle")} dismissible={false}>
  <p>{t("presenter.removeText")}</p>
  {#snippet actions()}
    <Button variant="secondary" onclick={() => (removeOpen = false)}>{t("scripts.cancel")}</Button>
    <Button variant="danger" loading={removing} onclick={remove}>{t("presenter.remove")}</Button>
  {/snippet}
</Dialog>
