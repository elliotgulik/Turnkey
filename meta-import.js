/* Existing Meta enquiries use the same durable intake and duplicate keys as webhooks. */
(function () {
  let running = false;
  window.TK_META_IMPORT = {
    async start() {
      if (running) { toast('Meta import is already running.'); return; }
      const biz = currentBusinessId, version = businessSessionVersion;
      const unchanged = () => biz === currentBusinessId && version === businessSessionVersion;
      const report = text => {
        if (!unchanged()) return;
        const el = document.getElementById('meta-import-progress');
        if (el) el.textContent = text;
      };
      running = true;
      let cursor = null, imported = 0, duplicates = 0, forms = 0;
      try {
        do {
          if (!unchanged()) return;
          report(`Importing Meta enquiries… ${imported} new · ${duplicates} already saved · ${forms} forms checked. Keep this tab open.`);
          const { data: { session } } = await sb.auth.getSession();
          if (!session || !unchanged()) throw new Error('Sign in again to continue the import.');
          const res = await fetch(backendUrl() + '/api/connections/meta/import', {
            method: 'POST', headers: { Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ cursor }), signal: AbortSignal.timeout(90000),
          });
          const body = await res.json();
          if (!unchanged()) return;
          if (!res.ok) throw new Error(body.error || 'Meta import failed. Retry to safely skip already saved leads.');
          imported += body.imported || 0; duplicates += body.duplicates || 0; forms += body.formsFound || 0;
          cursor = body.cursor;
          if (!body.done && !cursor) throw new Error('Import did not finish. Retry safely.');
        } while (cursor);
        await pollBackendLeads();
        if (!unchanged()) return;
        const message = `Meta import complete: ${imported} new enquiries saved, ${duplicates} already saved, ${forms} forms checked. Only leads still available to this Meta account can be imported.`;
        report(message); toast(message);
      } catch (error) {
        if (unchanged()) {
          const message = `${imported} new enquiries saved so far. ${error.message || 'Import interrupted.'}`;
          report(message); toast(message);
          await pollBackendLeads();
        }
      } finally { running = false; }
    },
  };
})();
