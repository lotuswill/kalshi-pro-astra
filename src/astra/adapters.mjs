import {num,unit} from './engine.mjs';
const epoch=v=>{const n=Date.parse(v);return Number.isFinite(n)?n:null;};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,300}$/.test(v);
export function assertTicker(v){if(!id(v))throw new Error('Invalid market ticker');return v;}
export function kalshiMarket(m,at=Date.now()){
  assertTicker(m.ticker);
  const legs=Array.isArray(m.mve_selected_legs)&&m.mve_selected_legs.length?m.mve_selected_legs.map(l=>({marketId:l.market_ticker,outcome:l.side,eventId:l.event_ticker,title:l.market_ticker})):[{marketId:m.ticker,outcome:'yes',eventId:m.event_ticker,title:m.yes_sub_title||m.title||m.ticker}];
  return {id:m.ticker,venue:'kalshi',title:m.title||m.yes_sub_title||m.ticker,legs,status:m.status,payout:num(m.notional_value_dollars)??1,
    openInterest:num(m.open_interest_fp??m.open_interest),volume:num(m.volume_fp??m.volume),volume24h:num(m.volume_24h_fp??m.volume_24h),
    expiration:epoch(m.expiration_time),expectedExpiration:epoch(m.expected_expiration_time),closeAt:epoch(m.close_time),
    bid:num(m.yes_bid_dollars),ask:num(m.yes_ask_dollars),bidSize:num(m.yes_bid_size_fp),askSize:num(m.yes_ask_size_fp),quoteAt:null,metadataAt:at,source:'live',
    fee:null,productSettlement:legs.length===1,rulesVerified:false,rules:m.rules_primary||'',collection:m.mve_collection_ticker||null,
    note:'Listing quotes are indicative; refresh the book before comparing executable size. Fee schedule and settlement rules require review.'};
}
export function kalshiBook(response,at=Date.now()){
  const fp=response.orderbook_fp;
  if(!fp)throw new Error('Missing fixed-point orderbook; refusing to guess price units');
  const levels=a=>(Array.isArray(a)?a:[]).map(([p,q])=>[num(p),num(q)]).filter(([p,q])=>unit(p)&&q>0);
  const bids=levels(fp.yes_dollars).sort((a,b)=>b[0]-a[0]),asks=levels(fp.no_dollars).map(([p,q])=>[Math.round((1-p)*1e8)/1e8,q]).sort((a,b)=>a[0]-b[0]);
  return {bids,asks,bid:bids[0]?.[0]??null,ask:asks[0]?.[0]??null,bidSize:bids[0]?.[1]??0,askSize:asks[0]?.[1]??0,quoteAt:at};
}
// Adapter for normalized data exported by an existing Polymarket US Astra client.
// It accepts bid/ask/depth explicitly; there is no midpoint or last-price fallback.
export function polymarketMarket(m,book,meta={}){
  const dollar=v=>typeof v==='object'&&v!==null?num(v.value):num(v);
  const b=book?.marketData||book||{},mid=m.id||m.slug||m.symbol;
  if(!mid)throw new Error('Missing Polymarket market identity');
  const outcome=l=>{const side=l.side||l.outcome;if(['sell','SIDE_SELL','no'].includes(side))return 'no';if(['buy','SIDE_BUY','yes'].includes(side))return 'yes';throw new Error('Unknown Polymarket leg outcome');};
  const rawLegs=m.legs||[],legs=rawLegs.length?rawLegs.map(l=>({marketId:l.symbol||l.marketId,outcome:outcome(l),title:l.title||l.symbol,eventId:l.eventId})): [{marketId:mid,outcome:'yes',title:m.title||mid,eventId:meta.eventId}];
  const lv=a=>(a||[]).map(l=>Array.isArray(l)?[dollar(l[0]),num(l[1])]:[dollar(l.px),num(l.qty)]).filter(([p,n])=>unit(p)&&n>0);
  const bids=lv(b.bids).sort((a,b)=>b[0]-a[0]),asks=lv(b.offers||b.asks).sort((a,b)=>a[0]-b[0]);
  return {id:mid,venue:'polymarket-us',title:m.title||mid,legs,status:meta.status||String(b.state||m.state||m.status||'unknown').replace(/^(INSTRUMENT_STATE_|MARKET_STATE_)/,'').toLowerCase(),payout:1,
    openInterest:num(meta.openInterest),volume:num(meta.volume),volume24h:num(meta.volume24h),expiration:meta.expiration??null,closeAt:meta.closeAt??null,
    bids,asks,bid:bids[0]?.[0]??null,ask:asks[0]?.[0]??null,bidSize:bids[0]?.[1]??0,askSize:asks[0]?.[1]??0,quoteAt:meta.observedAt??null,source:'import',fee:meta.fee??null,
    productSettlement:meta.productSettlement===true,rulesVerified:meta.rulesVerified===true};
}
