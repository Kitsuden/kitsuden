<!--
  The frame while the session is being checked: the shell's shape with Skeleton blocks, in
  place of a full-screen spinner, so the page does not jump when the answer arrives.
-->
<script lang="ts">
  import { t } from "$lib/i18n";
  import { Skeleton } from "$lib/tallao";
</script>

<div class="kitsuden-boot" role="status" aria-busy="true" data-testid="shell-skeleton">
  <span class="sr-only">{t("common.loading")}</span>
  <div class="kitsuden-boot-side" aria-hidden="true">
    <Skeleton width="7rem" height="1.5rem" />
    <div class="kitsuden-boot-nav">
      {#each [70, 55, 80, 60, 75, 50, 65, 72] as width}
        <Skeleton width="{width}%" height="1rem" />
      {/each}
    </div>
  </div>
  <div class="kitsuden-boot-body" aria-hidden="true">
    <div class="kitsuden-boot-top">
      <Skeleton width="12rem" height="1rem" />
      <Skeleton width="6rem" height="1.75rem" />
    </div>
    <div class="kitsuden-boot-main">
      <Skeleton width="14rem" height="1.75rem" />
      <Skeleton width="22rem" height="1rem" />
      <div class="kitsuden-boot-rows">
        {#each Array(6) as _}
          <Skeleton width="100%" height="2.5rem" />
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .kitsuden-boot {
    display: flex;
    height: 100dvh;
    background: rgb(var(--ta-bg));
  }
  .kitsuden-boot-side {
    display: none;
    flex: 0 0 15rem;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem;
    background: rgb(var(--ta-surface));
    border-right: 1px solid rgb(var(--ta-border));
  }
  .kitsuden-boot-nav,
  .kitsuden-boot-rows {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .kitsuden-boot-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .kitsuden-boot-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid rgb(var(--ta-border));
  }
  .kitsuden-boot-main {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.5rem;
  }
  .kitsuden-boot-rows {
    margin-top: 1rem;
  }
  @media (min-width: 1024px) {
    .kitsuden-boot-side {
      display: flex;
    }
  }
</style>
