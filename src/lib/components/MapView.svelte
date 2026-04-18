<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import maplibregl from 'maplibre-gl';
  import { Protocol } from 'pmtiles';
  import { MapboxOverlay } from '@deck.gl/mapbox';
  import { GeoJsonLayer, ScatterplotLayer } from 'deck.gl';
  import { fetchHeatmap, fetchCentroids, fetchBoundary } from '$lib/api';
  import { intensityToRgba, HEATMAP_LINE_COLOR, centroidSeverityColor, CENTROID_SEVERITY_CLASSES, HEATMAP_LEGEND_CLASSES } from '$lib/colorScale';
  import type { LayerMode, PickedFeature, KotaHeatmapProperties, CentroidPoint, PolygonProperties, KotaSearchItem } from '$lib/types';

  // ─── Props (Svelte 5 runes) ─────────────────────────────────────────────────
  let {
    selectedYear = $bindable<number | null>(null),
    layerMode    = $bindable<LayerMode>('centroids'),
    featureCount = $bindable<number>(0),
    loading      = $bindable<boolean>(false),
    selectedBoundaryHasc = null,
    topKota         = $bindable<KotaHeatmapProperties[]>([]),
    allHeatmapKota  = $bindable<KotaHeatmapProperties[]>([]),
    selectedProvinces = [] as string[],
    selectedKotaHasc = null as string | null,
    selectedKotaBbox = null as [number, number, number, number] | null,
    dataEnabled = false,
    kotaList = [] as KotaSearchItem[],
    onReset = () => {},
    isDark = false,
  }: {
    selectedYear: number | null;
    layerMode: LayerMode;
    featureCount: number;
    loading: boolean;
    selectedBoundaryHasc: string | null;
    topKota: KotaHeatmapProperties[];
    allHeatmapKota: KotaHeatmapProperties[];
    selectedProvinces: string[];
    selectedKotaHasc: string | null;
    selectedKotaBbox: [number, number, number, number] | null;
    dataEnabled: boolean;
    kotaList: KotaSearchItem[];
    onReset: () => void;
    isDark: boolean;
  } = $props();

  // ─── State ──────────────────────────────────────────────────────────────────
  let mapContainer: HTMLDivElement;
  let map: maplibregl.Map;
  let deckOverlay: InstanceType<typeof MapboxOverlay>;
  let pickedFeature = $state<PickedFeature | null>(null);
  let errorMsg = $state<string | null>(null);

  // Cache heatmap agar tidak re-fetch saat pindah viewport
  let heatmapCache: Record<string, object> = {};

  // H3: Rank map — hasc_code → peringkat nasional (1 = terparah)
  let heatmapRankMap = $state(new Map<string, number>());
  let totalKotaCount = $state(0);

  // H4/H5: State heatmap
  let hoveredKota = $state<{ x: number; y: number; kota_name: string; record_count: number; provinsi: string } | null>(null);

  // C5: Hover tooltip centroid
  let hoveredCentroid = $state<{ x: number; y: number; area: number; year: number } | null>(null);

  // C6: Admin context (point-in-polygon lookup terhadap heatmap cache)
  let centroidKotaContext = $state<{ kota_name: string; provinsi: string; kota_type?: string } | null>(null);
  let centroidKotaChecked = $state(false); // true = lookup selesai (context null = tidak ditemukan)
  let lookupSeq = 0;                        // guard race condition rapid click

  // M-05: Retry function — disimpan saat fetch gagal
  let retryFn = $state<(() => void) | null>(null);

  // AbortController untuk membatalkan fetch yang sudah tidak relevan
  let dataAbort: AbortController | null = null;

  // Debounce timer untuk moveend
  let moveDebounce: ReturnType<typeof setTimeout> | null = null;

  // B-04: Guard agar $effect basemap tidak fire saat mount pertama
  let firstStyleRun = true;

  // ─── Konstanta ──────────────────────────────────────────────────────────────
  const PMTILES_URL        = 'https://deannachristine72.github.io/indonesia-pmtiles/indonesia.pmtiles';
  const BASEMAP_STYLE_LIGHT = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
  const BASEMAP_STYLE_DARK  = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

  // Warna highlight centroid saat hover/klik
  const CENTROID_HIGHLIGHT: [number, number, number, number] = [255, 255, 255, 240];

  // ─── Setup MapLibre + deck.gl ────────────────────────────────────────────────
  onMount(async () => {
    const pmtilesProtocol = new Protocol();
    maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);

    map = new maplibregl.Map({
      container: mapContainer,
      style: isDark ? BASEMAP_STYLE_DARK : BASEMAP_STYLE_LIGHT,
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
          centroidKotaContext = null;
          centroidKotaChecked = false;
          return;
        }
        // Untuk centroid, data berupa array [lon, lat, area, year, uuid]
        if (layerMode === 'centroids' && Array.isArray(info.object) && (info.object as unknown[]).length >= 5) {
          const d = info.object as CentroidPoint;
          pickedFeature = {
            type: 'centroids',
            properties: {
              uuid: d[4],
              area_km2: d[2],
              year: d[3],
            } as PolygonProperties,
            coordinates: [d[0], d[1]],
          };
          // C6: lookup kota/provinsi — fire and forget, result updates reaktif
          centroidKotaContext = null;
          centroidKotaChecked = false;
          lookupKotaContext(d[0], d[1]);
        } else {
          centroidKotaContext = null;
          centroidKotaChecked = false;
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
        setupMapLayers();
        // Tidak langsung loadData — tunggu user pilih dari search bar
        // loadData() akan dipanggil saat dataEnabled menjadi true via $effect
      });
    });

    // Reload data saat viewport berubah (centroid mode)
    map.on('moveend', () => {
      if (!dataEnabled) return;
      if (layerMode === 'heatmap') return;
      if (moveDebounce) clearTimeout(moveDebounce);
      moveDebounce = setTimeout(() => {
        loadData();
        const b = map.getBounds();
        updateCentroidLabels([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      }, 400);
    });
  });

  onDestroy(() => {
    if (moveDebounce) clearTimeout(moveDebounce);
    dataAbort?.abort();
    map?.remove();
  });

  // ─── PMTiles Layer (batas wilayah Indonesia) ─────────────────────────────────
  function addPmtilesLayer(dark = false) {
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
        'line-color': dark ? 'rgba(200,200,200,0.45)' : 'rgba(100,100,100,0.4)',
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
        'line-color': dark ? 'rgba(180,180,180,0.3)' : 'rgba(100,100,100,0.25)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.3, 12, 1],
      },
    });
  }

  // ─── H1: Hitung centroid bbox dari geometry ───────────────────────────────────
  function getGeomCenter(geometry: { type: string; coordinates: unknown }): [number, number] {
    let sumLon = 0, sumLat = 0, count = 0;
    const processRing = (ring: number[][]) => {
      for (const pt of ring) { sumLon += pt[0]; sumLat += pt[1]; count++; }
    };
    if (geometry.type === 'Polygon') {
      processRing((geometry.coordinates as number[][][])[0]);
    } else if (geometry.type === 'MultiPolygon') {
      for (const poly of (geometry.coordinates as number[][][][])) processRing(poly[0]);
    }
    return count > 0 ? [sumLon / count, sumLat / count] : [0, 0];
  }

  // ─── Boundary Source + Layer untuk highlight kota yang dipilih ────────────────
  function addBoundarySource(dark = false) {
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

    // H1: Source titik centroid kota untuk label — diisi saat heatmap load
    map.addSource('kota-label-points', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    // H1: Symbol layer label nama kota — hanya muncul zoom ≥ 7
    map.addLayer({
      id: 'kota-labels-layer',
      type: 'symbol',
      source: 'kota-label-points',
      minzoom: 7,
      layout: {
        'text-field': ['get', 'kota_name'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 7, 11, 10, 12, 12, 14],
        'text-anchor': 'center',
        'text-max-width': 10,
        'text-letter-spacing': 0.02,
      },
      paint: {
        'text-color': dark ? '#e2e8f0' : '#1e293b',
        'text-halo-color': dark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.95)',
        'text-halo-width': 2,
      },
    });
  }

  // ─── B-04: Setup semua custom layers (dipanggil saat load + saat style ganti) ──
  function setupMapLayers() {
    addPmtilesLayer(isDark);
    addBoundarySource(isDark);
  }

  // ─── Update Boundary saat kota dipilih ───────────────────────────────────────
  async function updateBoundary(hascCode: string | null) {
    if (!map || !map.getSource('selected-boundary')) return;

    if (!hascCode) {
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
      errorMsg = 'Batas wilayah tidak dapat dimuat — coba geser peta lalu pilih ulang.';
    }
  }

  // ─── Update Boundary untuk pulau (gabungan polygon per provinsi) ─────────────
  async function updateIslandBoundary(provinces: string[]) {
    if (!map || !map.getSource('selected-boundary')) return;

    // Clear dulu
    (map.getSource('selected-boundary') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection', features: [],
    });

    if (provinces.length === 0) return;

    try {
      // Gunakan heatmap cache — polygon geometry tiap kab/kota sudah ada di sini
      const cacheKey = selectedYear != null ? String(selectedYear) : 'all';
      if (!heatmapCache[cacheKey]) {
        const fetched = await fetchHeatmap(selectedYear);
        if (fetched === null) return;
        heatmapCache[cacheKey] = fetched;
      }
      const data = heatmapCache[cacheKey] as {
        features: Array<{ type?: string; geometry: object; properties: KotaHeatmapProperties }>;
      };

      const filteredFeatures = data.features
        .filter(f => provinces.includes(f.properties.provinsi) && f.geometry)
        .map(f => ({ type: 'Feature' as const, geometry: f.geometry, properties: f.properties }));

      (map.getSource('selected-boundary') as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: filteredFeatures,
      });
    } catch (err) {
      console.error('Gagal memuat boundary pulau:', err);
      errorMsg = 'Batas wilayah pulau tidak dapat dimuat.';
    }
  }

  // ─── Expose flyTo untuk dipanggil dari parent ────────────────────────────────
  export function flyTo(center: [number, number], zoom = 10) {
    if (!map) return;
    map.flyTo({ center, zoom, duration: 1500 });
  }

  // ─── M-09: Zoom to Fit — fit peta ke batas feature yang sedang dipilih ───────
  function zoomToPickedFeature() {
    if (!map || !pickedFeature) return;
    if (pickedFeature.type === 'heatmap') {
      const p = pickedFeature.properties as KotaHeatmapProperties;
      const kota = kotaList.find(k => k.hasc_code === p.hasc_code);
      if (kota) {
        map.fitBounds(kota.bbox as maplibregl.LngLatBoundsLike, { padding: 60, duration: 800 });
      } else {
        map.flyTo({ center: pickedFeature.coordinates, zoom: 10, duration: 800 });
      }
    } else {
      map.flyTo({ center: pickedFeature.coordinates, zoom: 13, duration: 800 });
    }
  }

  // ─── M-11: Clamp tooltip position agar tidak keluar layar ────────────────────
  function clampTooltipStyle(x: number, y: number, w = 185, h = 74): string {
    const mw = mapContainer?.clientWidth  ?? 9999;
    const mh = mapContainer?.clientHeight ?? 9999;
    const left = Math.min(Math.max(4, x + 14), mw - w - 4);
    const top  = Math.min(Math.max(4, y - h),  mh - h - 4);
    return `left: ${left}px; top: ${top}px;`;
  }

  // ─── Load Data Berdasarkan Mode (digunakan oleh moveend) ─────────────────────
  function loadData() {
    if (layerMode === 'centroids') {
      loadCentroids(); // moveend: selalu gunakan viewport saat ini
    } else {
      loadHeatmap();
    }
  }

  // ─── Populate label kota untuk centroid mode ─────────────────────────────────
  function updateCentroidLabels(bbox: [number, number, number, number]) {
    if (!map || !map.getSource('kota-label-points')) return;

    let labelKota: KotaSearchItem[];
    if (selectedKotaHasc) {
      // Kota spesifik dipilih → hanya tampilkan 1 nama
      labelKota = kotaList.filter(k => k.hasc_code === selectedKotaHasc);
    } else if (selectedProvinces.length > 0) {
      // Filter provinsi aktif → tampilkan semua kota di provinsi tersebut
      labelKota = kotaList.filter(k => selectedProvinces.includes(k.provinsi));
    } else {
      // Viewport-based → tampilkan kota yang centroid-nya ada di viewport
      labelKota = kotaList.filter(k =>
        k.centroid[0] >= bbox[0] && k.centroid[0] <= bbox[2] &&
        k.centroid[1] >= bbox[1] && k.centroid[1] <= bbox[3]
      );
    }

    (map.getSource('kota-label-points') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: labelKota.map(k => ({
        type: 'Feature' as const,
        geometry: { type: 'Point', coordinates: k.centroid },
        properties: { kota_name: k.kota_name },
      })),
    });
  }

  // ─── Fetch + Render Centroid Points ──────────────────────────────────────────
  async function loadCentroids(bboxOverride?: [number, number, number, number]) {
    if (!map || !deckOverlay) return;

    hoveredKota = null;    // H5: clear heatmap hover tooltip
    topKota = [];          // H4: clear top kota list
    allHeatmapKota = [];   // H8: clear export data

    dataAbort?.abort();
    dataAbort = new AbortController();

    // Gunakan bboxOverride (kota dipilih) atau viewport saat ini
    const bounds = map.getBounds();
    const activeBbox: [number, number, number, number] = bboxOverride ?? [
      bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
    ];
    const params = {
      minLon: activeBbox[0],
      minLat: activeBbox[1],
      maxLon: activeBbox[2],
      maxLat: activeBbox[3],
      year: selectedYear,
      limit: 8000,
    };

    loading = true;
    errorMsg = null;
    retryFn = null;

    try {
      const data = await fetchCentroids(params, dataAbort.signal);
      if (data === null) return; // request di-abort, tidak perlu update UI
      featureCount = data.meta.count;

      // Populate label kota untuk centroid mode
      updateCentroidLabels(activeBbox);

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
            // C5: Tooltip hover — tampilkan mini-info tanpa klik
            onHover: (info: { picked: boolean; object: unknown; x: number; y: number }) => {
              if (info.picked && Array.isArray(info.object) && (info.object as unknown[]).length >= 5) {
                const d = info.object as CentroidPoint;
                hoveredCentroid = { x: info.x, y: info.y, area: d[2], year: d[3] };
              } else {
                hoveredCentroid = null;
              }
            },
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
        const capturedBbox = activeBbox;
        errorMsg = 'Gagal memuat data titik deforestasi.';
        retryFn  = () => loadCentroids(capturedBbox);
        console.error(err);
      }
    } finally {
      loading = false;
    }
  }

  // ─── Fetch + Render Heatmap Kota ─────────────────────────────────────────────
  async function loadHeatmap() {
    if (!map || !deckOverlay) return;

    // C5/H5: bersihkan tooltip saat reload
    hoveredCentroid = null;
    hoveredKota = null;

    // H9: Baca filter secara sinkron sebelum await agar $effect tracking bekerja
    const filterKotaHasc = selectedKotaHasc;
    const filterProvinces = selectedProvinces;

    const cacheKey = selectedYear != null ? String(selectedYear) : 'all';

    loading = true;
    errorMsg = null;
    retryFn = null;

    try {
      if (!heatmapCache[cacheKey]) {
        const fetched = await fetchHeatmap(selectedYear);
        if (fetched === null) return; // request di-abort
        heatmapCache[cacheKey] = fetched;
      }
      const data = heatmapCache[cacheKey] as {
        features: Array<{ geometry: { type: string; coordinates: unknown }; properties: KotaHeatmapProperties }>;
      };

      // Filter: kota spesifik → provinsi → semua
      const displayFeatures = filterKotaHasc
        ? data.features.filter(f => f.properties.hasc_code === filterKotaHasc)
        : filterProvinces.length > 0
          ? data.features.filter(f => filterProvinces.includes(f.properties.provinsi))
          : data.features;

      featureCount = displayFeatures.length;

      // H3: Build rank map (dari semua data, bukan filtered, agar peringkat nasional tetap akurat)
      const sorted = [...data.features].sort(
        (a, b) => b.properties.record_count - a.properties.record_count
      );
      heatmapRankMap = new Map(sorted.map((f, i) => [f.properties.hasc_code, i + 1]));
      totalKotaCount = data.features.length;

      // H4: Top 10 kota terparah (dari displayFeatures)
      const displaySorted = [...displayFeatures].sort(
        (a, b) => b.properties.record_count - a.properties.record_count
      );
      topKota = displaySorted.slice(0, 10).map(f => f.properties);
      // H8: Semua data kota untuk export CSV (hanya yang tampil)
      allHeatmapKota = displaySorted.map(f => f.properties);

      // H1: Update label points source — centroid tiap kota untuk zoom ≥ 7
      if (map.getSource('kota-label-points')) {
        const labelFeatures = displayFeatures
          .filter(f => f.geometry)
          .map(f => ({
            type: 'Feature' as const,
            geometry: { type: 'Point', coordinates: getGeomCenter(f.geometry) },
            properties: { kota_name: f.properties.kota_name },
          }));
        (map.getSource('kota-label-points') as maplibregl.GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: labelFeatures,
        });
      }

      deckOverlay.setProps({
        layers: [
          new GeoJsonLayer({
            id: 'kota-heatmap',
            // H1: render di bawah label layer agar label tetap terbaca
            beforeId: 'kota-labels-layer',
            data: { type: 'FeatureCollection' as const, features: displayFeatures },
            getFillColor: (f: { properties: KotaHeatmapProperties }) => intensityToRgba(f.properties.intensity, 200),
            // H5: Tooltip hover kota — mini summary tanpa klik
            onHover: (info: { picked: boolean; object?: { properties: KotaHeatmapProperties }; x: number; y: number }) => {
              if (info.picked && info.object?.properties) {
                const p = info.object.properties;
                hoveredKota = { x: info.x, y: info.y, kota_name: p.kota_name, record_count: p.record_count, provinsi: p.provinsi };
              } else {
                hoveredKota = null;
              }
            },
            getLineColor: HEATMAP_LINE_COLOR,
            lineWidthMinPixels: 0.3,
            pickable: true,
            pickingRadius: 5,
            autoHighlight: true,
            highlightColor: [255, 255, 255, 60],
            updateTriggers: {
              getFillColor: [selectedYear, filterKotaHasc, filterProvinces],
            },
            // H10: Animasi transisi warna saat tahun berubah
            transitions: {
              getFillColor: { duration: 500 },
            },
          }),
        ],
      });
    } catch (err: unknown) {
      errorMsg = 'Gagal memuat data peta panas.';
      retryFn  = () => loadHeatmap();
      console.error(err);
    } finally {
      loading = false;
    }
  }

  // ─── C6: Point-in-Polygon (even-odd rule, semua rings termasuk hole) ─────────
  function pointInPolygon(point: [number, number], rings: number[][][]): boolean {
    const [x, y] = point;
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
    }
    return inside;
  }

  async function lookupKotaContext(lon: number, lat: number) {
    const seq = ++lookupSeq;
    centroidKotaContext = null;
    centroidKotaChecked = false;

    // Gunakan cache 'all' — geometri kota tidak berubah per tahun
    if (!heatmapCache['all']) {
      try {
        const data = await fetchHeatmap(null);
        if (data) heatmapCache['all'] = data;
        else { if (seq === lookupSeq) centroidKotaChecked = true; return; }
      } catch {
        if (seq === lookupSeq) centroidKotaChecked = true;
        return;
      }
    }

    if (seq !== lookupSeq) return; // request lebih baru sudah berjalan

    const cached = heatmapCache['all'] as {
      features: Array<{ geometry: { type: string; coordinates: unknown }; properties: KotaHeatmapProperties }>;
    };
    if (!cached?.features) { centroidKotaChecked = true; return; }

    const pt: [number, number] = [lon, lat];
    for (const feature of cached.features) {
      const geom = feature.geometry;
      if (!geom) continue;
      let found = false;
      if (geom.type === 'Polygon') {
        found = pointInPolygon(pt, geom.coordinates as number[][][]);
      } else if (geom.type === 'MultiPolygon') {
        for (const poly of (geom.coordinates as number[][][][])) {
          if (pointInPolygon(pt, poly)) { found = true; break; }
        }
      }
      if (found) {
        if (seq === lookupSeq) {
          // M-02: tambah kota_type dari kotaList via hasc_code
          const kotaItem = kotaList.find(k => k.hasc_code === feature.properties.hasc_code);
          centroidKotaContext = {
            kota_name: feature.properties.kota_name,
            provinsi:  feature.properties.provinsi,
            kota_type: kotaItem?.kota_type,
          };
          centroidKotaChecked = true;
        }
        return;
      }
    }
    if (seq === lookupSeq) centroidKotaChecked = true; // tidak ditemukan
  }

  // ─── Reaktif: Reload saat year, mode, filter, atau dataEnabled berubah ───────
  $effect(() => {
    if (!map || !deckOverlay) return;
    if (!dataEnabled) {
      // Clear semua layer dan state saat data di-nonaktifkan
      deckOverlay.setProps({ layers: [] });
      featureCount = 0;
      topKota = [];
      allHeatmapKota = [];
      hoveredKota = null;
      hoveredCentroid = null;
      pickedFeature = null;
      return;
    }
    pickedFeature = null;
    if (layerMode === 'centroids') {
      // Gunakan selectedKotaBbox untuk load awal kota spesifik
      loadCentroids(selectedKotaBbox ?? undefined);
    } else {
      loadHeatmap();
    }
  });

  // Reaktif: Update boundary — kota (hasc) atau pulau (provinsi)
  $effect(() => {
    const hasc = selectedBoundaryHasc;
    const provinces = selectedProvinces;
    if (hasc) {
      updateBoundary(hasc);
    } else if (provinces.length > 0) {
      updateIslandBoundary(provinces);
    } else {
      updateBoundary(null); // clear
    }
  });

  // B-04: Reaktif — ganti basemap style saat dark mode toggle
  $effect(() => {
    const dark = isDark; // track reaktif
    if (!map || firstStyleRun) { firstStyleRun = false; return; }
    map.setStyle(dark ? BASEMAP_STYLE_DARK : BASEMAP_STYLE_LIGHT);
    map.once('style.load', () => {
      setupMapLayers();
      // Re-apply boundary setelah style reload
      if (selectedBoundaryHasc) updateBoundary(selectedBoundaryHasc);
      else if (selectedProvinces.length > 0) updateIslandBoundary(selectedProvinces);
    });
  });
</script>

<!-- ─── Template ──────────────────────────────────────────────────────────── -->
<div class="relative w-full h-full">
  <!-- Map Container (M-13: aria-label for screen readers) -->
  <div bind:this={mapContainer} class="w-full h-full"
       role="application" aria-label="Peta Kejadian Deforestasi Indonesia"></div>

  <!-- B-01: Placeholder — light/dark adaptive -->
  {#if !dataEnabled && !loading}
    <div class="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      <div class="bg-white/90 dark:bg-black/60 backdrop-blur-sm
                  text-gray-800 dark:text-white
                  border border-gray-200/60 dark:border-transparent
                  px-6 py-4 rounded-2xl
                  flex flex-col items-center gap-2 text-center max-w-xs shadow-2xl">
        <span class="text-3xl">🏝</span>
        <p class="text-sm font-semibold">Pilih pulau untuk melihat data</p>
        <p class="text-xs text-gray-500 dark:text-gray-400">Gunakan search bar di atas untuk memulai</p>
      </div>
    </div>
  {/if}

  <!-- B-02: Loading Spinner — light/dark adaptive + aria-live for screen readers -->
  {#if loading}
    <div role="status" aria-live="polite"
         class="absolute top-4 left-1/2 -translate-x-1/2 z-10
                bg-white/95 dark:bg-black/70
                text-gray-700 dark:text-white
                border border-gray-200 dark:border-transparent
                text-sm px-4 py-2 rounded-full shadow-md dark:shadow-none
                flex items-center gap-2 pointer-events-none backdrop-blur-sm">
      <span class="inline-block w-3 h-3 border-2
                   border-gray-500 dark:border-white border-t-transparent
                   rounded-full animate-spin"></span>
      Memuat data...
    </div>
  {/if}

  <!-- B-03 + M-05: Error Message — light/dark adaptive, retry + dismiss -->
  {#if errorMsg}
    <div role="alert" aria-live="assertive"
         class="absolute top-4 left-1/2 -translate-x-1/2 z-10
                bg-red-50 dark:bg-red-900/90
                text-red-700 dark:text-white
                border border-red-200 dark:border-transparent
                text-sm px-4 py-2 rounded-lg max-w-xs text-center shadow-md">
      <div class="flex items-center gap-2">
        <span class="flex-1 text-left">{errorMsg}</span>
        <button
          onclick={() => { errorMsg = null; retryFn = null; }}
          aria-label="Tutup pesan error"
          class="text-red-400 dark:text-red-300 hover:text-red-600 dark:hover:text-white
                 transition-colors leading-none text-base flex-shrink-0"
        >✕</button>
      </div>
      {#if retryFn}
        <button
          onclick={() => { retryFn?.(); retryFn = null; errorMsg = null; }}
          class="mt-1.5 text-xs font-medium underline underline-offset-2
                 text-red-600 dark:text-red-300 hover:no-underline transition-colors"
        >↻ Coba lagi</button>
      {/if}
    </div>
  {/if}

  <!-- Feature Count Badge -->
  {#if !loading && featureCount > 0}
    <div class="absolute bottom-4 left-4 z-10
                bg-white/90 dark:bg-black/70
                text-gray-800 dark:text-white
                border border-gray-200/60 dark:border-transparent
                text-xs px-3 py-1.5 rounded-full shadow-sm dark:shadow-none backdrop-blur-sm">
      {featureCount.toLocaleString('id-ID')}
      {layerMode === 'centroids' ? 'titik' : 'kab/kota'}
      {selectedYear != null ? `(${selectedYear})` : '(semua tahun)'}
    </div>
  {/if}

  <!-- H5: Tooltip hover kota heatmap — mini summary tanpa klik (M-11: clamped) -->
  {#if hoveredKota && layerMode === 'heatmap' && !pickedFeature}
    <div class="absolute z-20 pointer-events-none
                bg-white/98 dark:bg-gray-900/95
                border border-gray-200 dark:border-gray-700
                text-gray-900 dark:text-white
                text-xs px-2.5 py-1.5 rounded-lg shadow-xl"
         style={clampTooltipStyle(hoveredKota.x, hoveredKota.y, 185, 68)}>
      <div class="font-semibold text-teal-600 dark:text-teal-300">{hoveredKota.kota_name}</div>
      <div class="text-gray-500 dark:text-gray-400 text-[10px]">{hoveredKota.provinsi}</div>
      <div class="text-orange-500 dark:text-orange-300 font-medium mt-0.5">{hoveredKota.record_count.toLocaleString('id-ID')} event</div>
    </div>
  {/if}

  <!-- C5: Tooltip hover centroid — mini info tanpa klik (M-11: clamped) -->
  {#if hoveredCentroid && layerMode === 'centroids' && !pickedFeature}
    <div class="absolute z-20 pointer-events-none
                bg-white/98 dark:bg-gray-900/95
                border border-gray-200 dark:border-gray-700
                text-gray-900 dark:text-white
                text-xs px-2.5 py-1.5 rounded-lg shadow-xl"
         style={clampTooltipStyle(hoveredCentroid.x, hoveredCentroid.y, 150, 50)}>
      <div class="font-semibold text-teal-600 dark:text-teal-300">
        {hoveredCentroid.area.toLocaleString('id-ID', { maximumFractionDigits: 2 })} km²
      </div>
      <div class="text-gray-500 dark:text-gray-400">{hoveredCentroid.year}</div>
    </div>
  {/if}

  <!-- Info Panel — Klik Feature (M-04: fly transition, M-10: bottom offset) -->
  {#if pickedFeature}
    <div
      transition:fly={{ y: 24, duration: 220, opacity: 0 }}
      class="absolute z-10
             bottom-0 left-0 right-0 w-full rounded-t-xl
             sm:bottom-44 sm:left-4 sm:right-auto sm:w-72 sm:rounded-xl
             max-h-[50vh] overflow-y-auto
             bg-white dark:bg-gray-900/95
             text-gray-900 dark:text-white
             border border-gray-200 dark:border-transparent
             shadow-xl"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3
                  {pickedFeature.type === 'heatmap' ? 'bg-teal-700/80' : 'bg-teal-600/80'}">
        <span class="font-semibold text-sm text-white">
          {#if pickedFeature.type === 'centroids'}
            Titik Deforestasi
          {:else}
            Kabupaten / Kota
          {/if}
        </span>
        <!-- M-09: Zoom to fit + M-12: aria-label on close -->
        <div class="flex items-center gap-1">
          <button
            onclick={zoomToPickedFeature}
            aria-label="Zoom ke lokasi ini"
            title="Zoom ke lokasi"
            class="text-white/70 hover:text-white transition-colors p-0.5 rounded"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              <line x1="11" y1="8" x2="11" y2="14"/>
              <line x1="8" y1="11" x2="14" y2="11"/>
            </svg>
          </button>
          <button
            onclick={() => (pickedFeature = null)}
            aria-label="Tutup panel detail"
            class="text-white/70 hover:text-white text-lg leading-none transition-colors px-0.5"
          >×</button>
        </div>
      </div>

      <!-- Properties -->
      <div class="px-4 py-3 space-y-1.5 text-sm">
        {#if pickedFeature.type === 'centroids'}
          {@const p = pickedFeature.properties as PolygonProperties}
          <!-- C6: Konteks administratif dari point-in-polygon lookup -->
          {#if centroidKotaContext}
            <div class="flex justify-between">
              <span class="text-gray-500 dark:text-gray-400">Provinsi</span>
              <span class="text-right max-w-[60%] leading-tight">{centroidKotaContext.provinsi}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500 dark:text-gray-400">Kota/Kab</span>
              <span class="font-semibold text-teal-600 dark:text-teal-300 text-right max-w-[60%] leading-tight">{centroidKotaContext.kota_name}</span>
            </div>
            {#if centroidKotaContext.kota_type}
              <div class="flex justify-between">
                <span class="text-gray-500 dark:text-gray-400">Tipe</span>
                <span class="text-xs text-gray-600 dark:text-gray-300">{centroidKotaContext.kota_type}</span>
              </div>
            {/if}
          {:else if !centroidKotaChecked}
            <div class="text-gray-400 dark:text-gray-500 text-xs italic">Mencari lokasi…</div>
          {:else}
            <div class="flex justify-between">
              <span class="text-gray-500 dark:text-gray-400">Wilayah</span>
              <span class="text-gray-400 dark:text-gray-500">—</span>
            </div>
          {/if}
          <div class="flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">UUID</span>
            <span class="font-mono text-xs">{p.uuid.slice(0, 12)}…</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">Luas</span>
            <span class="font-semibold text-teal-600 dark:text-teal-300">{p.area_km2.toLocaleString('id-ID', { maximumFractionDigits: 2 })} km²</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">Tahun</span>
            <span>{p.year}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">Koordinat</span>
            <span class="font-mono text-xs">{pickedFeature.coordinates[0].toFixed(4)}, {pickedFeature.coordinates[1].toFixed(4)}</span>
          </div>
        {:else}
          {@const p = pickedFeature.properties as KotaHeatmapProperties}
          <div class="flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">Provinsi</span>
            <span>{p.provinsi}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">Kota/Kab</span>
            <span class="font-semibold">{p.kota_name}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">Jumlah Event</span>
            <span class="font-semibold text-teal-600 dark:text-teal-300">{p.record_count.toLocaleString('id-ID')}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">Total Luas</span>
            <span>{(p.total_area_km2 / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} ribu km²</span>
          </div>
          <!-- Intensity bar -->
          <div class="mt-2">
            <div class="text-gray-500 dark:text-gray-400 text-xs mb-1">Intensitas Deforestasi</div>
            <div class="w-full h-2 rounded bg-gray-200 dark:bg-gray-700">
              <div
                class="h-2 rounded"
                style="width:{(p.intensity * 100).toFixed(1)}%; background: rgb({Math.round(255 * p.intensity)},{Math.round(120 * (1 - p.intensity))},30)"
              ></div>
            </div>
            <div class="text-right text-xs text-gray-500 dark:text-gray-400 mt-0.5">{(p.intensity * 100).toFixed(1)}%</div>
          </div>

          <!-- H3: Peringkat Nasional -->
          {#if heatmapRankMap.has(p.hasc_code) && totalKotaCount > 0}
            {@const rank = heatmapRankMap.get(p.hasc_code)!}
            {@const pct = Math.max(1, Math.ceil((rank / totalKotaCount) * 100))}
            <div class="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
              <div class="flex items-center justify-between">
                <span class="text-gray-500 dark:text-gray-400 text-xs">Peringkat Nasional</span>
                <span class="font-bold text-orange-500 dark:text-orange-400 text-sm">
                  #{rank}
                  <span class="text-gray-500 dark:text-gray-400 font-normal text-xs">/ {totalKotaCount}</span>
                </span>
              </div>
              <div class="text-[10px] text-gray-400 dark:text-gray-500 text-right mt-0.5">
                {#if pct <= 10}
                  Top {pct}% deforestasi tertinggi
                {:else}
                  Persentil ke-{pct} nasional
                {/if}
              </div>
            </div>
          {/if}

        {/if}
      </div>
    </div>
  {/if}

  <!-- H2: Heatmap Legend — 4 kelas dengan nilai aktual record_count -->
  {#if layerMode === 'heatmap'}
    <div class="absolute bottom-4 right-4 z-10
                bg-white/95 dark:bg-gray-900/95
                backdrop-blur rounded-xl px-3 py-3 shadow-xl
                border border-gray-200/80 dark:border-transparent
                text-xs text-gray-900 dark:text-white w-44">
      <div class="font-semibold mb-2.5 text-gray-500 dark:text-gray-300 tracking-wide uppercase text-[10px]">
        Intensitas Deforestasi
      </div>
      <div class="space-y-1.5">
        {#each HEATMAP_LEGEND_CLASSES as cls}
          <div class="flex items-center gap-2">
            <span
              class="w-3 h-3 rounded-sm shrink-0"
              style="background-color: {cls.color}; box-shadow: 0 0 4px {cls.color}88;"
            ></span>
            <div class="flex flex-col leading-tight">
              <span class="text-gray-800 dark:text-white font-medium">{cls.desc}</span>
              <span class="text-gray-500 dark:text-gray-400">{cls.label}</span>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- C1: Centroid Legend — ukuran & warna severity -->
  {#if layerMode === 'centroids'}
    <div class="absolute bottom-4 right-4 z-10
                bg-white/95 dark:bg-gray-900/95
                backdrop-blur rounded-xl px-3 py-3 shadow-xl
                border border-gray-200/80 dark:border-transparent
                text-xs text-gray-900 dark:text-white w-44">
      <div class="font-semibold mb-2.5 text-gray-500 dark:text-gray-300 tracking-wide uppercase text-[10px]">
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
              <span class="text-gray-800 dark:text-white font-medium">{cls.desc}</span>
              <span class="text-gray-500 dark:text-gray-400">{cls.label}</span>
            </div>
          </div>
        {/each}
      </div>
      <div class="mt-2.5 pt-2 border-t border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 text-[10px] leading-tight">
        Ukuran titik ∝ luas area
      </div>
    </div>
  {/if}
</div>
