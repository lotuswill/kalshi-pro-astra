export const DEFAULT_FILTERS = Object.freeze({ minOI:100000, minVolume:0, volumePeriod:'total', hours:72, expiryBasis:'combo', minLegs:2, maxLegs:12, search:'', venue:'all', sort:'expiration', direction:'asc' });
export const DEFAULT_LIMITS = Object.freeze({ quantity:10, maxQuoteAgeSec:30, maxQuoteSkewSec:10, maxSpread:0.10, maxCapital:100, maxTotalCapital:500, maxPerUnderlying:200, minWorstPnl:0, maxDailyLoss:50, slippage:0.005 });
export const num = x => x === null || x === undefined || x === '' || typeof x === 'boolean' ? null : Number.isFinite(Number(x)) ? Number(x) : null;
export const unit = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const positive = x => finite(x) && x > 0;
const text = (x, max=1000) => typeof x === 'string' && x.length>0 && x.length<=max;
export const legKey = l => JSON.stringify([l.marketId,l.outcome]);
export const signature = (venue, legs) => JSON.stringify([venue,...legs.map(legKey).sort()]);
export const marketKey = m => `${m.venue}:${m.id}`;
export function checkLegs(legs) {
  if (!Array.isArray(legs) || legs.length<1 || legs.length>12) throw new Error('Use 1–12 legs');
  const ids=new Set();
  for(const l of legs){
    if(!text(l.marketId,300)||!['yes','no'].includes(l.outcome)||ids.has(l.marketId)) throw new Error('Each leg needs a unique market ID and an explicit yes/no outcome');
    ids.add(l.marketId);
  }
}
function checkLevels(levels) {
  if(!Array.isArray(levels)||levels.length>500) throw new Error('Invalid depth levels');
  for(const row of levels) if(!Array.isArray(row)||row.length!==2||!unit(row[0])||!positive(row[1])) throw new Error('Depth requires numeric dollar prices and positive quantities');
}
export function validateCatalog(data) {
  if(data?.version!==1 || !Array.isArray(data.markets)||data.markets.length>10000) throw new Error('Expected a version 1 catalog with at most 10,000 markets');
  const seen=new Set();
  for(const m of data.markets){
    if(!['kalshi','polymarket-us'].includes(m.venue)||!text(m.id,300)||!text(m.title)||seen.has(marketKey(m))) throw new Error('Invalid or duplicate market identity');
    seen.add(marketKey(m)); checkLegs(m.legs);
    for(const f of ['bid','ask']) if(m[f]!=null&&!unit(m[f]))throw new Error(`${m.id}: ${f} must be decimal dollars from 0 to 1`);
    for(const f of ['bidSize','askSize','openInterest','volume','volume24h']) if(m[f]!=null&&(!finite(m[f])||m[f]<0))throw new Error(`${m.id}: invalid ${f}`);
    for(const f of ['quoteAt','expiration','closeAt'])if(m[f]!=null&&!positive(m[f]))throw new Error(`${m.id}: invalid ${f}`);
    if(!['live','import','manual','sample','draft'].includes(m.source))throw new Error('Missing quote provenance');
    if(m.payout!==1)throw new Error('This build supports $1 maximum-payout contracts only');
    if(m.bids)checkLevels(m.bids); if(m.asks)checkLevels(m.asks);
    if(m.fee!=null&&(!unit(m.fee.rate)||!['ceil','half-even'].includes(m.fee.rounding)))throw new Error('Unknown fee model');
  }
  return data;
}
export function validateLimits(c) {
  for(const k of Object.keys(DEFAULT_LIMITS))if(!finite(c?.[k]))throw new Error(`Invalid ${k}`);
  if(!Number.isInteger(c.quantity)||c.quantity<1||c.quantity>1000000)throw new Error('Quantity must be 1–1,000,000 whole contracts');
  if(!positive(c.maxQuoteAgeSec)||!positive(c.maxQuoteSkewSec)||!positive(c.maxCapital)||!positive(c.maxTotalCapital)||!positive(c.maxPerUnderlying)||!positive(c.maxDailyLoss)||!unit(c.maxSpread)||!unit(c.slippage)||c.slippage>=1||c.maxCapital>c.maxTotalCapital)throw new Error('Invalid risk limits');
  return c;
}
export function quoteForOutcome(m, outcome='yes') {
  if(!m)return null;
  if(outcome==='yes')return m;
  return {...m,id:`${m.id}::NO`,legs:[{marketId:m.id,outcome:'no',title:m.title}],bid:unit(m.ask)?1-m.ask:null,ask:unit(m.bid)?1-m.bid:null,bidSize:m.askSize,askSize:m.bidSize,
    bids:m.asks?.map(([p,q])=>[1-p,q]),asks:m.bids?.map(([p,q])=>[1-p,q])};
}
export function legMarket(leg, original, catalog) {
  const single=catalog.markets.find(m=>m.venue===original.venue&&m.id===leg.marketId&&m.legs.length===1&&m.legs[0].marketId===m.id&&m.legs[0].outcome==='yes');
  return quoteForOutcome(single,leg.outcome);
}
export function isFresh(m, now, maxAgeSec=30) {
  return positive(m?.quoteAt) && m.quoteAt<=now && now-m.quoteAt<=maxAgeSec*1000;
}
export function legProduct(original,catalog,side='ask',{now=Date.now(),maxAgeSec=30,maxSkewSec=10}={}) {
  let product=1;const timestamps=[];
  for(const leg of original.legs){const m=legMarket(leg,original,catalog); if(!m||!unit(m[side])||!isFresh(m,now,maxAgeSec)||!['active','open'].includes(m.status)||(unit(m.bid)&&unit(m.ask)&&m.bid>m.ask))return null;timestamps.push(m.quoteAt);product*=m[side];}
  return Math.max(...timestamps)-Math.min(...timestamps)>maxSkewSec*1000?null:product;
}
export function expirationFor(m,catalog,basis='combo') {
  if(basis==='combo')return m.expiration??null;
  const times=m.legs.map(l=>legMarket(l,m,catalog)?.expiration);
  return times.every(positive)?Math.min(...times):null;
}
export function scan(catalog,options={},now=Date.now()) {
  const f={...DEFAULT_FILTERS,...options};
  for(const k of ['minOI','minVolume','hours','minLegs','maxLegs'])if(!finite(f[k])||f[k]<0)throw new Error('Filters must be finite nonnegative numbers');
  const rows=catalog.markets.filter(m=>m.legs.length>=Math.max(2,f.minLegs)&&m.legs.length<=f.maxLegs).map(m=>{
    const product=legProduct(m,catalog,'ask',{now});
    return {...m,product,gap:unit(m.bid)&&isFresh(m,now)&&product!==null?m.bid-product:null,expirationForFilter:expirationFor(m,catalog,f.expiryBasis)};
  }).filter(m=>{
    const vol=f.volumePeriod==='24h'?m.volume24h:m.volume;
    return (f.venue==='all'||m.venue===f.venue)&&['open','active'].includes(m.status)&&(!m.closeAt||m.closeAt>now)&&(f.minOI===0||(finite(m.openInterest)&&m.openInterest>=f.minOI))&&(f.minVolume===0||(finite(vol)&&vol>=f.minVolume))&&positive(m.expirationForFilter)&&m.expirationForFilter>now&&m.expirationForFilter<=now+f.hours*3600000&&`${m.title} ${m.id} ${m.legs.map(l=>l.title||l.marketId).join(' ')}`.toLowerCase().includes(f.search.toLowerCase());
  });
  const fields={expiration:'expirationForFilter',openInterest:'openInterest',volume:f.volumePeriod==='24h'?'volume24h':'volume',gap:'gap',bid:'bid',ask:'ask',legs:'legs'};
  const key=fields[f.sort]||'expirationForFilter';
  return rows.sort((a,b)=>{const av=key==='legs'?a.legs.length:a[key],bv=key==='legs'?b.legs.length:b[key];if(av==null)return bv==null?a.id.localeCompare(b.id):1;if(bv==null)return -1;return (av-bv)*(f.direction==='desc'?-1:1)||a.id.localeCompare(b.id);});
}
// Diagnose OI independently of the other active filters; unknown is not zero.
export function scanDiagnostics(catalog, options={}, now=Date.now()) {
  const rows=scan(catalog,{...options,minOI:0},now);
  const summarize=markets=>markets.reduce((d,m)=>{
    d.total++;
    if(!finite(m.openInterest))d.unknown++;
    else {d.max=d.max===null?m.openInterest:Math.max(d.max,m.openInterest);if(m.openInterest>0)d.positive++;else d.zero++;}
    return d;
  },{total:0,positive:0,zero:0,unknown:0,max:null});
  return {loaded:summarize(catalog.markets.filter(m=>m.legs.length>=2)),otherFilters:summarize(rows)};
}
export function generateVariants(original,{maxRemoved=1,pinned=[],maxCandidates=128}={}) {
  checkLegs(original.legs);
  if(!Number.isInteger(maxRemoved)||maxRemoved<1||maxRemoved>11||!Number.isInteger(maxCandidates)||maxCandidates<1||maxCandidates>512)throw new Error('Invalid optimizer bounds');
  const allowed=new Set(original.legs.map(legKey));
  if(pinned.some(k=>!allowed.has(k)))throw new Error('Pinned leg is not in this combo');
  const removable=original.legs.filter(l=>!pinned.includes(legKey(l))), variants=[];let truncated=false;
  const visit=(start,remaining,removed)=>{
    if(remaining===0){if(variants.length>=maxCandidates){truncated=true;return;}const remove=new Set(removed.map(legKey)),legs=original.legs.filter(l=>!remove.has(legKey(l)));if(legs.length)variants.push({id:signature(original.venue,legs),venue:original.venue,legs,removed:[...removed]});return;}
    for(let i=start;i<=removable.length-remaining;i++){visit(i+1,remaining-1,[...removed,removable[i]]);if(truncated)return;}
  };
  for(let n=1;n<=Math.min(maxRemoved,removable.length,original.legs.length-1);n++){visit(0,n,[]);if(truncated)break;}
  return {variants,truncated};
}
export function matchingMarkets(variant,catalog) {
  if(variant.legs.length===1){const m=legMarket(variant.legs[0],variant,catalog);return m?[m]:[];}
  const sig=signature(variant.venue,variant.legs);
  return catalog.markets.filter(m=>signature(m.venue,m.legs)===sig);
}
export function feeFor(price,qty,fee){
  if(!fee)return null;
  const cents=fee.rate*qty*price*(1-price)*100;
  if(fee.rounding==='ceil')return Math.ceil(cents-1e-10)/100;
  const x=Math.round(cents*1e8)/1e8,lower=Math.floor(x),frac=x-lower;
  return (Math.abs(frac-0.5)<1e-8?(lower%2===0?lower:lower+1):Math.round(x))/100;
}
export function fill(m,side,qty,slippage=0) {
  if(!m||!Number.isInteger(qty)||qty<=0||!['bid','ask'].includes(side)||!unit(slippage))return null;
  const levels=m[side==='bid'?'bids':'asks'] ?? (unit(m[side])&&positive(m[`${side}Size`])?[[m[side],m[`${side}Size`]]]:[]);
  const sorted=[...levels].sort((a,b)=>side==='bid'?b[0]-a[0]:a[0]-b[0]);
  let remain=qty,value=0,fee=0,knownFees=!!m.fee; const fills=[];
  for(const [p,available] of sorted){if(!unit(p)||!positive(available))continue;const n=Math.min(remain,available);if(n<=0)break;const price=side==='bid'?p-slippage:p+slippage;if(!unit(price))return null;const f=feeFor(price,n,m.fee);knownFees&&=f!==null;value+=n*price;fee+=f??0;fills.push({price,quantity:n,fee:f});remain-=n;if(remain<=1e-9)break;}
  return remain>1e-9?null:{value,average:value/qty,fee:knownFees?fee:null,fills};
}
export function hedgePayoff(originalLegs,retainedLegs,values) {
  const payout=legs=>legs.reduce((p,l)=>{const v=values[l.marketId];if(!unit(v))throw new Error('Every underlying needs a settlement value in [0,1]');return p*(l.outcome==='yes'?v:1-v);},1);
  return payout(retainedLegs)-payout(originalLegs);
}
export function analyze(original,candidate,variant,catalog,limits=DEFAULT_LIMITS,now=Date.now()) {
  validateLimits(limits);
  const reasons=[];
  const originalKeys=new Set(original.legs.map(legKey));
  const subset=variant.venue===original.venue&&variant.legs.length>0&&new Set(variant.legs.map(legKey)).size===variant.legs.length&&variant.legs.length<original.legs.length&&variant.legs.every(l=>originalKeys.has(legKey(l)));
  if(!subset)reasons.push('Hedge must retain an exact subset of the same venue and outcomes');
  if(candidate&&signature(candidate.venue,candidate.legs)!==signature(variant.venue,variant.legs))reasons.push('Quote does not match the selected legs');
  for(const [label,m] of [['Original',original],['Hedge',candidate]]){
    if(!m){reasons.push(`${label}: quote required`);continue;}
    if(!['open','active'].includes(m.status)||!positive(m.closeAt)||m.closeAt<=now||!positive(m.expiration)||m.expiration<=now)reasons.push(`${label}: closed or missing future close/expiration time`);
    if(!isFresh(m,now,limits.maxQuoteAgeSec))reasons.push(`${label}: quote stale, missing, or future-dated`);
    if(!unit(m.bid)||!unit(m.ask)||m.bid>m.ask)reasons.push(`${label}: incomplete or crossed quote`);
    else if(m.ask-m.bid>limits.maxSpread)reasons.push(`${label}: spread exceeds limit`);
    for(const [field,price] of [['bids','bid'],['asks','ask']]){const depth=m[field];if(Array.isArray(depth)&&depth.length&&unit(m[price])){const best=field==='bids'?Math.max(...depth.map(l=>l[0])):Math.min(...depth.map(l=>l[0]));if(Math.abs(best-m[price])>1e-8)reasons.push(`${label}: top quote disagrees with depth`);}}
    if(m.payout!==1||m.productSettlement!==true||m.rulesVerified!==true)reasons.push(`${label}: settlement rules require review`);
  }
  if(candidate&&positive(original.quoteAt)&&positive(candidate.quoteAt)&&Math.abs(original.quoteAt-candidate.quoteAt)>limits.maxQuoteSkewSec*1000)reasons.push('Quotes are not sufficiently synchronized');
  const sale=fill(original,'bid',limits.quantity,limits.slippage),buy=fill(candidate,'ask',limits.quantity,limits.slippage);
  if(!sale)reasons.push('Original: insufficient bid depth for requested quantity');
  if(!buy)reasons.push('Hedge: insufficient ask depth for requested quantity');
  const fees=sale?.fee!=null&&buy?.fee!=null?sale.fee+buy.fee:null;
  if(fees===null)reasons.push('Fee schedule missing; net costs cannot be evaluated');
  const gross=sale&&buy?sale.value-buy.value:null;
  const net=gross!==null&&fees!==null?gross-fees:null;
  // Buy-NO equivalent of shorting original; no cross-margin/netting assumed.
  const capital=sale&&buy&&fees!==null?limits.quantity-sale.value+buy.value+fees:null;
  const worst=subset?net:null,best=subset&&net!==null?net+limits.quantity:null;
  if(capital!==null&&capital>limits.maxCapital)reasons.push('Capital exceeds per-trade limit');
  if(worst!==null&&worst<limits.minWorstPnl)reasons.push('Worst-case P&L below configured floor');
  const product=legProduct({...original,legs:variant.legs},catalog,'ask',{now,maxAgeSec:limits.maxQuoteAgeSec});
  return {...variant,candidate,sale,buy,fees,capital,gross,net,worst,best,product,askDelta:unit(candidate?.ask)&&unit(original.ask)?candidate.ask-original.ask:null,
    gap:unit(original.bid)&&unit(candidate?.ask)?original.bid-candidate.ask:null,
    reasons,eligible:reasons.length===0,subset,qty:limits.quantity};
}
export function optimize(original,catalog,options={},limits=DEFAULT_LIMITS,now=Date.now()) {
  const {variants,truncated}=generateVariants(original,options);
  const rows=variants.map(v=>{
    const matches=matchingMarkets(v,catalog);
    const choices=matches.map(m=>analyze(original,m,v,catalog,limits,now));
    choices.sort((a,b)=>(Number(b.eligible)-Number(a.eligible))||((a.buy?.value??Infinity)-(b.buy?.value??Infinity)));
    return choices[0]??analyze(original,null,v,catalog,limits,now);
  });
  return {rows:sortAlternatives(rows,'cost','asc'),truncated};
}
export function sortAlternatives(rows,by='cost',direction='asc') {
  const get=r=>({cost:r.buy&&r.buy.fee!==null?r.buy.value+r.buy.fee:null,gap:r.gap,change:r.askDelta,worst:r.worst,capital:r.capital,product:r.product}[by]);
  return [...rows].sort((a,b)=>{const av=get(a),bv=get(b);if(av==null)return bv==null?a.id.localeCompare(b.id):1;if(bv==null)return -1;return(av-bv)*(direction==='desc'?-1:1)||a.id.localeCompare(b.id);});
}
export function scenarioTable(original,retained,net,qty=1) {
  if(original.legs.length>12||!finite(net))return [];
  const rows=[];
  for(let mask=0;mask<2**original.legs.length;mask++){
    const values=Object.fromEntries(original.legs.map((l,i)=>[l.marketId,(mask>>i)&1]));
    rows.push({values,pnl:net+qty*hedgePayoff(original.legs,retained,values)});
  }
  return rows;
}
export function draftFor(original,variant) {
  return {schema:'astra-combo-draft/v1',venue:original.venue,parentId:original.id,legs:variant.legs.map(l=>({marketId:l.marketId,outcome:l.outcome})),status:'quote-required',note:'Local draft only. A venue adapter must validate and create/quote the instrument. No order is submitted.'};
}
