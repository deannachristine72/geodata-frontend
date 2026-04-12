<script lang="ts">
  import type { KotaSearchItem } from '$lib/types';
  import { ISLAND_GROUPS, type IslandGroup } from '$lib/islands';

  let {
    kotaList = [],
    onSelect,
  }: {
    kotaList: KotaSearchItem[];
    onSelect: (result: KotaSearchItem | IslandGroup | null) => void;
  } = $props();

  let query = $state('');
  let isFocused = $state(false);
  let selectedIndex = $state(-1);

  // Island entries yang cocok dengan query (atau semua jika query kosong)
  const filteredIslands = $derived(
    query.length === 0
      ? ISLAND_GROUPS
      : ISLAND_GROUPS.filter(g =>
          g.name.toLowerCase().includes(query.toLowerCase()) ||
          g.subtitle.toLowerCase().includes(query.toLowerCase())
        )
  );

  // Kota entries — hanya muncul saat ada query
  const filteredKota = $derived(
    query.length < 1
      ? []
      : kotaList
          .filter(k =>
            k.kota_name.toLowerCase().includes(query.toLowerCase()) ||
            k.provinsi.toLowerCase().includes(query.toLowerCase())
          )
          .slice(0, 6)
  );

  const showDropdown = $derived(
    isFocused && (filteredIslands.length > 0 || filteredKota.length > 0)
  );

  // Gabungan untuk navigasi keyboard: islands dulu, lalu kota
  const allResults = $derived([...filteredIslands, ...filteredKota]);

  function handleSelectIsland(island: IslandGroup) {
    query = island.name;
    isFocused = false;
    selectedIndex = -1;
    onSelect(island);
  }

  function handleSelectKota(kota: KotaSearchItem) {
    query = `${kota.kota_name}, ${kota.provinsi}`;
    isFocused = false;
    selectedIndex = -1;
    onSelect(kota);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, allResults.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, -1);
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      const result = allResults[selectedIndex];
      if ('type' in result && result.type === 'island') {
        handleSelectIsland(result as IslandGroup);
      } else {
        handleSelectKota(result as KotaSearchItem);
      }
    } else if (e.key === 'Escape') {
      isFocused = false;
    }
  }

  function handleClear() {
    query = '';
    isFocused = false;
    selectedIndex = -1;
    onSelect(null);
  }
</script>

<div class="relative">
  <!-- Input -->
  <div class="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
    <svg class="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
    </svg>
    <input
      type="text"
      bind:value={query}
      onfocus={() => (isFocused = true)}
      onkeydown={handleKeydown}
      placeholder="Pilih pulau atau cari kota..."
      class="bg-transparent text-white text-sm w-full outline-none placeholder-gray-500"
    />
    {#if query.length > 0}
      <button onclick={handleClear} class="text-gray-400 hover:text-white text-sm">
        ✕
      </button>
    {/if}
  </div>

  <!-- Dropdown -->
  {#if showDropdown}
    <div class="absolute top-full left-0 right-0 mt-1 bg-gray-800 rounded-lg shadow-xl
                border border-gray-700 overflow-hidden z-50 max-h-72 overflow-y-auto">

      <!-- Island Group -->
      {#if filteredIslands.length > 0}
        <div class="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider
                    border-b border-gray-700/60">
          Pilih Wilayah
        </div>
        {#each filteredIslands as island, i}
          {@const idx = i}
          <button
            class="w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2
                   {idx === selectedIndex ? 'bg-teal-700/40 text-white' : 'text-gray-300 hover:bg-gray-700'}"
            onmousedown={() => handleSelectIsland(island)}
          >
            <span class="text-base leading-none">
              {island.name === 'Semua Pulau' ? '🌏' : '🏝'}
            </span>
            <div>
              <div class="font-medium text-sm">{island.name}</div>
              <div class="text-[10px] text-gray-400">{island.subtitle}</div>
            </div>
          </button>
        {/each}
      {/if}

      <!-- Kota results (only when typing) -->
      {#if filteredKota.length > 0}
        <div class="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider
                    border-b border-gray-700/60 {filteredIslands.length > 0 ? 'border-t border-gray-700/60' : ''}">
          Kabupaten / Kota
        </div>
        {#each filteredKota as kota, i}
          {@const idx = filteredIslands.length + i}
          <button
            class="w-full text-left px-3 py-2 text-sm transition-colors
                   {idx === selectedIndex ? 'bg-orange-600/30 text-white' : 'text-gray-300 hover:bg-gray-700'}"
            onmousedown={() => handleSelectKota(kota)}
          >
            <div class="font-medium">{kota.kota_name}</div>
            <div class="text-xs text-gray-400">{kota.kota_type} — {kota.provinsi}</div>
          </button>
        {/each}
      {/if}

    </div>
  {/if}

  {#if isFocused && query.length >= 1 && filteredIslands.length === 0 && filteredKota.length === 0}
    <div class="absolute top-full left-0 right-0 mt-1 bg-gray-800 rounded-lg shadow-xl
                border border-gray-700 px-3 py-3 text-sm text-gray-400 z-50">
      Tidak ditemukan "{query}"
    </div>
  {/if}
</div>
