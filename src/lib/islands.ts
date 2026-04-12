/**
 * Pemetaan pulau/kelompok kepulauan Indonesia → daftar provinsi.
 * Province names harus match persis dengan field `provinsi` dari backend API.
 * Jika filter mengembalikan 0 hasil, cek nama provinsi di backend dan sesuaikan di sini.
 */

export interface IslandGroup {
  type: 'island';
  name: string;
  subtitle: string;
  provinces: string[]; // kosong = semua provinsi (tidak di-filter)
  center: [number, number];
  zoom: number;
}

export const ISLAND_GROUPS: IslandGroup[] = [
  {
    type: 'island',
    name: 'Semua Pulau',
    subtitle: 'Seluruh Indonesia',
    provinces: [],
    center: [118.0, -2.5],
    zoom: 5,
  },
  {
    type: 'island',
    name: 'Pulau Sumatera',
    subtitle: '10 Provinsi',
    provinces: [
      'Aceh',
      'Sumatera Utara',
      'Sumatera Barat',
      'Riau',
      'Kepulauan Riau',
      'Jambi',
      'Sumatera Selatan',
      'Kepulauan Bangka Belitung',
      'Bengkulu',
      'Lampung',
    ],
    center: [102.5, 0.5],
    zoom: 6,
  },
  {
    type: 'island',
    name: 'Pulau Jawa',
    subtitle: '6 Provinsi',
    provinces: [
      'DKI Jakarta',
      'Jawa Barat',
      'Banten',
      'Jawa Tengah',
      'DI Yogyakarta',
      'Jawa Timur',
    ],
    center: [110.5, -7.3],
    zoom: 7,
  },
  {
    type: 'island',
    name: 'Pulau Kalimantan',
    subtitle: '5 Provinsi',
    provinces: [
      'Kalimantan Barat',
      'Kalimantan Tengah',
      'Kalimantan Selatan',
      'Kalimantan Timur',
      'Kalimantan Utara',
    ],
    center: [113.5, 0.0],
    zoom: 6,
  },
  {
    type: 'island',
    name: 'Pulau Sulawesi',
    subtitle: '6 Provinsi',
    provinces: [
      'Sulawesi Utara',
      'Gorontalo',
      'Sulawesi Tengah',
      'Sulawesi Barat',
      'Sulawesi Selatan',
      'Sulawesi Tenggara',
    ],
    center: [121.0, -2.0],
    zoom: 6,
  },
  {
    type: 'island',
    name: 'Pulau Papua',
    subtitle: '6 Provinsi',
    provinces: [
      'Papua',
      'Papua Barat',
      'Papua Selatan',
      'Papua Tengah',
      'Papua Pegunungan',
      'Papua Barat Daya',
    ],
    center: [136.0, -4.5],
    zoom: 6,
  },
  {
    type: 'island',
    name: 'Bali & Nusa Tenggara',
    subtitle: '3 Provinsi',
    provinces: [
      'Bali',
      'Nusa Tenggara Barat',
      'Nusa Tenggara Timur',
    ],
    center: [117.5, -8.5],
    zoom: 7,
  },
  {
    type: 'island',
    name: 'Kepulauan Maluku',
    subtitle: '2 Provinsi',
    provinces: [
      'Maluku',
      'Maluku Utara',
    ],
    center: [128.5, -2.0],
    zoom: 6,
  },
];
