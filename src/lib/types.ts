// ─── GeoJSON Types ────────────────────────────────────────────────────────────

export interface PolygonProperties {
  uuid: string;
  area_km2: number;
  year: number;
  start_date?: string;
  end_date?: string;
}

export interface KotaHeatmapProperties {
  hasc_code: string;
  kota_name: string;
  provinsi: string;
  record_count: number;
  total_area_km2: number;
  intensity: number;       // 0.0–1.0 log-normalized
}

export interface GeoFeature<P> {
  type: 'Feature';
  geometry: object;
  properties: P;
}

export interface FeatureCollection<P> {
  type: 'FeatureCollection';
  features: GeoFeature<P>[];
  meta?: Record<string, unknown>;
}

// ─── API Response Types ───────────────────────────────────────────────────────

export interface YearCount {
  year: number;
  count: number;
}

export interface PolygonMeta {
  count: number;
  year: number | null;
  bbox: [number, number, number, number];
  tolerance: number;
  limit: number;
}

// ─── UI State Types ───────────────────────────────────────────────────────────

export type LayerMode = 'centroids' | 'heatmap';

export interface MapViewport {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface PickedFeature {
  type: LayerMode;
  properties: PolygonProperties | KotaHeatmapProperties;
  coordinates: [number, number];
}

// ─── Centroid Types ──────────────────────────────────────────────────────────
export type CentroidPoint = [number, number, number, number, string]; // [lon, lat, area_km2, year, uuid]

export interface CentroidResponse {
  points: CentroidPoint[];
  meta: { count: number; year: number | null; bbox: number[]; limit: number };
}

// ─── Search Types ────────────────────────────────────────────────────────────
export interface KotaSearchItem {
  hasc_code: string;
  kota_name: string;
  kota_type: string;
  provinsi: string;
  centroid: [number, number];
  bbox: [number, number, number, number];
}

// ─── Stats Types ─────────────────────────────────────────────────────────────
export interface StatsData {
  total_events: number;
  date_range: [string | null, string | null];
  avg_area_km2: number;
  max_area_km2: number;
  total_area_km2: number;
}
