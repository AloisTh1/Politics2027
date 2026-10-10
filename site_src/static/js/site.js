(() => {
  function normalize(value) {
    return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }
  function initMeasures() {
    const search = document.querySelector('[data-filter-search="measure"]');
    const theme = document.querySelector('[data-filter-theme="measure"]');
    if (!search || !theme) return;
    const items = [...document.querySelectorAll('[data-filter-item="measure"]')];
    const status = document.querySelector('[data-filter-status="measure"]');
    const update = () => {
      const query = normalize(search.value.trim());
      let count = 0;
      items.forEach(item => {
        const show = (!query || normalize(item.dataset.search).includes(query)) && (!theme.value || item.dataset.themes.split(' ').includes(theme.value));
        item.hidden = !show;
        if (show) count++;
      });
      document.querySelectorAll('[data-page-group]').forEach(group => {
        group.classList.toggle('no-matches', !!(query || theme.value) && !group.querySelector('[data-filter-item="measure"]:not([hidden])'));
      });
      status.textContent = `${count} mesure${count > 1 ? 's' : ''} affichée${count > 1 ? 's' : ''}`;
    };
    search.addEventListener('input', update);
    theme.addEventListener('change', update);
    update();
  }
  function initContradictions() {
    const select = document.querySelector('[data-filter-party="contra"]');
    if (!select) return;
    const items = [...document.querySelectorAll('[data-filter-item="contra"]')];
    const status = document.querySelector('[data-filter-status="contra"]');
    const update = () => {
      let count = 0;
      items.forEach(item => { const show = !select.value || item.dataset.party === select.value; item.hidden = !show; if (show) count++; });
      status.textContent = `${count} entrée${count > 1 ? 's' : ''} affichée${count > 1 ? 's' : ''}`;
    };
    select.addEventListener('change', update);
    update();
  }
  initMeasures();
  initContradictions();
})();
