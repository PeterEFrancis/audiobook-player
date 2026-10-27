(() => {
  'use strict';
  const tabs = Array.from(document.querySelectorAll('[data-platform]'));
  function selectPlatform(platform, focus = false) {
    tabs.forEach(tab => {
      const selected = tab.dataset.platform === platform;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(`panel-${tab.dataset.platform}`).hidden = !selected;
      if (selected && focus) tab.focus();
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectPlatform(tab.dataset.platform));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        selectPlatform(tabs[next].dataset.platform, true);
      }
    });
  });
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  selectPlatform(ios ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'desktop');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }
})();
