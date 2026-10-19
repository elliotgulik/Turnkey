export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
}

const aliases = {
  'exterior house wash':'housewash', 'house wash':'housewash', 'housewash':'housewash',
  'driveway clean':'driveway', 'driveway / patio cleaning':'driveway', 'driveway':'driveway',
  'roof treatment':'rooftreatment', 'roof wash':'roof', 'gutter clean':'gutter', 'gutter cleaning':'gutter',
  'fence clean':'fence', 'fence cleaning':'fence', 'deck clean':'deck', 'deck cleaning':'deck',
  'windows':'windows', 'window cleaning':'windows', 'window clean':'windows'
};
export function requestedServices(customer = {}, job = null) {
  const details = job?.details || {};
  let raw = details.requestedServices?.length ? details.requestedServices : customer.requestedServices || [];
  if (!raw.length) {
    const notes = [details.jobNotes, customer.notes].filter(Boolean).join(' · ');
    const legacy = /Services requested:\s*([^.]+)\./i.exec(notes);
    if (legacy) raw = legacy[1].split(',').map(name => name.trim()).filter(Boolean);
  }
  // Saved quote/request lines are useful context even for old intake records.
  if (!raw.length && Array.isArray(details.services)) raw = details.services.map(l => ({name:l.name || l.svc, service_id:l.svc}));
  const result = raw.map(item => {
    const name = typeof item === 'string' ? item : item.name || item.label || item.service_id || item.svc || '';
    return {name, service_id: (typeof item === 'object' && (item.service_id || item.svc)) || aliases[name.toLowerCase().trim()] || null};
  });
  if (details.windowsRequested && !result.some(s => s.service_id === 'windows')) result.push({name:'Window Cleaning', service_id:'windows'});
  return result;
}

export function renderCustomerContext(customer, job, services = {}) {
  if (!customer) return '';
  const rows = [
    ['Name',customer.name], ['Phone',customer.phone], ['Email',customer.email],
    ['Address',[customer.address,customer.suburb].filter(Boolean).join(', ')],
    ['Customer notes',customer.notes], ['Job notes',job?.details?.jobNotes],
    ['Source',job?.details?.source || customer.source],
    ['Requested services',requestedServices(customer,job).map(s => s.name || services[s.service_id]?.label).join(', ') || 'None recorded']
  ];
  return `<div class="tk-client-context">${rows.map(([label,value]) => `<div class="tk-context-row"><strong>${label}</strong><span>${escapeHtml(value || '—')}</span></div>`).join('')}</div>`;
}
