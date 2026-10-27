(() => {
  'use strict';
  const tabs = Array.from(document.querySelectorAll('[data-platform]'));
  const button = document.getElementById('install-button');
  const message = document.getElementById('install-message');
  let installPrompt = null;
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
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    message.textContent = 'Ready to install. Give your stories a home.';
  });
  const installed = () => {
    installPrompt = null;
    button.innerHTML = 'Open Folio <span aria-hidden="true">↗</span>';
    button.dataset.installed = 'true';
    message.textContent = 'Folio is installed on this device.';
  };
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) installed();
  window.addEventListener('appinstalled', installed);
  button.addEventListener('click', async () => {
    if (button.dataset.installed) {
      location.href = './app.html';
      return;
    }
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      await prompt.prompt();
      const result = await prompt.userChoice;
      message.textContent = result.outcome === 'accepted' ? 'Folio is being added to your device.' : 'You can install later, or keep listening in your browser.';
      return;
    }
    const activeTab = tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
    document.getElementById('install').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    activeTab.focus({ preventScroll: true });
    message.textContent = ios ? 'In Safari, tap Share → Add to Home Screen.' : 'Follow the steps beside this button, or open the player to get started.';
  });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }
})();
