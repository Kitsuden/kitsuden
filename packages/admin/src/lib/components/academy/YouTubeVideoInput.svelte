<script lang="ts">
  import { t } from "$lib/i18n";
  import { Video, Check, ExternalLink } from "lucide-svelte";

  import { Alert, Card, Input, Label, Spinner } from "$lib/tallao";

  import { api } from "$lib/api";

  interface YouTubeInfo {
    videoId: string;
    embedUrl: string;
    thumbnailUrl: string;
    title?: string;
    valid: boolean;
  }

  interface Props {
    value: string;
    onChange: (value: string, info: YouTubeInfo | null) => void;
    label?: string;
    required?: boolean;
  }

  const {
    value = "",
    onChange,
    label = t("youTubeVideoInput.youtubeVideo"),
    required = false,
  }: Props = $props();

  const inputId = $props.id();

  let loading = $state(false);
  let error = $state<string | null>(null);
  let videoInfo = $state<YouTubeInfo | null>(null);
  let inputValue = $state(value);

  // Validate YouTube URL
  function isValidYouTubeUrl(url: string): boolean {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
    ];
    return patterns.some((p) => p.test(url));
  }

  async function handleValidate() {
    error = null;
    videoInfo = null;

    if (!inputValue.trim()) {
      onChange("", null);
      return;
    }

    if (!isValidYouTubeUrl(inputValue)) {
      error = t("youTubeVideoInput.invalidYoutubeUrl");
      return;
    }

    loading = true;

    try {
      const info = await api.getYouTubeInfo(inputValue);

      if (!info.valid) {
        error = t("youTubeVideoInput.couldNotExtractInformation");
        return;
      }

      videoInfo = info;
      // We store the embed URL, which is the one used to display the video
      onChange(info.embedUrl, info);
    } catch (err: any) {
      error = err.message || t("youTubeVideoInput.errorValidatingVideo");
    } finally {
      loading = false;
    }
  }

  function handleInput() {
    // Debounce to avoid making requests on every keystroke
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (inputValue && isValidYouTubeUrl(inputValue)) {
        handleValidate();
      }
    }, 800);
  }

  let debounceTimer: ReturnType<typeof setTimeout>;

  // If an initial value comes in, validate it
  $effect(() => {
    if (value && !videoInfo) {
      inputValue = value;
      handleValidate();
    }
  });
</script>

<div class="space-y-3 min-w-0">
  <Label for={inputId} {required}>{label}</Label>

  <div class="flex items-center gap-2">
    <Video class="w-5 h-5 shrink-0 text-kitsuden-subtle" aria-hidden="true" />
    <Input
      id={inputId}
      type="url"
      class="flex-1 min-w-0"
      bind:value={inputValue}
      oninput={handleInput}
      onblur={handleValidate}
      placeholder="https://www.youtube.com/watch?v=..."
    />
    {#if loading}
      <Spinner size="sm" />
    {:else if videoInfo}
      <Check class="w-4 h-4 shrink-0 text-kitsuden-green" aria-hidden="true" />
    {/if}
  </div>

  {#if error}
    <Alert variant="error">{error}</Alert>
  {/if}

  <!-- Video preview -->
  {#if videoInfo}
    <Card class="p-3">
      <div class="flex gap-3">
        <div class="w-32 h-20 bg-kitsuden-surface rounded-lg overflow-hidden shrink-0">
          <img
            src={videoInfo.thumbnailUrl}
            alt={t("youTubeVideoInput.thumbnail")}
            class="w-full h-full object-cover"
          />
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-kitsuden-text truncate">
            {videoInfo.title || t("youTubeVideoInput.youtubeVideo")}
          </p>
          <p class="text-xs text-kitsuden-subtle mt-1">
            {t("youTubeVideoInput.id", { videoId: videoInfo.videoId })}
          </p>
          <a
            href={inputValue}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 text-xs text-kitsuden-accent hover:underline mt-2"
          >
            <ExternalLink class="w-3 h-3" />
            {t("youTubeVideoInput.viewOnYoutube")}
          </a>
        </div>
      </div>
    </Card>
  {/if}
</div>
