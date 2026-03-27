<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import { Protocol } from 'pmtiles';
  import { MapboxOverlay } from '@deck.gl/mapbox';
  import { GeoJsonLayer } from 'deck.gl';
  import { fetchPolygons, fetchHeatmap } from '$lib/api';
  import { intensityToRgba, polygonFillColor, POLYGON_LINE_COLOR, HEATMAP_LINE_COLOR } from '$lib/colorScale';
  import type { LayerMode, PickedFeature, PolygonProperties, KotaHeatmapProperties } from '$lib/types';

  // ─── Props (Svelte 5 runes) ─────────────────────────────────────────────────
  let {
    selectedYear = $bindable<number | null>(null),
    layerMode    = $bindable<LayerMode>('polygons'),
  }: {
    selectedYear: number | null;
    layerMode: LayerMode;
  } = $props();

  // ─── State ──────────────────────────────────────────────────────────────────
  let mapContainer: HTMLDivElement;
  let map: maplibregl.Map;
  let deckOverlay: InstanceType<typeof MapboxOverlay>;
  let loading = $state(false);
  let featureCount = $state(0);
  let pickedFeature = $state<PickedFeature | null>(null);
  let errorMsg = $state<string | null>(null);

  // Cache heatmap agar tidak re-fetch saat pindah viewport (hanya berubah per tahun)
  let heatmapCache: Record<string, object> = {};

  // AbortController untuk membatalkan fetch yang sudah tidak relevan
  let polygonAbort: AbortController | null = null;

  // Debounce timer untuk moveend
  let moveDebounce: ReturnType<typeof setTimeout> | null = null;

  // ─── Konstanta ──────────────────────────────────────────────────────────────
  // PMTiles: batas administratif Indonesia (zoom 0-10)
  // Ganti dengan URL GitHub Pages Anda jika sudah deploy
  const PMTILES_URL = 'https://deannachristine72.github.io/indonesia-pmtiles/indonesia.pmtiles';

  // Basemap CartoDB Voyager — memerlukan koneksi internet
  const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

  // ─── Setup MapLibre + deck.gl ────────────────────────────────────────────────
  onMount(async () => {
    // Daftarkan protokol pmtiles sebelum inisialisasi map
    const pmtilesProtocol = new Protocol();
    maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);

    // Inisialisasi MapLibre
    map = new maplibregl.Map({
      container: mapContainer,
      style: BASEMAP_STYLE,
      center: [118.0, -2.5],   // Tengah Indonesia
      zoom: 5,
      minZoom: 3,
      maxZoom: 18,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    // Inisialisasi deck.gl overlay dalam mode overlay (non-interleaved)
    // Mode interleaved tidak kompatibel dengan MapLibre GL v5 karena shader injection gagal
    deckOverlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
      // Callback saat user klik feature deck.gl
      onClick: (info) => {
        if (!info.picked) {
          pickedFeature = null;
          return;
        }
        pickedFeature = {
          type: layerMode,
          properties: info.object?.properties,
          coordinates: [info.coordinate?.[0] ?? 0, info.coordinate?.[1] ?? 0],
        };
      },
    });

    map.addControl(deckOverlay as unknown as maplibregl.IControl);

    // Tunggu map style selesai load sebelum menambahkan layer PMTiles
    map.on('load', () => {
      // requestAnimationFrame menjamin CSS layout sudah settled sebelum resize()
      // Fix BUG-02: map blank saat fresh load karena container height mismatch
      requestAnimationFrame(() => {
        map.resize();       // Sinkronisasi canvas dengan dimensi container aktual
        addPmtilesLayer();
        loadData();         // Load data awal setelah dimensi benar
      });
    });

    // Reload polygon saat viewport berubah (dengan debounce 400ms)
    map.on('moveend', () => {
      if (layerMode !== 'polygons') return;
      if (moveDebounce) clearTimeout(moveDebounce);
      moveDebounce = setTimeout(() => loadPolygons(), 400);
    });
  });

  onDestroy(() => {
    if (moveDebounce) clearTimeout(moveDebounce);
    polygonAbort?.abort();
    map?.remove();
  });

  // ─── PMTiles Layer (batas wilayah Indonesia) ─────────────────────────────────
  function addPmtilesLayer() {
    // Tambahkan source PMTiles — protocol pmtiles:// sudah didaftarkan
    map.addSource('indonesia-admin', {
      type: 'vector',
      url: `pmtiles://${PMTILES_URL}`,
      minzoom: 0,
      maxzoom: 10,
    });

    // Layer batas provinsi — garis putih tipis, zoom 4-10
    map.addLayer({
      id: 'admin-provinsi',
      type: 'line',
      source: 'indonesia-admin',
      'source-layer': 'province',  // nama layer di file PMTiles
      minzoom: 4,
      paint: {
        'line-color': 'rgba(255,255,255,0.6)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 10, 1.5],
      },
    });

    // Layer batas kabupaten — zoom 7+
    map.addLayer({
      id: 'admin-kab',
      type: 'line',
      source: 'indonesia-admin',
      'source-layer': 'regency',
      minzoom: 7,
      paint: {
        'line-color': 'rgba(255,255,255,0.3)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.3, 12, 1],
      },
    });
  }

  // ─── Load Data Berdasarkan Mode ───────────────────────────────────────────────
  function loadData() {
    if (layerMode === 'polygons') {
      loadPolygons();
    } else {
      loadHeatmap();
    }
  }

  // ─── Fetch + Render Polygon Deforestasi ───────────────────────────────────────
  async function loadPolygons() {
    if (!map || !deckOverlay) return;

    // Batalkan request sebelumnya jika masih berjalan
    polygonAbort?.abort();
    polygonAbort = new AbortController();

    const bounds = map.getBounds();
    const params = {
      minLon: bounds.getWest(),
      minLat: bounds.getSouth(),
      maxLon: bounds.getEast(),
      maxLat: bounds.getNorth(),
      year: selectedYear,
      limit: 5000,
    };

    loading = true;
    errorMsg = null;

    try {
      const data = await fetchPolygons(params, polygonAbort.signal);
      featureCount = data.features.length;

      deckOverlay.setProps({
        layers: [
          new GeoJsonLayer({
            id: 'deforest-polygons',
            data: data,
            // Render polygon fill dengan warna berdasarkan area
            getFillColor: (f: { properties: PolygonProperties }) =>
              polygonFillColor(f.properties.area_km2),
            getLineColor: POLYGON_LINE_COLOR,
            lineWidthMinPixels: 0.5,
            lineWidthMaxPixels: 2,
            pickable: true,
            pickingRadius: 5, // Fix BUG-03: perluas area klik agar polygon kecil lebih mudah dipilih
            autoHighlight: true,
            highlightColor: [255, 255, 0, 100],
            updateTriggers: {
              getFillColor: selectedYear,
            },
          }),
        ],
      });
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        errorMsg = 'Gagal memuat data polygon. Periksa backend FastAPI.';
        console.error(err);
      }
    } finally {
      loading = false;
    }
  }

  // ─── Fetch + Render Heatmap Kota ─────────────────────────────────────────────
  async function loadHeatmap() {
    if (!map || !deckOverlay) return;

    const cacheKey = selectedYear != null ? String(selectedYear) : 'all';

    loading = true;
    errorMsg = null;

    try {
      // Gunakan cache jika sudah ada
      if (!heatmapCache[cacheKey]) {
        heatmapCache[cacheKey] = await fetchHeatmap(selectedYear);
      }
      const data = heatmapCache[cacheKey] as { features: Array<{ properties: KotaHeatmapProperties }> };
      featureCount = data.features?.length ?? 0;

      deckOverlay.setProps({
        layers: [
          new GeoJsonLayer({
            id: 'kota-heatmap',
            data: data,
            getFillColor: (f: { properties: KotaHeatmapProperties }) =>
              intensityToRgba(f.properties.intensity, 200),
            getLineColor: HEATMAP_LINE_COLOR,
            lineWidthMinPixels: 0.3,
            pickable: true,
            pickingRadius: 5, // Fix BUG-03: perluas area klik untuk heatmap juga
            autoHighlight: true,
            highlightColor: [255, 255, 255, 60],
            updateTriggers: {
              getFillColor: selectedYear,
            },
          }),
        ],
      });
    } catch (err: unknown) {
      errorMsg = 'Gagal memuat data heatmap. Periksa backend FastAPI.';
      console.error(err);
    } finally {
      loading = false;
    }
  }

  // ─── Helper: Cari Label Layer MapLibre untuk Interleaved Rendering ────────────
  function getFirstLabelLayerId(): string | undefined {
    if (!map) return undefined;
    const layers = map.getStyle()?.layers ?? [];
    const labelLayer = layers.find(
      (l) => l.type === 'symbol' && (l.id.includes('label') || l.id.includes('place'))
    );
    return labelLayer?.id;
  }

  // ─── Reaktif: Reload saat year atau mode berubah ──────────────────────────────
  $effect(() => {
    // Effect ini berjalan setiap kali selectedYear atau layerMode berubah
    // Pastikan map dan overlay sudah siap
    if (!map || !deckOverlay) return;
    // Clear heatmap cache jika tahun berubah sehingga data fresh
    pickedFeature = null;
    loadData();
  });
</script>

<!-- ─── Template ──────────────────────────────────────────────────────────── -->
<div class="relative w-full h-full">
  <!-- Map Container -->
  <div bind:this={mapContainer} class="w-full h-full"></div>

  <!-- Loading Spinner -->
  {#if loading}
    <div class="absolute top-4 left-1/2 -translate-x-1/2 z-10
                bg-black/70 text-white text-sm px-4 py-2 rounded-full
                flex items-center gap-2 pointer-events-none">
      <span class="inline-block w-3 h-3 border-2 border-white border-t-transparent
                   rounded-full animate-spin"></span>
      Memuat data...
    </div>
  {/if}

  <!-- Error Message -->
  {#if errorMsg}
    <div class="absolute top-4 left-1/2 -translate-x-1/2 z-10
                bg-red-900/90 text-white text-sm px-4 py-2 rounded-lg max-w-xs text-center">
      {errorMsg}
    </div>
  {/if}

  <!-- Feature Count Badge -->
  {#if !loading && featureCount > 0}
    <div class="absolute bottom-10 left-4 z-10
                bg-black/70 text-white text-xs px-3 py-1.5 rounded-full">
      {featureCount.toLocaleString('id-ID')}
      {layerMode === 'polygons' ? 'polygon' : 'kab/kota'}
      {selectedYear != null ? `(${selectedYear})` : '(semua tahun)'}
    </div>
  {/if}

  <!-- Info Panel — Klik Feature -->
  {#if pickedFeature}
    <div class="absolute bottom-20 left-4 z-10 w-72
                bg-gray-900/95 text-white rounded-xl shadow-xl overflow-hidden">
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3 bg-orange-700/80">
        <span class="font-semibold text-sm">
          {pickedFeature.type === 'polygons' ? 'Polygon Deforestasi' : 'Kabupaten / Kota'}
        </span>
        <button
          class="text-white/70 hover:text-white text-lg leading-none"
          onclick={() => (pickedFeature = null)}
        >×</button>
      </div>

      <!-- Properties -->
      <div class="px-4 py-3 space-y-1.5 text-sm">
        {#if pickedFeature.type === 'polygons'}
          {@const p = pickedFeature.properties as PolygonProperties}
          <div class="flex justify-between">
            <span class="text-gray-400">UUID</span>
            <span class="font-mono text-xs">{p.uuid.slice(0, 12)}…</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-400">Luas</span>
            <span class="font-semibold text-orange-300">{p.area_km2.toLocaleString('id-ID', { maximumFractionDigits: 2 })} km²</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-400">Tanggal Mulai</span>
            <span>{p.start_date}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-400">Tanggal Akhir</span>
            <span>{p.end_date}</span>
          </div>
        {:else}
          {@const p = pickedFeature.properties as KotaHeatmapProperties}
          <div class="flex justify-between">
            <span class="text-gray-400">Provinsi</span>
            <span>{p.provinsi}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-400">Kota/Kab</span>
            <span class="font-semibold">{p.kota_name}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-400">Jumlah Event</span>
            <span class="font-semibold text-orange-300">{p.record_count.toLocaleString('id-ID')}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-400">Total Luas</span>
            <span>{(p.total_area_km2 / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} ribu km²</span>
          </div>
          <!-- Intensity bar -->
          <div class="mt-2">
            <div class="text-gray-400 text-xs mb-1">Intensitas Deforestasi</div>
            <div class="w-full h-2 rounded bg-gray-700">
              <div
                class="h-2 rounded"
                style="width:{(p.intensity * 100).toFixed(1)}%; background: rgb({Math.round(255 * p.intensity)},{Math.round(120 * (1 - p.intensity))},30)"
              ></div>
            </div>
            <div class="text-right text-xs text-gray-400 mt-0.5">{(p.intensity * 100).toFixed(1)}%</div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
