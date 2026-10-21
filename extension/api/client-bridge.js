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
  openTurnKey: (url) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({type:'TK_OPEN_TURNKEY',url}, res => {
      if(chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if(!res?.ok) return reject(new Error(res?.error || 'Could not open TurnKey. Your quote is saved.'));
      resolve(res.data);
    });
  }),
  sendQuoteToServiceM8: (businessId,jobId) => call('sendQuoteToServiceM8',businessId,jobId),
  serviceM8TransferStatus: (businessId,jobId) => call('serviceM8TransferStatus',businessId,jobId),
  connectFromActiveCRM: () => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'TK_CONNECT_FROM_ACTIVE_CRM' }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from the TurnKey extension background worker.'));
      if (res.ok) resolve(res.data);
      else reject(new Error(res.error || 'Could not connect to TurnKey.'));
    });
  }),
  getProfile: () => call('getProfile'),
  getBusiness: (businessId) => call('getBusiness', businessId),
  listCustomers: (businessId) => call('listCustomers', businessId),
  getCustomer: (businessId, customerId) => call('getCustomer', businessId, customerId),
  getJob: (businessId, jobId, customerId) => call('getJob', businessId, jobId, customerId),
  saveBoundQuote: (businessId, payload) => call('saveBoundQuote', businessId, payload),
  createCustomer: (businessId, payload) => call('createCustomer', businessId, payload),
  createQuote: (businessId, payload) => call('createQuote', businessId, payload),
  createJob: (businessId, payload) => call('createJob', businessId, payload),
  logActivity: (businessId, payload) => call('logActivity', businessId, payload),
  uploadScreenshotDataUrl: (businessId, customerId, jobId, dataUrl) => call('uploadScreenshotDataUrl', businessId, customerId, jobId, dataUrl)
};
