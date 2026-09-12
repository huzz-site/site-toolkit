<script setup lang="ts">
import { onMounted, ref } from "vue";

const backendStatus = ref("checking");
const backendEnabled = __BACKEND_ENABLED__;

onMounted(async () => {
  if (!backendEnabled) {
    backendStatus.value = "not-enabled";
    return;
  }
  try {
    const response = await fetch("/api/health");
    backendStatus.value = response.ok ? "ready" : "unavailable";
  } catch {
    backendStatus.value = "unavailable";
  }
});
</script>

<template>
  <main>
    <p class="eyebrow">HUZZ SITE</p>
    <h1>__DISPLAY_NAME__</h1>
    <p class="lead">这个站点已经连接 Vue、Vite 与 Cloudflare Workers。</p>
    <div class="status" :data-state="backendStatus">
      <span aria-hidden="true" />
      Worker backend: {{ backendStatus }}
    </div>
  </main>
</template>
