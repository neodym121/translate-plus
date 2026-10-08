// Runs before the stylesheet paints, so a dark window never flashes light on open.
// popup.js keeps this copy in sync with the setting in chrome.storage.
try {
  document.documentElement.dataset.theme = localStorage.getItem('translate-plus-theme') === 'dark' ? 'dark' : 'light';
} catch {
  document.documentElement.dataset.theme = 'light';
}
