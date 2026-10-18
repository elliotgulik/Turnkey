// Thin messaging client used by the popup and the Earth content panel.
// Neither context talks to Supabase (or any other remote origin) directly
// any more — every call is relayed through the background service worker
// (background/service-worker.js's TK_API handler), which runs with its own
// extension-page CSP rather than the host page's (earth.google.com's CSP
// is what originally broke direct fetch() calls from the content script —
// see the extension README). The allowlist of reachable actions lives in
// the background worker, not here; this file is just the call shape.
function call(action, ...args) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'TK_API', action, args }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from the TurnKey extension background worker.'));
      if (res.ok) resolve(res.data);
      else reject(new Error(res.error || 'Request failed.'));
    });
  });
}

export const TurnKeyApi = {
  fetchSiteConfig: (siteUrl) => call('fetchSiteConfig', siteUrl),
  signIn: (email, password) => call('signIn', email, password),
  getProfile: () => call('getProfile'),
  getBusiness: (businessId) => call('getBusiness', businessId),
  listCustomers: (businessId) => call('listCustomers', businessId),
  getCustomer: (businessId, customerId) => call('getCustomer', businessId, customerId),
  createCustomer: (businessId, payload) => call('createCustomer', businessId, payload),
  createQuote: (businessId, payload) => call('createQuote', businessId, payload),
  createJob: (businessId, payload) => call('createJob', businessId, payload),
  logActivity: (businessId, payload) => call('logActivity', businessId, payload),
  uploadScreenshotDataUrl: (businessId, customerId, jobId, dataUrl) => call('uploadScreenshotDataUrl', businessId, customerId, jobId, dataUrl)
};
