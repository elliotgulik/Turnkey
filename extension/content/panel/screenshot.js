// Screenshot capture (build brief §7).
//
// Limitation, stated plainly rather than faked: pixel-compositing the raw
// OSM tile imagery + polygon onto an off-screen <canvas> would need
// `canvas.toDataURL()`/`toBlob()` on cross-origin tile images, which taints
// the canvas unless the tile server sends CORS headers guaranteeing
// cross-origin reads — OpenStreetMap's tile usage policy doesn't commit to
// that for programmatic reproduction, so relying on it isn't safe. Chrome's
// own `tabs.captureVisibleTab` sidesteps this entirely: it captures the
// composited pixels of the tab exactly as the operator sees them (a
// standard, sanctioned screenshot API, not pixel scraping), which still
// includes the TurnKey measurement overlay when the tracer is open, since
// that overlay is real on-screen DOM. That's what this module uses.
export function captureVisibleTab() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res && res.ok) resolve(res.dataUrl);
      else reject(new Error((res && res.error) || 'Screenshot failed'));
    });
  });
}

export function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = meta.match(/data:(.*);base64/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export function renderScreenshotPreview(container, dataUrl, actions) {
  container.innerHTML = `
    <div class="tk-modal-backdrop">
      <div class="tk-modal tk-screenshot-modal">
        <div class="tk-modal-head">
          <h3>Screenshot</h3>
          <button type="button" class="tk-icon-btn" data-close aria-label="Close">×</button>
        </div>
        <div class="tk-modal-body">
          <img class="tk-screenshot-img" src="${dataUrl}" alt="Property screenshot"/>
          <p class="tk-hint">Saved with this quote — it'll show up as an attachment on the customer's job in TurnKey.</p>
        </div>
        <div class="tk-modal-foot">
          <button type="button" class="tk-btn" data-retake>Retake</button>
          <button type="button" class="tk-btn tk-btn-accent" data-keep>Keep</button>
        </div>
      </div>
    </div>`;
  container.querySelector('[data-close]').addEventListener('click', () => actions.onClose());
  container.querySelector('[data-retake]').addEventListener('click', () => actions.onRetake());
  container.querySelector('[data-keep]').addEventListener('click', () => actions.onKeep());
}
