// User-supplied reference for the combo workflow. IDs only; quotes are always fetched.
export const REFERENCE_COMBO_TICKERS = Object.freeze([
  'KXMVECROSSCATEGORY-S2026S5C36JL3LF2DS5U3-EGY4ZTQ7G',
]);
export function comboQuery(value) {
  const query=String(value??'').trim().toUpperCase();
  if(/^KXMVE[A-Z0-9_.:]*-[A-Z0-9_.:-]+-[A-Z0-9]{9}$/.test(query)&&query.length<=300)return {kind:'full',query};
  if(/^[A-Z0-9]{9}$/.test(query))return {kind:'suffix',query};
  return {kind:'text',query};
}
export function resolveComboTickers(value,tickers) {
  const {kind,query}=comboQuery(value);
  if(kind==='full')return [query];
  if(kind!=='suffix')return [];
  return [...new Set(tickers)].filter(id=>comboQuery(id).kind==='full'&&id.toUpperCase().endsWith('-'+query)).sort();
}
