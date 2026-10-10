(() => {
  const rows = [...document.querySelectorAll('[data-score-row]')];
  if (!rows.length) return;
  function recalculate() {
    const scores = { rn: { sum: 0, weight: 0 }, lfi: { sum: 0, weight: 0 } };
    rows.forEach(row => {
      const slider = row.querySelector('[data-weight]');
      const weight = Number(slider.value);
      row.querySelector('output').value = String(weight);
      for (const party of ['rn', 'lfi']) {
        const note = Number(row.dataset[party]);
        if (row.dataset[party] !== '' && Number.isFinite(note)) {
          scores[party].sum += note * weight;
          scores[party].weight += weight;
        }
      }
    });
    for (const party of ['rn', 'lfi']) {
      document.getElementById(`score-${party}`).textContent = scores[party].weight ? (scores[party].sum / scores[party].weight).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) : '—';
    }
  }
  rows.forEach(row => row.querySelector('[data-weight]').addEventListener('input', recalculate));
  recalculate();
})();
