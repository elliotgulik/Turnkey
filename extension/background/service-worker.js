// Background service worker — deliberately thin. chrome.storage is directly
// available to the content script's panel modules (no proxying needed), and
// turnkey-api.js's fetch() calls work directly from the content script's
// isolated world once the operator has granted the site's origin via
// chrome.permissions.request (see popup/popup.js). The one thing that
// genuinely requires the background context is chrome.tabs.captureVisibleTab
// — content scripts cannot call chrome.tabs.* at all — so that's the only
// job this file does.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'CAPTURE_SCREENSHOT') {
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, dataUrl });
      }
    });
    return true; // async response
  }
  return false;
});
