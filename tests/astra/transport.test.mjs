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

test('direct combo lookup accepts 17 legs and does not require a book or scanner eligibility',async()=>{
  const ticker='KXMVECROSSCATEGORY-S2026S5C36JL3LF2DS5U3-EGY4ZTQ7G';
  const market={ticker,title:'17-leg fixture',status:'closed',open_interest_fp:'0.00',mve_selected_legs:Array.from({length:17},(_,i)=>({market_ticker:`LEG-${i}`,event_ticker:`EVENT-${i}`,side:i%2?'no':'yes'}))};
  const calls=[];const transport=createTransport({apiBase:'/kalshi/trade-api/v2',fetcher:async url=>{calls.push(url);return {ok:true,json:async()=>({market})};}});
  const data=await transport('/api/kalshi/market?ticker='+ticker.toLowerCase());
  assert.equal(data.markets[0].legs.length,17);assert.equal(data.markets[0].openInterest,0);assert.equal(data.markets[0].status,'closed');assert.equal(calls.length,1);assert.ok(!calls[0].includes('orderbook'));
  await assert.rejects(()=>transport('/api/kalshi/market?ticker=WRONG'),/identity mismatch/);
  await assert.rejects(()=>transport('/api/kalshi/market?ticker=%2Fetc'),/Invalid market/);
});

test('public reads fall back after a connection failure and reuse the working endpoint',async()=>{
  const calls=[],notices=[];
  const transport=createTransport({apiBase:'/kalshi/trade-api/v2',onStatus:m=>notices.push(m),fetcher:async (url,opts)=>{
    calls.push({url,opts});if(url.startsWith('/kalshi/'))return {ok:false,status:502,json:async()=>({error:{code:'EAI_AGAIN'}})};
    return {ok:true,json:async()=>({markets:[],cursor:null})};
  }});
  await transport('/api/kalshi/markets');await transport('/api/kalshi/markets');
  assert.equal(calls.length,3);assert.ok(calls[1].url.startsWith('/kalshi-alt/'));assert.ok(calls[2].url.startsWith('/kalshi-alt/'));
  assert.equal(notices.length,1);assert.ok(calls.every(c=>!c.opts.headers&&!c.opts.body&&!c.opts.method));
});
test('stalled reads time out even when fetch ignores abort and end with actionable diagnostics',async()=>{
  const signals=[];
  const transport=createTransport({apiBase:'/kalshi/trade-api/v2',requestTimeoutMs:10,fetcher:(_url,{signal})=>{signals.push(signal);return new Promise(()=>{});}});
  await assert.rejects(()=>transport('/api/kalshi/markets'),/Cannot reach Kalshi.*Timed out.*diagnose:kalshi/);
  assert.equal(signals.length,2);assert.ok(signals.every(s=>s.aborted));
});
test('a stalled JSON body is bounded and caller cancellation never starts fallback',async()=>{
  const stuck=createTransport({apiBase:'/kalshi/trade-api/v2',requestTimeoutMs:10,fetcher:async()=>({ok:true,json:()=>new Promise(()=>{})})});
  await assert.rejects(()=>stuck('/api/kalshi/markets'),/Timed out/);
  const controller=new AbortController();let calls=0;
  const stopped=createTransport({apiBase:'/kalshi/trade-api/v2',requestTimeoutMs:100,fetcher:async()=>{calls++;controller.abort(new Error('User stopped'));return new Promise(()=>{});}});
  await assert.rejects(()=>stopped('/api/kalshi/markets',controller.signal),/User stopped/);assert.equal(calls,1);
});
test('not-found and authorization errors do not trigger retries or hide their status',async()=>{
  for(const status of [401,403,404]){
    let calls=0;const transport=createTransport({apiBase:'/kalshi/trade-api/v2',fetcher:async()=>{calls++;return {ok:false,status};}});
    await assert.rejects(()=>transport('/api/kalshi/markets'),new RegExp(`HTTP ${status}`));assert.equal(calls,1);
  }
});
