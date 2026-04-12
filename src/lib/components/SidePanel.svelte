<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { KotaHeatmapProperties, KotaSearchItem, LayerMode, StatsData, YearCount } from '$lib/types';
  import SearchBar from './SearchBar.svelte';
  import StatsPanel from './StatsPanel.svelte';
  import YearDropdown from './YearDropdown.svelte';
  import ViewToggle from './ViewToggle.svelte';

  let {
    selectedYear = $bindable<number | null>(null),
    layerMode    = $bindable<LayerMode>('centroids'),
    years        = [],
    kotaList     = [],
    topKota        = [] as KotaHeatmapProperties[],
    allHeatmapKota = [] as KotaHeatmapProperties[],
    stats          = null,
    showingOnMap = 0,
    statsLoading = false,
    selectedKota = $bindable<KotaSearchItem | null>(null),
    onSelectKota,
  }: {
    selectedYear: number | null;
    layerMode: LayerMode;
    years: YearCount[];
    kotaList: KotaSearchItem[];
    topKota: KotaHeatmapProperties[];
    allHeatmapKota: KotaHeatmapProperties[];
    stats: StatsData | null;
    showingOnMap: number;
    statsLoading: boolean;
    selectedKota: KotaSearchItem | null;
    onSelectKota: (kota: KotaSearchItem | null) => void;
  } = $props();

  // ─── C9/H10: Animasi Tahun ───────────────────────────────────────────────────
  const yearsAsc = $derived([...years].sort((a, b) => a.year - b.year));
  let playing = $state(false);
  let playInterval: ReturnType<typeof setInterval> | null = null;

  function currentIndex(): number {
    return selectedYear != null ? yearsAsc.findIndex(y => y.year === selectedYear) : -1;
  }

  function pauseAnimation() {
    playing = false;
    if (playInterval) { clearInterval(playInterval); playInterval = null; }
  }

  function startAnimation() {
    if (yearsAsc.length === 0) return;
    playing = true;
    // Mulai dari awal jika belum ada tahun terpilih atau sudah di tahun terakhir
    const idx = currentIndex();
    if (idx < 0 || idx >= yearsAsc.length - 1) selectedYear = yearsAsc[0].year;

    playInterval = setInterval(() => {
      const i = currentIndex();
      if (i < 0 || i >= yearsAsc.length - 1) {
        pauseAnimation(); // berhenti di tahun terakhir
      } else {
        selectedYear = yearsAsc[i + 1].year;
      }
    }, 1200);
  }

  function togglePlay() {
    playing ? pauseAnimation() : startAnimation();
  }

  function resetAnimation() {
    pauseAnimation();
    selectedYear = null; // kembali ke "semua tahun"
  }

  // ─── C8: Chart distribusi ────────────────────────────────────────────────────
  const maxYearCount = $derived(yearsAsc.reduce((m, y) => Math.max(m, y.count), 1));

  // ─── C10: Share Link ──────────────────────────────────────────────────────────
  let copySuccess = $state(false);
  let copyTimeout: ReturnType<typeof setTimeout> | null = null;

  function shareLink() {
    const params = new URLSearchParams();
    if (selectedYear != null) params.set('year', String(selectedYear));
    if (layerMode !== 'centroids') params.set('mode', layerMode);
    const qs = params.toString();
    const url = `${window.location.origin}${window.location.pathname}${qs ? '?' + qs : ''}`;
    navigator.clipboard.writeText(url).then(() => {
      copySuccess = true;
      if (copyTimeout) clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => { copySuccess = false; }, 2000);
    }).catch(() => {});
  }

  // ─── H8: Export CSV ───────────────────────────────────────────────────────────
  let exportLoading = $state(false);

  function escapeCSV(val: string | number): string {
    if (typeof val === 'number') return String(val);
    if (/[",\n]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
    return val;
  }

  function exportCSV() {
    if (allHeatmapKota.length === 0 || exportLoading) return;
    exportLoading = true;
    try {
      const headers = ['hasc_code', 'kota_name', 'provinsi', 'record_count', 'total_area_km2', 'intensity'];
      const rows = allHeatmapKota.map(k => [
        escapeCSV(k.hasc_code),
        escapeCSV(k.kota_name),
        escapeCSV(k.provinsi),
        k.record_count,
        k.total_area_km2.toFixed(2),
        k.intensity.toFixed(4),
      ]);
      const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `deforestasi-kota-${selectedYear ?? 'semua'}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      exportLoading = false;
    }
  }

  onDestroy(() => {
    if (playInterval) clearInterval(playInterval);
    if (copyTimeout) clearTimeout(copyTimeout);
  });
</script>

<div class="h-full flex flex-col bg-gray-900 border-l border-gray-800">
  <!-- Header -->
  <div class="px-4 pt-4 pb-3 border-b border-gray-800">
    <h1 class="text-white font-bold text-lg leading-tight">GeoData Indonesia</h1>
    <p class="text-gray-400 text-xs mt-0.5">Deforestasi 2000–2026</p>
  </div>

  <!-- Scrollable content -->
  <div class="flex-1 overflow-y-auto px-4 py-4 space-y-5">
    <!-- Search -->
    <SearchBar {kotaList} onSelect={onSelectKota} />

    <!-- Divider -->
    <div class="border-t border-gray-800"></div>

    <!-- Stats -->
    <StatsPanel {stats} {showingOnMap} loading={statsLoading} {layerMode} />

    <!-- C8: Chart distribusi event per tahun -->
    {#if yearsAsc.length > 1}
      <div class="border-t border-gray-800"></div>
      <div class="space-y-1.5">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Distribusi per Tahun</span>
        <svg
          viewBox="0 0 {yearsAsc.length * 14} 52"
          class="w-full"
          style="height:3.25rem"
          role="img"
          aria-label="Distribusi event deforestasi per tahun"
        >
          {#each yearsAsc as y, i}
            {@const barH = Math.max(2, (y.count / maxYearCount) * 44)}
            <rect
              x={i * 14 + 1}
              y={52 - barH - 4}
              width={12}
              height={barH}
              fill={y.year === selectedYear ? '#14b8a6' : '#374151'}
              rx={2}
              style="cursor:pointer;transition:fill 0.15s"
              onclick={() => { selectedYear = y.year === selectedYear ? null : y.year; }}
            ><title>{y.year}: {y.count.toLocaleString('id-ID')} event</title></rect>
          {/each}
        </svg>
        <div class="flex justify-between text-[10px] text-gray-600 -mt-0.5">
          <span>{yearsAsc[0].year}</span>
          <span>{yearsAsc[yearsAsc.length - 1].year}</span>
        </div>
      </div>
    {/if}

    <!-- H4: Top 10 Kabupaten Terparah (heatmap mode only) -->
    {#if layerMode === 'heatmap' && topKota.length > 0}
      <div class="border-t border-gray-800"></div>
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Top 10 Terparah</span>
          <!-- H8: Export CSV -->
          {#if allHeatmapKota.length > 0}
            <button
              onclick={exportCSV}
              disabled={exportLoading}
              class="text-[11px] text-gray-500 hover:text-teal-400 transition-colors disabled:opacity-40"
              title="Export semua kab/kota sebagai CSV"
            >{exportLoading ? '…' : '↓ CSV'}</button>
          {/if}
        </div>
        <div class="space-y-1.5">
          {#each topKota as kota, i}
            <div class="flex items-center gap-2">
              <span class="text-[10px] text-gray-600 font-mono w-5 text-right shrink-0">#{i + 1}</span>
              <div class="flex-1 min-w-0">
                <div class="text-xs text-white truncate font-medium">{kota.kota_name}</div>
                <div class="text-[10px] text-gray-500 truncate">{kota.provinsi}</div>
              </div>
              <span class="text-[11px] text-orange-400 font-semibold shrink-0 tabular-nums">
                {kota.record_count.toLocaleString('id-ID')}
              </span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Divider -->
    <div class="border-t border-gray-800"></div>

    <!-- Year Filter -->
    <YearDropdown {years} bind:selectedYear />

    <!-- C9/H10: Animasi Tahun — slider + play/pause -->
    {#if yearsAsc.length > 1}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Animasi Tahun</span>
          <span class="text-xs font-mono {playing ? 'text-orange-400' : 'text-teal-400'}">
            {selectedYear ?? 'Semua'}
          </span>
        </div>
        <!-- Scrubber -->
        <input
          type="range"
          min={0}
          max={yearsAsc.length - 1}
          value={currentIndex() >= 0 ? currentIndex() : 0}
          oninput={(e) => {
            const idx = parseInt((e.target as HTMLInputElement).value, 10);
            if (idx >= 0 && idx < yearsAsc.length) selectedYear = yearsAsc[idx].year;
          }}
          class="w-full h-1.5 cursor-pointer accent-teal-500"
        />
        <div class="flex justify-between text-[10px] text-gray-600 -mt-1">
          <span>{yearsAsc[0].year}</span>
          <span>{yearsAsc[yearsAsc.length - 1].year}</span>
        </div>
        <!-- Controls -->
        <div class="flex items-center gap-2">
          <button
            onclick={togglePlay}
            class="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors
                   {playing
                     ? 'bg-orange-600/80 hover:bg-orange-600 text-white'
                     : 'bg-teal-600/80 hover:bg-teal-600 text-white'}"
          >
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button
            onclick={resetAnimation}
            title="Reset ke semua tahun"
            class="px-2.5 py-1.5 rounded-lg text-xs bg-gray-800 text-gray-400 hover:text-white transition-colors"
          >⏮</button>
        </div>
      </div>
    {/if}

    <!-- Divider -->
    <div class="border-t border-gray-800"></div>

    <!-- View Toggle -->
    <ViewToggle bind:layerMode featureCount={showingOnMap} />

    <!-- C10: Share Link -->
    <div class="border-t border-gray-800"></div>
    <button
      onclick={shareLink}
      class="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs transition-colors
             {copySuccess
               ? 'bg-green-900/50 text-green-400'
               : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'}"
    >
      {copySuccess ? '✓ Link tersalin!' : '🔗 Salin Link'}
    </button>
  </div>

  <!-- Footer / Selected Kota -->
  {#if selectedKota}
    <div class="px-4 py-3 border-t border-gray-800 bg-gray-850">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-xs text-gray-400">Wilayah Dipilih</div>
          <div class="text-sm font-semibold text-teal-400">{selectedKota.kota_name}</div>
          <div class="text-xs text-gray-400">{selectedKota.provinsi}</div>
        </div>
        <button
          class="text-gray-400 hover:text-white text-lg"
          onclick={() => onSelectKota(null)}
        >✕</button>
      </div>
    </div>
  {/if}
</div>
