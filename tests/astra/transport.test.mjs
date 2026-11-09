import test from 'node:test';
import assert from 'node:assert/strict';
import {createTransport} from '../../src/astra/transport.mjs';
import {createComboRequest,validateCreatedMarket,quoteObservations} from '../../src/astra/venue.mjs';
import {sample} from '../../src/astra/sample.mjs';
import {generateVariants} from '../../src/astra/engine.mjs';
test('local transport maps fixed-point books and preserves unavailable combo books',async()=>{
  const calls=[];const transport=createTransport({apiBase:'/kalshi/trade-api/v2',fetcher:async url=>{
    calls.push(url);if(url.includes('FAIL'))return {ok:false,status:404};
    return {ok:true,json:async()=>url.includes('orderbook')?{orderbook_fp:{yes_dollars:[['.25','20']],no_dollars:[['.65','30']]}}:{market:{ticker:'A',status:'active',notional_value_dollars:'1.00'}}};
  }});
  const data=await transport('/api/kalshi/snapshot?ids=A,FAIL');assert.equal(data.markets.length,1);assert.equal(data.errors.length,1);assert.equal(data.markets[0].bid,.25);assert.equal(data.markets[0].ask,.35);assert.ok(calls.every(x=>x.startsWith('/kalshi/trade-api/v2/markets/')));
  await assert.rejects(()=>transport('/api/kalshi/snapshot?ids=%2Fetc'),/Invalid market/);await assert.rejects(()=>transport('/api/orders'),/Unsupported/);
});
test('market listing skips unsupported records and retains opaque pagination',async()=>{
  let url;const transport=createTransport({apiBase:'/kalshi/trade-api/v2',fetcher:async u=>{url=u;return {ok:true,json:async()=>({markets:[{ticker:'AB',mve_selected_legs:[{market_ticker:'A',side:'yes'},{market_ticker:'B',side:'no'}]},{ticker:'BAD',mve_selected_legs:[{market_ticker:'X',side:'maybe'}]}],cursor:'next opaque'})};}});
  const data=await transport('/api/kalshi/markets?cursor=previous%2Bpage');assert.equal(data.markets.length,1);assert.equal(data.warnings.length,1);assert.equal(data.cursor,'next opaque');assert.match(url,/cursor=previous%2Bpage/);assert.equal(data.markets[0].quoteAt,null);
});
test('creation preserves each selected side/event and refuses non-subsets or missing metadata',()=>{
  const o=sample().markets.find(m=>m.id==='DEMO-ABCD');o.source='live';o.collection='COLLECTION';const v=generateVariants(o).variants[0];v.legs[0].outcome='no';
  const req=createComboRequest(o,v);assert.equal(req.path,'/multivariate_event_collections/COLLECTION');assert.equal(req.body.selected_markets[0].side,'no');assert.equal(req.body.selected_markets[0].event_ticker,v.legs[0].eventId);
  assert.throws(()=>createComboRequest({...o,source:'sample'},v),/live Kalshi/);assert.throws(()=>createComboRequest({...o,collection:null},v),/ticker/);
  const bad={...v,legs:[...v.legs,{marketId:'OTHER',outcome:'yes',eventId:'OTHER'}]};assert.throws(()=>createComboRequest(o,bad),/subset/);
});
test('created instrument must match exact retained outcomes',()=>{
  const o=sample().markets.find(m=>m.id==='DEMO-ABCD'),v=generateVariants(o).variants[0];
  const raw={ticker:'NEW',mve_selected_legs:v.legs.map(l=>({market_ticker:l.marketId,side:l.outcome}))};assert.equal(validateCreatedMarket(raw,v).id,'NEW');raw.mve_selected_legs[0].side='no';assert.throws(()=>validateCreatedMarket(raw,v),/does not match/);
});
test('RFQ observations preserve separate makers and reject stale, wrong-market or insufficient-size quotes',()=>{
  const now=Date.now(),r={id:'request',ticker:'AB',quantity:10};
  const base={id:'q1',rfq_id:r.id,market_ticker:r.ticker,yes_bid_dollars:'.3',no_bid_dollars:'.6',contracts_fp:'10.00',status:'open',updated_ts:new Date(now).toISOString()};
  const result=quoteObservations([base,{...base,id:'q2',contracts_fp:'9.00'},{...base,id:'old',updated_ts:new Date(now-31000).toISOString()},{...base,id:'other',market_ticker:'OTHER'}],r,now);
  assert.equal(result.length,3);assert.equal(result[0].ask,.4);assert.equal(result[0].usable,true);assert.equal(result[1].usable,false);assert.equal(result[2].usable,false);
});
