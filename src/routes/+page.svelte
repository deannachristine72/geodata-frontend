<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import MapView        from '$lib/components/MapView.svelte';
  import SidePanel      from '$lib/components/SidePanel.svelte';
  import SearchBar      from '$lib/components/SearchBar.svelte';
  import BottomTimeline from '$lib/components/BottomTimeline.svelte';
  import NavBtn         from '$lib/components/NavBtn.svelte';
  import { fetchYears, fetchSearchKota, fetchStats } from '$lib/api';
  import type {
    KotaHeatmapProperties, LayerMode, YearCount,
    KotaSearchItem, StatsData
  } from '$lib/types';
  import type { IslandGroup } from '$lib/islands';

  // ── App state ────────────────────────────────────────────────────────────
  let selectedYear         = $state<number | null>(null);
  let layerMode            = $state<LayerMode>('centroids');
  let years                = $state<YearCount[]>([]);
  let kotaList             = $state<KotaSearchItem[]>([]);
  let stats                = $state<StatsData | null>(null);
  let statsLoading         = $state(false);
  let featureCount         = $state(0);
  let mapLoading           = $state(false);
  let selectedKota         = $state<KotaSearchItem | null>(null);
  let selectedBoundaryHasc = $state<string | null>(null);
  let topKota              = $state<KotaHeatmapProperties[]>([]);
  let allHeatmapKota       = $state<KotaHeatmapProperties[]>([]);
  let selectedProvinces    = $state<string[]>([]);
  let selectedKotaHasc     = $state<string | null>(null);
  let selectedKotaBbox     = $state<[number, number, number, number] | null>(null);
  let searchValue          = $state('');
  let dataEnabled          = $state(false);
  let mapView: MapView;

  // ── UI state ─────────────────────────────────────────────────────────────
  let isDark       = $state(false);  // light mode on by default
  let sidebarOpen  = $state(true);   // sidebar expanded by default

  // ── Share Link (C10) ──────────────────────────────────────────────────────
  let copySuccess  = $state(false);
  let copyTimeout: ReturnType<typeof setTimeout> | null = null;

  function shareLink() {
    const params = new URLSearchParams();
    if (selectedYear != null) params.set('year', String(selectedYear));
    if (layerMode !== 'centroids') params.set('mode', layerMode);
    const qs  = params.toString();
    const url = `${window.location.origin}${window.location.pathname}${qs ? '?' + qs : ''}`;
    navigator.clipboard.writeText(url).then(() => {
      copySuccess = true;
      if (copyTimeout) clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => { copySuccess = false; }, 2000);
    }).catch(() => {});
  }

  // ── Export CSV (H8) ───────────────────────────────────────────────────────
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
      const headers = ['hasc_code','kota_name','provinsi','record_count','total_area_km2','intensity'];
      const rows = allHeatmapKota.map(k => [
        escapeCSV(k.hasc_code), escapeCSV(k.kota_name), escapeCSV(k.provinsi),
        k.record_count, k.total_area_km2.toFixed(2), k.intensity.toFixed(4),
      ]);
      const csv  = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `banjirmap-kota-${selectedYear ?? 'semua'}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      exportLoading = false;
    }
  }

  // ── Mount ────────────────────────────────────────────────────────────────
  onMount(async () => {
    const params    = new URLSearchParams(window.location.search);
    const yearParam = params.get('year');
    if (yearParam) { const y = parseInt(yearParam, 10); if (!isNaN(y)) selectedYear = y; }
    const modeParam = params.get('mode');
    if (modeParam === 'heatmap' || modeParam === 'centroids') layerMode = modeParam;
    const [yearsData, kotaData] = await Promise.all([
      fetchYears().catch(() => []),
      fetchSearchKota().catch(() => []),
    ]);
    years    = yearsData;
    kotaList = kotaData;
  });

  onDestroy(() => { if (copyTimeout) clearTimeout(copyTimeout); });

  // ── Stats ────────────────────────────────────────────────────────────────
  async function loadStats() {
    statsLoading = true;
    try { stats = await fetchStats(selectedYear); }
    catch { console.warn('Gagal memuat statistik'); }
    finally { statsLoading = false; }
  }

  // ── Reset all ────────────────────────────────────────────────────────────
  function handleReset() {
    searchValue          = '';
    selectedKota         = null;
    selectedBoundaryHasc = null;
    selectedProvinces    = [];
    selectedKotaHasc     = null;
    selectedKotaBbox     = null;
    dataEnabled          = false;
    stats                = null;
  }

  // ── Reset year only (used by BottomTimeline's clear button) ─────────────
  // Full reset (navbar button) → handleReset() below

  // ── Search handler ───────────────────────────────────────────────────────
  function handleSearch(result: KotaSearchItem | IslandGroup | null) {
    if (result === null) { handleReset(); return; }
    if ('type' in result && result.type === 'island') {
      const island         = result as IslandGroup;
      selectedKota         = null;
      selectedBoundaryHasc = null;
      selectedKotaHasc     = null;
      selectedKotaBbox     = null;
      selectedProvinces    = island.provinces;
      dataEnabled          = true;
      mapView?.flyTo(island.center, island.zoom);
      loadStats();
    } else {
      const kota           = result as KotaSearchItem;
      selectedKota         = kota;
      selectedBoundaryHasc = kota.hasc_code;
      selectedKotaHasc     = kota.hasc_code;
      selectedKotaBbox     = kota.bbox;
      selectedProvinces    = [];
      dataEnabled          = true;
      mapView?.flyTo(kota.centroid, 10);
      loadStats();
    }
  }

  // ── Reactive stats reload ────────────────────────────────────────────────
  $effect(() => {
    const _year = selectedYear;
    if (dataEnabled) loadStats();
  });

  // ── Tooltip label helpers ────────────────────────────────────────────────
  const csvTooltip = $derived(
    allHeatmapKota.length === 0
      ? 'Export CSV (aktifkan Heatmap dulu)'
      : exportLoading
        ? 'Mengekspor…'
        : 'Export to CSV'
  );
  const shareTooltip = $derived(copySuccess ? 'Link tersalin! ✓' : 'Salin Link');
  const resetTooltip = $derived(
    dataEnabled ? 'Reset semua pilihan' : 'Belum ada pilihan'
  );
  const themeTooltip = $derived(isDark ? 'Ganti ke Light Mode' : 'Ganti ke Dark Mode');
</script>

<!-- ── Root: adds/removes "dark" class for Tailwind dark mode ── -->
<div
  class="w-screen h-screen flex flex-col bg-slate-100 dark:bg-gray-950"
  class:dark={isDark}
>

  <!-- ══ Top Navbar ══════════════════════════════════════════════════════════ -->
  <nav
    class="h-12 flex-shrink-0 z-40
           bg-white dark:bg-gray-900
           border-b border-gray-200 dark:border-gray-800
           flex items-center gap-2 px-3 shadow-sm dark:shadow-none"
  >

    <!-- Logo + Title -->
    <div class="flex items-center gap-2 shrink-0 mr-1">
      <div class="w-7 h-7 rounded-lg bg-teal-600 flex items-center justify-center shrink-0">
        <svg class="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
          <circle cx="12" cy="9" r="2.5" fill="currentColor" stroke="none"/>
        </svg>
      </div>
      <div class="leading-tight hidden sm:block">
        <h1 class="text-gray-900 dark:text-white font-bold text-sm tracking-tight">
          BanjirMap Indonesia
        </h1>
        <p class="text-gray-500 dark:text-gray-500 text-[10px] uppercase tracking-wider">
          Peta Kejadian · 2000–2025
        </p>
      </div>
    </div>

    <!-- Search bar (center, flexible) -->
    <div class="flex-1 min-w-0 max-w-md mx-auto relative z-50">
      <SearchBar {kotaList} bind:searchValue onSelect={handleSearch} />
    </div>

    <!-- ── Right-side action buttons ── -->
    <div class="flex items-center gap-0.5 shrink-0 ml-1">

      <!-- Reset All (clears selection + returns to initial state) -->
      <NavBtn
        label={resetTooltip}
        onclick={handleReset}
        disabled={!dataEnabled}
      >
        <!-- Counter-clockwise / reset icon -->
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="1 4 1 10 7 10"/>
          <path d="M3.51 15a9 9 0 1 0 .49-6L1 10"/>
        </svg>
      </NavBtn>

      <!-- Share Link -->
      <NavBtn label={shareTooltip} onclick={shareLink} active={copySuccess}>
        {#if copySuccess}
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        {:else}
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
        {/if}
      </NavBtn>

      <!-- Export CSV -->
      <NavBtn
        label={csvTooltip}
        onclick={exportCSV}
        disabled={allHeatmapKota.length === 0 || exportLoading}
      >
        {#if exportLoading}
          <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
        {:else}
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        {/if}
      </NavBtn>

      <!-- Divider -->
      <div class="w-px h-5 bg-gray-200 dark:bg-gray-700 mx-1"></div>

      <!-- ── Dark / Light Mode Toggle (iOS style) ── -->
      <div class="relative group">
        <button
          onclick={() => isDark = !isDark}
          role="switch"
          aria-checked={isDark}
          class="relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full
                 cursor-pointer transition-colors duration-300 focus:outline-none
                 focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1
                 {isDark ? 'bg-blue-500' : 'bg-gray-300'}"
        >
          <!-- Sliding thumb -->
          <span
            class="inline-flex items-center justify-center
                   h-5 w-5 rounded-full shadow-md
                   transition-transform duration-300
                   {isDark
                     ? 'translate-x-[22px] bg-white'
                     : 'translate-x-[2px] bg-gray-600'}"
          >
            {#if isDark}
              <!-- Sun (dark mode active) -->
              <svg class="w-[11px] h-[11px] text-blue-500" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <circle cx="12" cy="12" r="4"/>
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41
                         M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
              </svg>
            {:else}
              <!-- Moon (light mode active) -->
              <svg class="w-[11px] h-[11px] text-gray-200" viewBox="0 0 24 24"
                   fill="currentColor">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            {/if}
          </span>
        </button>

        <!-- Tooltip -->
        <div class="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-[100]
                    pointer-events-none opacity-0 group-hover:opacity-100
                    transition-opacity duration-150">
          <div class="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2
                      bg-gray-800 dark:bg-gray-900 rotate-45"></div>
          <div class="relative bg-gray-800 dark:bg-gray-900 text-white text-[11px]
                      px-2.5 py-1.5 rounded-md shadow-xl whitespace-nowrap leading-tight">
            {themeTooltip}
          </div>
        </div>
      </div>

    </div><!-- end right buttons -->
  </nav>

  <!-- ══ Content row: Map + collapsible Sidebar ══════════════════════════════ -->
  <div class="flex-1 flex min-h-0">

    <!-- Map area -->
    <div class="flex-1 relative min-w-0">
      <MapView
        bind:this={mapView}
        bind:selectedYear
        bind:layerMode
        bind:featureCount
        bind:loading={mapLoading}
        bind:topKota
        bind:allHeatmapKota
        {selectedBoundaryHasc}
        {selectedProvinces}
        {selectedKotaHasc}
        {selectedKotaBbox}
        {dataEnabled}
        {kotaList}
        {isDark}
        onReset={handleReset}
      />

      <!-- C8 + C9: Bottom Timeline panel (floats over map) -->
      <BottomTimeline bind:selectedYear {years} />
    </div>

    <!-- ── Collapsible Sidebar ── -->
    <div
      class="relative flex-shrink-0 h-full overflow-visible"
      style="width: {sidebarOpen ? '320px' : '0px'}; transition: width 0.25s cubic-bezier(0.4,0,0.2,1);"
    >
      <!-- Toggle handle: always visible at left edge -->
      <button
        onclick={() => sidebarOpen = !sidebarOpen}
        title={sidebarOpen ? 'Sembunyikan panel' : 'Tampilkan panel'}
        class="absolute -left-5 top-1/2 -translate-y-1/2 z-30
               w-5 h-14 flex items-center justify-center
               rounded-l-xl
               bg-white  dark:bg-gray-800
               border border-r-0 border-gray-200 dark:border-gray-700
               text-gray-400 dark:text-gray-500
               hover:bg-gray-50 dark:hover:bg-gray-700
               hover:text-gray-700 dark:hover:text-gray-300
               shadow-[-2px_0_6px_rgba(0,0,0,0.08)] dark:shadow-[-2px_0_6px_rgba(0,0,0,0.3)]
               transition-colors"
      >
        <!-- Chevron: right = close (sidebar visible), left = open (sidebar hidden) -->
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          {#if sidebarOpen}
            <polyline points="9 18 15 12 9 6"/><!-- chevron right = collapse -->
          {:else}
            <polyline points="15 18 9 12 15 6"/><!-- chevron left = expand -->
          {/if}
        </svg>
      </button>

      <!-- Clip mask: hides panel content when sidebar closes -->
      <div class="absolute inset-0 overflow-hidden">
        <div class="w-80 h-full">
          <SidePanel
            bind:selectedYear
            bind:layerMode
            {years}
            {topKota}
            {stats}
            showingOnMap={featureCount}
            {statsLoading}
            {selectedKota}
            onDeselectKota={() => handleSearch(null)}
          />
        </div>
      </div>
    </div>

  </div>
</div>
