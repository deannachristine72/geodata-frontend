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

    // Fetch metadata (years + kota list) — tidak trigger load peta
    const [yearsData, kotaData] = await Promise.all([
      fetchYears().catch(() => []),
      fetchSearchKota().catch(() => []),
    ]);
    years = yearsData;
    kotaList = kotaData;

    // Stats hanya dimuat saat ada data (dataEnabled)
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

  // ─── Handler: Search (island atau kota) ─────────────────────────────────────
  function handleSearch(result: KotaSearchItem | IslandGroup | null) {
    if (result === null) {
      // User clear search → reset semua
      selectedKota = null;
      selectedBoundaryHasc = null;
      selectedProvinces = [];
      dataEnabled = false;
      return;
    }

    if ('type' in result && result.type === 'island') {
      // Pilih pulau/wilayah
      const island = result as IslandGroup;
      selectedKota = null;
      selectedBoundaryHasc = null;
      selectedProvinces = island.provinces;
      dataEnabled = true;
      mapView?.flyTo(island.center, island.zoom);
      loadStats();
    } else {
      // Pilih kota spesifik
      const kota = result as KotaSearchItem;
      selectedKota = kota;
      selectedBoundaryHasc = kota.hasc_code;
      // Jangan reset selectedProvinces — tetap filter pulau yang aktif (jika ada)
      dataEnabled = true;
      mapView?.flyTo(kota.centroid, 10);
      loadStats();
    }
  }

  // ─── Reaktif: Reload stats saat tahun berubah (hanya jika data aktif) ───────
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
      {dataEnabled}
    />
  </div>

  <!-- Side Panel (fixed width) -->
  <aside class="w-80 flex-shrink-0">
    <SidePanel
      bind:selectedYear
      bind:layerMode
      bind:selectedKota
      bind:selectedProvinces
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
