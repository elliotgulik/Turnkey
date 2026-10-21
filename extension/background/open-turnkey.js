// Only reuse CRM tabs, never a public quote, booking or measurement workspace.
export async function openTurnKeyTab(chromeApi, siteUrl, requestedUrl) {
  const base = new URL(siteUrl);
  const target = new URL(requestedUrl || '/index.html', base.origin);
  if (target.origin !== base.origin || !['/', '/index.html'].includes(target.pathname) || target.username || target.password) {
    throw new Error('The saved quote must open in your connected TurnKey site.');
  }
  const tabs = await chromeApi.tabs.query({ url: base.origin + '/*' });
  const candidates = tabs.filter(tab => {
    try { const u = new URL(tab.url); return u.origin === base.origin && ['/', '/index.html'].includes(u.pathname); }
    catch { return false; }
  });
  const existing = candidates.find(tab => tab.active) || candidates[0];
  if (existing) {
    // A saved-quote URL reloads authoritative data, then the app's authenticated
    // job handoff opens the record. A plain Open action only focuses the tab.
    await chromeApi.tabs.update(existing.id, {
      active: true, ...(target.searchParams.has('job') ? { url: target.href } : {})
    });
    if (existing.windowId != null) await chromeApi.windows.update(existing.windowId, { focused: true });
    return { reused: true };
  }
  await chromeApi.tabs.create({ url: target.href });
  return { reused: false };
}
