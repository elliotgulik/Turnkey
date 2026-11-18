// Closed outlines retain both quantities. A service chooses the quantity,
// never relabels a number from another unit. Counts are always manual.
export function measurementQuantity(measurement, service) {
  if (!measurement || !service || service.shape === 'none') return null;
  const closed = measurement.type === 'area' || measurement.type === 'perimeter';
  if (service.shape !== (closed ? 'closed' : 'open')) return null;
  const value = service.unit === 'm²'
    ? measurement.quantities?.area ?? (measurement.type === 'area' ? measurement.size : null)
    : service.unit === 'm'
      ? (closed ? measurement.quantities?.perimeter : null) ?? (measurement.type !== 'area' ? measurement.size : null)
      : null;
  return Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : null;
}

export function measurementForService(measurement, svc, service) {
  const size = measurementQuantity(measurement, service);
  if (size === null) throw new Error('This service needs a compatible measurement or a manual quantity.');
  return {...measurement, service: svc, size, unit: service.unit,
    type: service.unit === 'm²' ? 'area' : service.shape === 'closed' ? 'perimeter' : 'line'};
}

// Geometry is reference information for custom work, never its pricing identity.
export const isCustomMeasurement = measurement => ['custom', 'custom-line'].includes(measurement?.category);
export function customMeasurementLine(measurement, saved = {}) {
  return {...saved, measurementId:measurement.id, svc:'custom', pricingMode:'fixed',
    label:saved.label ?? measurement.categoryLabel ?? 'Custom area',
    qty:saved.qty ?? 1, unit:saved.unit ?? 'item', unitPrice:saved.unitPrice ?? null,
    customCost:saved.customCost ?? null, manual:true};
}
