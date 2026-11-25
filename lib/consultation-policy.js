function remainingDays(value, now = new Date()) {
  let date = String(value || '').trim();
  const match = date.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (match) date = `${match[3]}-${match[2]}-${match[1]}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const expiry = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString().slice(0, 10) !== date) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return Math.round((expiry - Date.parse(today + 'T00:00:00Z')) / 86400000);
}
function consultationOrder(portals) {
  return [...portals.filter(p => p.key !== 'simples'), ...portals.filter(p => p.key === 'simples')];
}
module.exports = { remainingDays, consultationOrder };
