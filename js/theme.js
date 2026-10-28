(() => {
  const apply = dark => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#141a17' : '#183f32');
    try { localStorage.setItem('folio.darkMode', String(dark)); } catch {}
  };
  window.FolioTheme = {apply};
  let dark = false;
  try { dark = localStorage.getItem('folio.darkMode') === 'true'; } catch {}
  apply(dark);
})();
