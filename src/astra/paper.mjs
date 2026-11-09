import { analyze, validateLimits, signature, marketKey } from './engine.mjs';
export function emptyLedger(){return {version:1,initialCash:1000,pending:[],positions:[],events:[]};}
export function validateLedger(s){
  if(s?.version!==1||!Number.isFinite(s.initialCash)||s.initialCash<=0||!Array.isArray(s.pending)||!Array.isArray(s.positions)||!Array.isArray(s.events)||s.positions.length>500||s.events.length>5000||s.pending.length>50)throw new Error('Paper ledger invalid or full; export and start a new ledger');
  const ids=new Set();
  for(const p of [...s.pending,...s.positions]){
    if(typeof p.id!=='string'||ids.has(p.id)||!Number.isFinite(p.capital)||p.capital<0||!Array.isArray(p.exposureKeys)||!Number.isFinite(p.createdAt))throw new Error('Paper ledger contains an invalid position');
    ids.add(p.id);
  }
  for(const p of s.positions)if(!['open','settled'].includes(p.status)||!Number.isFinite(p.net)||!Number.isInteger(p.qty)||p.qty<=0||(p.status==='settled'&&(!Number.isFinite(p.realized)||!Number.isFinite(p.settledAt))))throw new Error('Invalid paper settlement');
  return s;
}
const day = at => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Denver',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
export function totals(s,now=Date.now()){
  validateLedger(s);
  const active=[...s.pending,...s.positions.filter(p=>p.status==='open')];
  const reserved=active.reduce((n,p)=>n+p.capital,0),realized=s.positions.filter(p=>p.status==='settled').reduce((n,p)=>n+p.realized,0);
  const dailyLoss=s.positions.filter(p=>p.status==='settled'&&day(p.settledAt)===day(now)&&p.realized<0).reduce((n,p)=>n-p.realized,0);
  return {reserved,realized,dailyLoss,free:s.initialCash+realized-reserved,active};
}
export function guardPortfolio(s,original,row,limits,now=Date.now()){
  validateLimits(limits);const t=totals(s,now),reasons=[...row.reasons];
  if(t.active.some(p=>p.originalKey===marketKey(original)))reasons.push('This original combo already has a pending/open paper position');
  if(row.capital==null||row.capital>t.free)reasons.push('Insufficient free paper cash');
  if(row.capital!=null&&t.reserved+row.capital>limits.maxTotalCapital)reasons.push('Total paper capital cap reached');
  if(t.dailyLoss>=limits.maxDailyLoss)reasons.push('Daily realized loss stop reached (America/Denver)');
  const keys=[...new Set(original.legs.map(l=>`${original.venue}:${l.eventId||l.marketId}`))];
  for(const key of keys)if(t.active.filter(p=>p.exposureKeys.includes(key)).reduce((n,p)=>n+p.capital,0)+(row.capital??0)>limits.maxPerUnderlying)reasons.push(`Exposure cap reached: ${key}`);
  return {reasons:[...new Set(reasons)],keys};
}
export function queuePaper(s,original,row,limits,now=Date.now(),mode='manual'){
  const g=guardPortfolio(s,original,row,limits,now);
  if(g.reasons.length)throw new Error(g.reasons.join('; '));
  if(mode==='automatic'&&[original.source,row.candidate.source].some(s=>!['live','sample'].includes(s)))throw new Error('Automatic paper execution requires fresh live or explicitly synthetic sample observations');
  const next=structuredClone(s),id=crypto.randomUUID();
  next.pending.push({id,originalKey:marketKey(original),original:structuredClone(original),candidate:structuredClone(row.candidate),variant:{id:row.id,venue:row.venue,legs:structuredClone(row.legs),removed:structuredClone(row.removed)},limits:{...limits},capital:row.capital,exposureKeys:g.keys,createdAt:now,signalAt:Math.max(original.quoteAt,row.candidate.quoteAt),mode});
  next.events.push({at:now,type:'queued',id,original:original.id,hedge:row.candidate.id});return validateLedger(next);
}
export function cancelPending(s,now=Date.now()){
  const next=structuredClone(s);for(const p of next.pending)next.events.push({at:now,type:'cancelled',id:p.id,reason:'Stopped by user'});next.pending=[];return validateLedger(next);
}
export function processPending(s,catalog,now=Date.now()){
  const next=structuredClone(s);const jobs=[...next.pending];
  for(const p of jobs){
    next.pending=next.pending.filter(job=>job.id!==p.id);
    const original=catalog.markets.find(m=>marketKey(m)===p.originalKey),candidate=catalog.markets.find(m=>m.venue===p.candidate.venue&&m.id===p.candidate.id);
    // Single NO leg quotes are regenerated from the canonical YES single.
    let hedge=candidate;
    if(!hedge&&p.variant.legs.length===1){const l=p.variant.legs[0],base=catalog.markets.find(m=>m.venue===p.variant.venue&&m.id===l.marketId);if(base){hedge=l.outcome==='yes'?base:{...base,id:`${base.id}::NO`,legs:p.variant.legs,bid:base.ask==null?null:1-base.ask,ask:base.bid==null?null:1-base.bid,bidSize:base.askSize,askSize:base.bidSize,bids:base.asks?.map(([v,n])=>[1-v,n]),asks:base.bids?.map(([v,n])=>[1-v,n])};}}
    if(now-p.createdAt>60000){next.events.push({at:now,type:'expired',id:p.id,reason:'No qualifying new quote within 60 seconds'});continue;}
    if(!original||!hedge||original.quoteAt<=p.signalAt||hedge.quoteAt<=p.signalAt){next.pending.push(p);continue;}
    const row=analyze(original,hedge,p.variant,catalog,p.limits,now),g=guardPortfolio(next,original,row,p.limits,now);
    if(p.mode==='automatic'&&[original.source,hedge.source].some(s=>!['live','sample'].includes(s)))g.reasons.push('Quote provenance changed');
    if(g.reasons.length){next.events.push({at:now,type:'rejected',id:p.id,reason:g.reasons.join('; ')});continue;}
    next.positions.push({id:p.id,originalKey:p.originalKey,original:structuredClone(original),hedge:structuredClone(hedge),legs:p.variant.legs,qty:p.limits.quantity,net:row.net,capital:row.capital,exposureKeys:g.keys,createdAt:now,status:'open',fees:row.fees,source:original.source,mode:p.mode});
    next.events.push({at:now,type:'paper-filled',id:p.id,capital:row.capital,net:row.net,assumption:'Both simulated legs fill against the next observed depth. This is not proof of atomic live execution.'});
  }
  return validateLedger(next);
}
export function settlePaper(s,id,values,now=Date.now()){
  const next=structuredClone(s),p=next.positions.find(p=>p.id===id);
  if(!p||p.status!=='open')throw new Error('Paper position is not open');
  const payout=legs=>legs.reduce((n,l)=>{const v=values[l.marketId];if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1)throw new Error('Supply every underlying settlement value from 0 to 1');return n*(l.outcome==='yes'?v:1-v);},1);
  p.realized=p.net+p.qty*(payout(p.legs)-payout(p.original.legs));p.status='settled';p.settledAt=now;p.settlementValues={...values};p.settlementSource='user-supplied simulation';
  next.events.push({at:now,type:'paper-settled',id,realized:p.realized});return validateLedger(next);
}
