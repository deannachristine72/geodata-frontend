<script lang="ts">
  import { onMount } from 'svelte';
  import MapView from '$lib/components/MapView.svelte';
  import SidePanel from '$lib/components/SidePanel.svelte';
  import { fetchYears, fetchSearchKota, fetchStats } from '$lib/api';
  import type { KotaHeatmapProperties, LayerMode, YearCount, KotaSearchItem, StatsData } from '$lib/types';
  import type { IslandGroup } from '$lib/islands';

  // ─── State ──────────────────────────────────────────────────────────────────
  let selectedYear = $state<number | null>(null);
  let layerMode    = $state<LayerMode>('centroids');
  let years        = $state<YearCount[]>([]);
  let kotaList     = $state<KotaSearchItem[]>([]);
  let stats        = $state<StatsData | null>(null);
  let statsLoading = $state(false);
  let featureCount = $state(0);
  let mapLoading   = $state(false);
  let selectedKota = $state<KotaSearchItem | null>(null);
  let selectedBoundaryHasc = $state<string | null>(null);
  let topKota        = $state<KotaHeatmapProperties[]>([]);
  let allHeatmapKota = $state<KotaHeatmapProperties[]>([]);
  let selectedProvinces = $state<string[]>([]);

  // Filter kota spesifik (untuk heatmap + centroid kota search)
  let selectedKotaHasc = $state<string | null>(null);
  let selectedKotaBbox = $state<[number, number, number, number] | null>(null);

  // Untuk reset search bar dari luar
  let searchValue = $state('');

  // Data tidak dimuat sampai user memilih dari search
  let dataEnabled = $state(false);

  // Referensi ke MapView component untuk flyTo
  let mapView: MapView;

  onMount(async () => {
    // C10: Restore state dari URL params
    const params = new URLSearchParams(window.location.search);
    const yearParam = params.get('year');
    if (yearParam) { const y = parseInt(yearParam, 10); if (!isNaN(y)) selectedYear = y; }
    const modeParam = params.get('mode');
    if (modeParam === 'heatmap' || modeParam === 'centroids') layerMode = modeParam;

    // Fetch metadata saja — tidak trigger load peta
    const [yearsData, kotaData] = await Promise.all([
      fetchYears().catch(() => []),
      fetchSearchKota().catch(() => []),
    ]);
    years = yearsData;
    kotaList = kotaData;
  });

  // ─── Fetch Stats ─────────────────────────────────────────────────────────────
  async function loadStats() {
    statsLoading = true;
    try {
      stats = await fetchStats(selectedYear);
    } catch {
      console.warn('Gagal memuat statistik');
    } finally {
      statsLoading = false;
    }
  }

  // ─── Reset semua state ke kondisi awal ───────────────────────────────────────
  function handleReset() {
    searchValue = '';
    selectedKota = null;
    selectedBoundaryHasc = null;
    selectedProvinces = [];
    selectedKotaHasc = null;
    selectedKotaBbox = null;
    dataEnabled = false;
    stats = null;
  }

  // ─── Handler: Search (island atau kota) ─────────────────────────────────────
  function handleSearch(result: KotaSearchItem | IslandGroup | null) {
    if (result === null) {
      handleReset();
      return;
    }

    if ('type' in result && result.type === 'island') {
      const island = result as IslandGroup;
      selectedKota = null;
      selectedBoundaryHasc = null;
      selectedKotaHasc = null;
      selectedKotaBbox = null;
      selectedProvinces = island.provinces;
      dataEnabled = true;
      mapView?.flyTo(island.center, island.zoom);
      loadStats();
    } else {
      const kota = result as KotaSearchItem;
      selectedKota = kota;
      selectedBoundaryHasc = kota.hasc_code;
      selectedKotaHasc = kota.hasc_code;
      selectedKotaBbox = kota.bbox;
      selectedProvinces = []; // kota filter menggantikan province filter
      dataEnabled = true;
      mapView?.flyTo(kota.centroid, 10);
      loadStats();
    }
  }

  // ─── Reaktif: Reload stats saat tahun berubah ───────────────────────────────
  $effect(() => {
    const _year = selectedYear;
    if (dataEnabled) loadStats();
  });
</script>

<!-- Layout 2-kolom: Map + Side Panel -->
<div class="w-screen h-screen flex bg-gray-950">

  <!-- Map (flex-1, mengisi sisa ruang) -->
  <div class="flex-1 relative">
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
      onReset={handleReset}
    />
  </div>

  <!-- Side Panel (fixed width) -->
  <aside class="w-80 flex-shrink-0">
    <SidePanel
      bind:selectedYear
      bind:layerMode
      bind:selectedKota
      bind:selectedProvinces
      bind:searchValue
      {years}
      {kotaList}
      {topKota}
      {allHeatmapKota}
      {stats}
      showingOnMap={featureCount}
      {statsLoading}
      onSelectKota={handleSearch}
    />
  </aside>

</div>
