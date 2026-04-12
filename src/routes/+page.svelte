<script lang="ts">
  import { onMount } from 'svelte';
  import MapView from '$lib/components/MapView.svelte';
  import SidePanel from '$lib/components/SidePanel.svelte';
  import { fetchYears, fetchSearchKota, fetchStats } from '$lib/api';
  import type { KotaHeatmapProperties, LayerMode, YearCount, KotaSearchItem, StatsData } from '$lib/types';

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

  // Referensi ke MapView component untuk flyTo
  let mapView: MapView;

  onMount(async () => {
    // C10: Restore state dari URL params
    const params = new URLSearchParams(window.location.search);
    const yearParam = params.get('year');
    if (yearParam) { const y = parseInt(yearParam, 10); if (!isNaN(y)) selectedYear = y; }
    const modeParam = params.get('mode');
    if (modeParam === 'heatmap' || modeParam === 'centroids') layerMode = modeParam;

    // Fetch semua data startup secara paralel
    const [yearsData, kotaData] = await Promise.all([
      fetchYears().catch(() => []),
      fetchSearchKota().catch(() => []),
    ]);
    years = yearsData;
    kotaList = kotaData;

    // Fetch stats awal
    loadStats();
  });

  // ─── Fetch Stats saat filter berubah ────────────────────────────────────────
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

  // ─── Handler: Kota dipilih dari search ──────────────────────────────────────
  function handleSelectKota(kota: KotaSearchItem | null) {
    selectedKota = kota;
    if (kota) {
      selectedBoundaryHasc = kota.hasc_code;
      // Fly ke kota yang dipilih
      mapView?.flyTo(kota.centroid, 10);
    } else {
      selectedBoundaryHasc = null;
    }
  }

  // ─── Reaktif: Reload stats saat tahun berubah ──────────────────────────────
  $effect(() => {
    // Track selectedYear untuk trigger reload
    const _year = selectedYear;
    loadStats();
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
    />
  </div>

  <!-- Side Panel (fixed width) -->
  <aside class="w-80 flex-shrink-0">
    <SidePanel
      bind:selectedYear
      bind:layerMode
      bind:selectedKota
      {years}
      {kotaList}
      {topKota}
      {allHeatmapKota}
      {stats}
      showingOnMap={featureCount}
      {statsLoading}
      onSelectKota={handleSelectKota}
    />
  </aside>

</div>
