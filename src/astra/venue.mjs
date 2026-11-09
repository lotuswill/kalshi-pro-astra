import {checkLegs,legKey,signature,num,unit,validateCatalog} from './engine.mjs';
import {kalshiMarket,assertTicker} from './adapters.mjs';

// These operations do not accept quotes or place orders.
export function createComboRequest(original,variant) {
  checkLegs(variant.legs);
  const allowed=new Set(original.legs.map(legKey));
  if(original.source!=='live'||original.venue!=='kalshi'||variant.venue!=='kalshi'||variant.legs.length<2||variant.legs.length>=original.legs.length||variant.legs.some(l=>!allowed.has(legKey(l))))throw new Error('Select an exact reduced subset of a live Kalshi combo');
  assertTicker(original.collection);
  const selected_markets=variant.legs.map(l=>({market_ticker:assertTicker(l.marketId),event_ticker:assertTicker(l.eventId),side:l.outcome}));
  return {path:'/multivariate_event_collections/'+encodeURIComponent(original.collection),body:{selected_markets,with_market_payload:true}};
}
export function validateCreatedMarket(raw,variant) {
  const m=kalshiMarket(raw);validateCatalog({version:1,markets:[m]});
  if(signature(m.venue,m.legs)!==signature(variant.venue,variant.legs))throw new Error('Returned instrument does not match the selected outcomes');
  return m;
}
// Keep makers separate. RFQs never masquerade as public-book liquidity.
export function quoteObservations(quotes,request,now=Date.now()) {
  return quotes.filter(q=>q.rfq_id===request.id&&q.market_ticker===request.ticker).map(q=>{
    const bid=num(q.yes_bid_dollars),noBid=num(q.no_bid_dollars),size=num(q.contracts_fp);
    const at=Date.parse(q.updated_ts||q.created_ts||'');
    const ask=unit(noBid)&&noBid>0?1-noBid:null;
    const usable=q.status==='open'&&unit(bid)&&bid>0&&unit(ask)&&bid<=ask&&size>=request.quantity&&Number.isFinite(at)&&at<=now&&now-at<=30000;
    return {id:q.id,bid:unit(bid)&&bid>0?bid:null,ask,size,at:Number.isFinite(at)?at:null,status:q.status,usable};
  });
}
