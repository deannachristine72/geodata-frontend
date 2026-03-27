<script lang="ts">
  import type { YearCount } from '$lib/types';

  let {
    years       = [],
    selectedYear = $bindable<number | null>(null),
  }: {
    years: YearCount[];
    selectedYear: number | null;
  } = $props();

  // Range tahun dari data
  const minYear = $derived(years.length ? years[0].year : 2000);
  const maxYear = $derived(years.length ? years[years.length - 1].year : 2026);

  // Nilai slider — null berarti "semua tahun"
  let sliderValue = $state<number>(maxYear);
  // Sinkronkan initial state dengan selectedYear dari parent
  let showAll = $state(selectedYear === null);

  function onSliderInput(e: Event) {
    sliderValue = Number((e.target as HTMLInputElement).value);
    if (!showAll) selectedYear = sliderValue;
  }

  function toggleShowAll() {
    showAll = !showAll;
    selectedYear = showAll ? null : sliderValue;
  }

  // Hitung count untuk tahun yang dipilih
  const currentCount = $derived(
    showAll
      ? years.reduce((s, y) => s + y.count, 0)
      : (years.find(y => y.year === sliderValue)?.count ?? 0)
  );
</script>

<div class="bg-gray-900/95 backdrop-blur rounded-xl px-4 py-3 shadow-xl w-80 text-white">
  <!-- Header -->
  <div class="flex items-center justify-between mb-2">
    <span class="text-sm font-semibold text-gray-200">Filter Tahun</span>
    <button
      class="text-xs px-2 py-0.5 rounded-full border transition-colors
             {showAll
               ? 'bg-orange-600 border-orange-500 text-white'
               : 'border-gray-600 text-gray-400 hover:border-orange-500 hover:text-orange-400'}"
      onclick={toggleShowAll}
    >
      Semua Tahun
    </button>
  </div>

  <!-- Slider -->
  <input
    type="range"
    min={minYear}
    max={maxYear}
    step="1"
    value={sliderValue}
    oninput={onSliderInput}
    disabled={showAll}
    class="w-full h-1.5 rounded appearance-none cursor-pointer
           bg-gray-700 accent-orange-500
           disabled:opacity-40 disabled:cursor-not-allowed"
  />

  <!-- Label bawah slider -->
  <div class="flex justify-between items-center mt-1.5">
    <span class="text-xs text-gray-500">{minYear}</span>
    <div class="text-center">
      {#if showAll}
        <span class="text-xs font-semibold text-orange-400">Semua Tahun</span>
      {:else}
        <span class="text-lg font-bold text-orange-400 leading-none">{sliderValue}</span>
      {/if}
      <div class="text-xs text-gray-400">
        {currentCount.toLocaleString('id-ID')} events
      </div>
    </div>
    <span class="text-xs text-gray-500">{maxYear}</span>
  </div>

  <!-- Histogram mini — visualisasi distribusi per tahun -->
  {#if years.length > 0}
    {@const maxCount = Math.max(...years.map(y => y.count))}
    <div class="flex items-end gap-px mt-2 h-8">
      {#each years as y}
        <div
          class="flex-1 rounded-sm transition-all duration-150 cursor-pointer"
          style="height:{Math.max(2, (y.count / maxCount) * 100)}%;
                 background:{(!showAll && y.year === sliderValue)
                   ? '#f97316'
                   : (showAll ? '#f9731640' : '#ffffff20')}"
          title="{y.year}: {y.count.toLocaleString()} events"
          onclick={() => { showAll = false; sliderValue = y.year; selectedYear = y.year; }}
          role="button"
          tabindex="0"
          onkeypress={(e) => { if (e.key === 'Enter') { showAll = false; sliderValue = y.year; selectedYear = y.year; } }}
        ></div>
      {/each}
    </div>
    <div class="flex justify-between text-xs text-gray-600 mt-0.5">
      <span>2000</span><span>2013</span><span>2026</span>
    </div>
  {/if}
</div>
