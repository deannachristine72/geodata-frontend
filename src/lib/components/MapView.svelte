<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import { Protocol } from 'pmtiles';
  import { MapboxOverlay } from '@deck.gl/mapbox';
  import { GeoJsonLayer, ScatterplotLayer } from 'deck.gl';
  import { fetchHeatmap, fetchCentroids, fetchBoundary } from '$lib/api';
  import { intensityToRgba, HEATMAP_LINE_COLOR, centroidSeverityColor, CENTROID_SEVERITY_CLASSES } from '$lib/colorScale';
  import type { LayerMode, PickedFeature, KotaHeatmapProperties, CentroidPoint, PolygonProperties } from '$lib/types';

  // ─── Props (Svelte 5 runes) ─────────────────────────────────────────────────
  let {
    selectedYear = $bindable<number | null>(null),
    layerMode    = $bindable<LayerMode>('centroids'),
    featureCount = $bindable<number>(0),
    loading      = $bindable<boolean>(false),
    selectedBoundaryHasc = null,
  }: {
    selectedYear: number | null;
    layerMode: LayerMode;
    featureCount: number;
    loading: boolean;
    selectedBoundaryHasc: string | null;
  } = $props();

  // ─── State ──────────────────────────────────────────────────────────────────
  let mapContainer: HTMLDivElement;
  let map: maplibregl.Map;
  let deckOverlay: InstanceType<typeof MapboxOverlay>;
  let pickedFeature = $state<PickedFeature | null>(null);
  let errorMsg = $state<string | null>(null);

  // Cache heatmap agar tidak re-fetch saat pindah viewport
  let heatmapCache: Record<string, object> = {};

  // AbortController untuk membatalkan fetch yang sudah tidak relevan
  let dataAbort: AbortController | null = null;

  // Debounce timer untuk moveend
  let moveDebounce: ReturnType<typeof setTimeout> | null = null;

  // ─── Konstanta ──────────────────────────────────────────────────────────────
  const PMTILES_URL = 'https://deannachristine72.github.io/indonesia-pmtiles/indonesia.pmtiles';
  const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

  // Warna highlight centroid saat hover/klik
  const CENTROID_HIGHLIGHT: [number, number, number, number] = [255, 255, 255, 240];

  // ─── Setup MapLibre + deck.gl ────────────────────────────────────────────────
  onMount(async () => {
    const pmtilesProtocol = new Protocol();
    maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);

    map = new maplibregl.Map({
      container: mapContainer,
      style: BASEMAP_STYLE,
      center: [118.0, -2.5],
      zoom: 5,
      minZoom: 3,
      maxZoom: 18,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-left');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    deckOverlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      onClick: (info) => {
        if (!info.picked) {
          pickedFeature = null;
          return;
        }
        // Untuk centroid, data berupa array [lon, lat, area, year, uuid]
        if (layerMode === 'centroids' && Array.isArray(info.object)) {
          const d = info.object as CentroidPoint;
          pickedFeature = {
            type: 'centroids',
            properties: {
              uuid: d[4],
              area_km2: d[2],
              year: d[3],
              start_date: '',
              end_date: '',
            } as PolygonProperties,
            coordinates: [d[0], d[1]],
          };
        } else {
          pickedFeature = {
            type: 'heatmap',
            properties: info.object?.properties,
            coordinates: [info.coordinate?.[0] ?? 0, info.coordinate?.[1] ?? 0],
          };
        }
      },
    });

    map.addControl(deckOverlay as unknown as maplibregl.IControl);

    map.on('load', () => {
      requestAnimationFrame(() => {
        map.resize();
        addPmtilesLayer();
        addBoundarySource();
        loadData();
      });
    });

    // Reload data saat viewport berubah (centroid mode)
    map.on('moveend', () => {
      if (layerMode === 'heatmap') return;
      if (moveDebounce) clearTimeout(moveDebounce);
      moveDebounce = setTimeout(() => loadData(), 400);
    });
  });

  onDestroy(() => {
    if (moveDebounce) clearTimeout(moveDebounce);
    dataAbort?.abort();
    map?.remove();
  });

  // ─── PMTiles Layer (batas wilayah Indonesia) ─────────────────────────────────
  function addPmtilesLayer() {
    map.addSource('indonesia-admin', {
      type: 'vector',
      url: `pmtiles://${PMTILES_URL}`,
      minzoom: 0,
      maxzoom: 10,
    });

    map.addLayer({
      id: 'admin-provinsi',
      type: 'line',
      source: 'indonesia-admin',
      'source-layer': 'province',
      minzoom: 4,
      paint: {
        'line-color': 'rgba(100,100,100,0.4)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 10, 1.5],
      },
    });

    map.addLayer({
      id: 'admin-kab',
      type: 'line',
      source: 'indonesia-admin',
      'source-layer': 'regency',
      minzoom: 7,
      paint: {
        'line-color': 'rgba(100,100,100,0.25)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.3, 12, 1],
      },
    });
  }

  // ─── Boundary Source + Layer untuk highlight kota yang dipilih ────────────────
  function addBoundarySource() {
    // Source GeoJSON kosong — diisi saat user pilih kota dari search
    map.addSource('selected-boundary', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    // Fill transparan
    map.addLayer({
      id: 'selected-boundary-fill',
      type: 'fill',
      source: 'selected-boundary',
      paint: {
        'fill-color': '#f97316',
        'fill-opacity': 0.06,
      },
    });

    // Outline tebal oranye
    map.addLayer({
      id: 'selected-boundary-line',
      type: 'line',
      source: 'selected-boundary',
      paint: {
        'line-color': '#f97316',
        'line-width': 2.5,
        'line-opacity': 0.9,
      },
    });
  }

  // ─── Update Boundary saat kota dipilih ───────────────────────────────────────
  async function updateBoundary(hascCode: string | null) {
    if (!map || !map.getSource('selected-boundary')) return;

    if (!hascCode) {
      // Hapus boundary
      (map.getSource('selected-boundary') as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: [],
      });
      return;
    }

    try {
      const feature = await fetchBoundary(hascCode);
      (map.getSource('selected-boundary') as maplibregl.GeoJSONSource).setData(
        feature as GeoJSON.Feature
      );
    } catch (err) {
      console.error('Gagal memuat boundary kota:', err);
    }
  }

  // ─── Expose flyTo untuk dipanggil dari parent ────────────────────────────────
  export function flyTo(center: [number, number], zoom = 10) {
    if (!map) return;
    map.flyTo({ center, zoom, duration: 1500 });
  }

  // ─── Load Data Berdasarkan Mode ───────────────────────────────────────────────
  function loadData() {
    if (layerMode === 'centroids') {
      loadCentroids();
    } else {
      loadHeatmap();
    }
  }

  // ─── Fetch + Render Centroid Points ──────────────────────────────────────────
  async function loadCentroids() {
    if (!map || !deckOverlay) return;

    dataAbort?.abort();
    dataAbort = new AbortController();

    const bounds = map.getBounds();
    const params = {
      minLon: bounds.getWest(),
      minLat: bounds.getSouth(),
      maxLon: bounds.getEast(),
      maxLat: bounds.getNorth(),
      year: selectedYear,
      limit: 8000,
    };

    loading = true;
    errorMsg = null;

    try {
      const data = await fetchCentroids(params, dataAbort.signal);
      if (data === null) return; // request di-abort, tidak perlu update UI
      featureCount = data.meta.count;

      deckOverlay.setProps({
        layers: [
          new ScatterplotLayer({
            id: 'deforest-centroids',
            data: data.points,
            getPosition: (d: CentroidPoint) => [d[0], d[1]],
            // Radius proporsional √area — area besar = titik besar
            getRadius: (d: CentroidPoint) => Math.max(200, Math.sqrt(d[2]) * 80),
            radiusUnits: 'meters',
            radiusMinPixels: 3,
            radiusMaxPixels: 25,
            // C2: Warna berdasarkan severity area_km²
            getFillColor: (d: CentroidPoint) => centroidSeverityColor(d[2]),
            pickable: true,
            pickingRadius: 5,
            autoHighlight: true,
            highlightColor: CENTROID_HIGHLIGHT,
            updateTriggers: {
              getPosition: selectedYear,
              getFillColor: selectedYear,
            },
          }),
        ],
      });
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        errorMsg = 'Gagal memuat data centroid. Periksa backend FastAPI.';
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
      if (!heatmapCache[cacheKey]) {
        const fetched = await fetchHeatmap(selectedYear);
        if (fetched === null) return; // request di-abort
        heatmapCache[cacheKey] = fetched;
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
            pickingRadius: 5,
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

  // ─── Reaktif: Reload saat year atau mode berubah ──────────────────────────────
  $effect(() => {
    if (!map || !deckOverlay) return;
    pickedFeature = null;
    loadData();
  });

  // Reaktif: Update boundary saat selectedBoundaryHasc berubah
  $effect(() => {
    updateBoundary(selectedBoundaryHasc);
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
    <div class="absolute bottom-4 left-4 z-10
                bg-black/70 text-white text-xs px-3 py-1.5 rounded-full">
      {featureCount.toLocaleString('id-ID')}
      {layerMode === 'centroids' ? 'titik' : 'kab/kota'}
      {selectedYear != null ? `(${selectedYear})` : '(semua tahun)'}
    </div>
  {/if}

  <!-- Info Panel — Klik Feature -->
  {#if pickedFeature}
    <div class="absolute z-10 bottom-0 left-0 right-0 w-full rounded-t-xl sm:bottom-14 sm:left-4 sm:right-auto sm:w-72 sm:rounded-xl max-h-[50vh] overflow-y-auto
                bg-gray-900/95 text-white shadow-xl">
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3
                  {pickedFeature.type === 'heatmap' ? 'bg-teal-700/80' : 'bg-teal-600/80'}">
        <span class="font-semibold text-sm">
          {#if pickedFeature.type === 'centroids'}
            Titik Deforestasi
          {:else}
            Kabupaten / Kota
          {/if}
        </span>
        <button
          class="text-white/70 hover:text-white text-lg leading-none"
          onclick={() => (pickedFeature = null)}
        >×</button>
      </div>

      <!-- Properties -->
      <div class="px-4 py-3 space-y-1.5 text-sm">
        {#if pickedFeature.type === 'centroids'}
          {@const p = pickedFeature.properties as PolygonProperties}
          <div class="flex justify-between">
            <span class="text-gray-400">UUID</span>
            <span class="font-mono text-xs">{p.uuid.slice(0, 12)}…</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-400">Luas</span>
            <span class="font-semibold text-teal-300">{p.area_km2.toLocaleString('id-ID', { maximumFractionDigits: 2 })} km²</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-400">Tahun</span>
            <span>{p.year}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-400">Koordinat</span>
            <span class="font-mono text-xs">{pickedFeature.coordinates[0].toFixed(4)}, {pickedFeature.coordinates[1].toFixed(4)}</span>
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
            <span class="font-semibold text-teal-300">{p.record_count.toLocaleString('id-ID')}</span>
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

  <!-- Heatmap Legend -->
  {#if layerMode === 'heatmap'}
    <div class="absolute bottom-4 right-4 z-10
                bg-gray-900/95 backdrop-blur rounded-xl px-3 py-2.5 shadow-xl
                text-xs text-white w-36">
      <div class="font-semibold mb-2 text-gray-300">Intensitas</div>
      <div class="h-2.5 w-full rounded mb-1"
           style="background: linear-gradient(to right, #228b22, #9acd32, #ffc800, #ff6400, #c80000)">
      </div>
      <div class="flex justify-between text-gray-400">
        <span>Rendah</span>
        <span>Tinggi</span>
      </div>
    </div>
  {/if}

  <!-- C1: Centroid Legend — ukuran & warna severity -->
  {#if layerMode === 'centroids'}
    <div class="absolute bottom-4 right-4 z-10
                bg-gray-900/95 backdrop-blur rounded-xl px-3 py-3 shadow-xl
                text-xs text-white w-44">
      <div class="font-semibold mb-2.5 text-gray-300 tracking-wide uppercase text-[10px]">
        Luas Area Deforestasi
      </div>
      <div class="space-y-1.5">
        {#each CENTROID_SEVERITY_CLASSES as cls}
          <div class="flex items-center gap-2">
            <!-- Dot ukuran bervariasi sesuai kelas -->
            <span
              class="rounded-full shrink-0"
              style="
                width:  {cls.size}px;
                height: {cls.size}px;
                background-color: {cls.color};
                box-shadow: 0 0 4px {cls.color}88;
              "
            ></span>
            <div class="flex flex-col leading-tight">
              <span class="text-white font-medium">{cls.desc}</span>
              <span class="text-gray-400">{cls.label}</span>
            </div>
          </div>
        {/each}
      </div>
      <div class="mt-2.5 pt-2 border-t border-gray-700 text-gray-500 text-[10px] leading-tight">
        Ukuran titik ∝ luas area
      </div>
    </div>
  {/if}
</div>
