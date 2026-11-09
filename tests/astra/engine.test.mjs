import test from 'node:test';
import assert from 'node:assert/strict';
import {sample} from '../../src/astra/sample.mjs';
import * as E from '../../src/astra/engine.mjs';
import * as P from '../../src/astra/paper.mjs';
import {kalshiMarket,kalshiBook,polymarketMarket} from '../../src/astra/adapters.mjs';
const now=1800000000000;
const setup=()=>{const catalog=sample(now),original=catalog.markets.find(m=>m.id==='DEMO-ABCD'),limits={...E.DEFAULT_LIMITS};return {catalog,original,limits};};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
function rowFor(x){return E.optimize(x.original,x.catalog,{},x.limits,now).rows.find(r=>r.candidate?.id==='DEMO-ABD');}

test('default scanner filters positive OI and expiration, ranking highest OI first',()=>{
  const {catalog}=setup();E.validateCatalog(catalog);const rows=E.scan(catalog,{},now);
  assert.equal(rows.length,12);assert.ok(rows.every(m=>m.openInterest>=1));
  assert.ok(rows.every((m,i)=>!i||m.openInterest<=rows[i-1].openInterest));
  const m=catalog.markets.find(m=>m.id==='DEMO-ABCD');m.openInterest=100000;m.expiration=now+72*3600000;
  assert.ok(E.scan(catalog,{},now).some(r=>r===m||r.id===m.id&&r.venue===m.venue));
  m.expiration++;assert.ok(!E.scan(catalog,{},now).some(r=>r.id===m.id&&r.venue===m.venue));
  m.expiration=now+1000;m.openInterest=null;assert.ok(!E.scan(catalog,{},now).some(r=>r.id===m.id&&r.venue===m.venue));
});
test('volume period, search, first-leg expiration and gap sorting',()=>{
  const {catalog}=setup();assert.equal(E.scan(catalog,{minVolume:200000,volumePeriod:'24h'},now).length,0);
  assert.ok(E.scan(catalog,{minVolume:200000,volumePeriod:'total'},now).length>0);
  const rows=E.scan(catalog,{search:'ABCD',expiryBasis:'first-leg'},now);assert.equal(rows.length,2);assert.equal(rows[0].expirationForFilter,now+12*3600000);
  const sorted=E.scan(catalog,{sort:'gap',direction:'desc'},now);assert.ok(sorted.every((m,i)=>!i||m.gap<=sorted[i-1].gap));
});
test('product uses required outcome asks, never midpoint; unknown/stale/crossed/skew fail closed',()=>{
  const {catalog,original}=setup();close(E.legProduct(original,catalog,'ask',{now}),.58*.65*.74*.88);
  const single=catalog.markets[0];original.legs[0].outcome='no';close(E.legProduct(original,catalog,'ask',{now}),(1-single.bid)*.65*.74*.88);
  single.quoteAt=now-31000;assert.equal(E.legProduct(original,catalog,'ask',{now}),null);
  single.quoteAt=now-11000;assert.equal(E.legProduct(original,catalog,'ask',{now}),null);
  single.quoteAt=now;single.bid=.99;assert.equal(E.legProduct(original,catalog,'ask',{now}),null);
  single.bid=null;assert.equal(E.legProduct(original,catalog,'ask',{now}),null);
});
test('NO quotes complement both prices, sizes and orderbook sides',()=>{
  const {catalog}=setup(),s=catalog.markets[0],no=E.quoteForOutcome(s,'no');close(no.ask,1-s.bid);close(no.bid,1-s.ask);assert.equal(no.askSize,s.bidSize);close(no.asks[0][0],1-s.bids[0][0]);
});
test('variants enumerate exact subsets, respect pins and cap search',()=>{
  const {original}=setup();assert.equal(E.generateVariants(original).variants.length,4);
  assert.equal(E.generateVariants(original,{maxRemoved:2}).variants.length,10);
  const a=E.generateVariants(original,{maxRemoved:3,pinned:[E.legKey(original.legs[0])]});assert.equal(a.variants.length,7);assert.ok(a.variants.every(v=>v.legs.some(l=>l.marketId==='DEMO-1')));
  assert.equal(E.generateVariants(original,{maxRemoved:3,maxCandidates:2}).truncated,true);
});
test('depth walks multiple levels and applies fee rounding per modeled fill',()=>{
  const m={asks:[[.4,3],[.5,7]],fee:{rate:.07,rounding:'ceil'}};
  const f=E.fill(m,'ask',10,.01);close(f.value,4.8);assert.equal(f.fills.length,2);close(f.fee,.06+.13);
  assert.equal(E.fill(m,'ask',11),null);assert.equal(E.fill({...m,fee:null},'ask',10).fee,null);
  assert.equal(E.feeFor(.5,1,{rate:.02,rounding:'half-even'}),0);
  assert.equal(E.feeFor(.5,1,{rate:.06,rounding:'half-even'}),.02);
});
test('eligible synthetic hedge distinguishes bid credit from product benchmark',()=>{
  const x=setup(),r=rowFor(x);assert.equal(r.eligible,true,r.reasons.join(';'));close(r.askDelta,-.07);close(r.gap,.05);close(r.gross,.4);close(r.net,.11);close(r.capital,9.89);close(r.worst,.11);close(r.best,10.11);
  assert.notEqual(r.product,r.buy.average);const outcomes=E.scenarioTable(x.original,r.legs,r.net,r.qty);assert.equal(outcomes.length,16);close(Math.min(...outcomes.map(x=>x.pnl)),r.worst);close(Math.max(...outcomes.map(x=>x.pnl)),r.best);
});
test('subset payoff bound also holds for NO and fractional settlements',()=>{
  const {original}=setup();original.legs[0].outcome='no';const retained=original.legs.slice(0,3);
  for(const a of [0,.2,.8,1])for(const b of [0,.4,1])for(const c of [0,.6,1])for(const d of [0,.1,1]){const p=E.hedgePayoff(original.legs,retained,{'DEMO-1':a,'DEMO-2':b,'DEMO-3':c,'DEMO-4':d});assert.ok(p>=-1e-12&&p<=1);}
});
test('unquoted alternatives remain unknown and cannot be paper executed',()=>{
  const x=setup();x.catalog.markets=x.catalog.markets.filter(m=>m.id!=='DEMO-ABD');const r=E.optimize(x.original,x.catalog,{},x.limits,now).rows.find(r=>r.removed[0].marketId==='DEMO-3');assert.equal(r.candidate,null);assert.equal(r.net,null);assert.equal(r.eligible,false);assert.match(r.reasons.join(';'),/quote required/);
});
test('staleness, crossed quotes, fees, rules, depth and risk gates block orders',()=>{
  for(const [field,value,reason] of [['quoteAt',now-31000,/stale/],['quoteAt',now+1,/future/],['bid',.9,/crossed/],['fee',null,/Fee schedule/],['rulesVerified',false,/rules/],['asks',[],/depth/],['closeAt',now,/closed/]]){
    const x=setup(),r=rowFor(x);r.candidate[field]=value;const checked=E.analyze(x.original,r.candidate,r,x.catalog,x.limits,now);assert.equal(checked.eligible,false);assert.match(checked.reasons.join(';'),reason);
  }
  const x=setup();x.limits.maxCapital=1;assert.equal(rowFor(x).eligible,false);
});
test('mismatched or duplicated retained outcomes are blocked',()=>{
  const x=setup(),r=rowFor(x),variant={...r,legs:[r.legs[0],r.legs[0]]};assert.equal(E.analyze(x.original,r.candidate,variant,x.catalog,x.limits,now).subset,false);
  const bad={...r.candidate,venue:'polymarket-us'};assert.equal(E.analyze(x.original,bad,r,x.catalog,x.limits,now).eligible,false);
});
test('paper requires new observations of BOTH books and rechecks gates',()=>{
  const x=setup(),r=rowFor(x);let ledger=P.queuePaper(P.emptyLedger(),x.original,r,x.limits,now);
  assert.equal(P.totals(ledger,now).reserved,r.capital);ledger=P.processPending(ledger,x.catalog,now+1000);assert.equal(ledger.pending.length,1);
  x.original.quoteAt=now+1000;ledger=P.processPending(ledger,x.catalog,now+1000);assert.equal(ledger.pending.length,1);
  r.candidate.quoteAt=now+1000;ledger=P.processPending(ledger,x.catalog,now+1000);assert.equal(ledger.pending.length,0);assert.equal(ledger.positions.length,1);
  const values=Object.fromEntries(x.original.legs.map(l=>[l.marketId,1]));ledger=P.settlePaper(ledger,ledger.positions[0].id,values,now+2000);close(ledger.positions[0].realized,.11);close(P.totals(ledger,now+2000).free,1000.11);
  assert.throws(()=>P.settlePaper(ledger,ledger.positions[0].id,values,now+3000),/not open/);
});
test('pending orders reserve capital against later repricing',()=>{
  const x=setup();x.limits={...x.limits,maxCapital:20,maxTotalCapital:20,maxPerUnderlying:20,minWorstPnl:-1};const r=rowFor(x);
  let ledger=P.queuePaper(P.emptyLedger(),x.original,r,x.limits,now);
  const other=x.catalog.markets.find(m=>m.id==='DEMO-ABCD'&&m.venue==='polymarket-us');const xr={...x,original:other};ledger=P.queuePaper(ledger,other,rowFor(xr),x.limits,now);
  const hedge=r.candidate;hedge.ask=.29;hedge.asks=[[.29,100]];hedge.quoteAt=now+1000;x.original.quoteAt=now+1000;
  ledger=P.processPending(ledger,x.catalog,now+1000);assert.equal(ledger.positions.length,0);assert.equal(ledger.pending.length,1);assert.match(ledger.events.at(-1).reason,/Total paper capital cap/);
});
test('portfolio caps, duplicate orders, provenance, expiration and cancellation',()=>{
  const x=setup(),r=rowFor(x),ledger=P.queuePaper(P.emptyLedger(),x.original,r,x.limits,now);
  assert.throws(()=>P.queuePaper(ledger,x.original,r,x.limits,now),/already/);
  assert.throws(()=>P.queuePaper({...P.emptyLedger(),initialCash:1},x.original,r,x.limits,now),/free paper cash/);
  assert.throws(()=>P.queuePaper(P.emptyLedger(),x.original,r,{...x.limits,maxPerUnderlying:1},now),/Exposure cap/);
  const imported={...x.original,source:'import'};assert.throws(()=>P.queuePaper(P.emptyLedger(),imported,r,x.limits,now,'automatic'),/requires fresh live/);
  assert.equal(P.processPending(ledger,x.catalog,now+60001).pending.length,0);assert.equal(P.cancelPending(ledger,now).pending.length,0);
  const loss={...ledger,pending:[],positions:[{...ledger.pending[0],status:'settled',net:-60,qty:10,realized:-60,settledAt:now}]};assert.throws(()=>P.queuePaper(loss,x.original,r,x.limits,now),/Daily realized loss/);
});
test('adapters preserve unknown metadata, normalize NO liquidity, refuse guessed units/outcomes',()=>{
  const m=kalshiMarket({ticker:'ABC',status:'active',yes_bid_dollars:'0.25',yes_ask_dollars:'0.3',open_interest_fp:'100000.00'});assert.equal(m.openInterest,100000);assert.equal(m.volume,null);assert.equal(m.quoteAt,null);assert.equal(m.fee,null);
  const b=kalshiBook({orderbook_fp:{yes_dollars:[['0.25','20']],no_dollars:[['0.7','15']]}},now);close(b.ask,.3);assert.equal(b.askSize,15);assert.equal(b.quoteAt,now);
  assert.throws(()=>kalshiBook({orderbook:{yes:[[25,20]]}}),/refusing to guess/);
  assert.throws(()=>polymarketMarket({id:'X',legs:[{symbol:'Y',side:'unknown'}]},{}),/Unknown/);
  const p=polymarketMarket({id:'P'}, {bids:[{px:{value:'.3'},qty:'12'}],offers:[{px:'.4',qty:'13'}]}, {observedAt:now});assert.equal(p.bid,.3);assert.equal(p.ask,.4);assert.equal(p.openInterest,null);
});
test('validation rejects units, identities and invalid limits',()=>{
  const {catalog}=setup();catalog.markets[0].ask=58;assert.throws(()=>E.validateCatalog(catalog),/decimal dollars/);assert.throws(()=>E.validateLimits({...E.DEFAULT_LIMITS,quantity:1.5}),/whole contracts/);
  assert.throws(()=>E.checkLegs([{marketId:'A',outcome:'yes'},{marketId:'A',outcome:'no'}]),/unique/);
});

test('OI diagnostics distinguish zero, missing and fractional contracts under other filters',()=>{
  const {catalog,original}=setup();
  catalog.markets=[{...original,id:'ZERO',openInterest:0},{...original,id:'UNKNOWN',openInterest:null},{...original,id:'FRACTIONAL',openInterest:23.54},{...original,id:'LATER',openInterest:100000,expiration:now+73*3600000}];
  for(const minOI of [1,10])assert.deepEqual(E.scan(catalog,{minOI},now).map(m=>m.id),['FRACTIONAL']);
  assert.equal(E.scan(catalog,{minOI:100000},now).length,0);
  assert.equal(E.scan(catalog,{minOI:0},now).length,3);
  const d=E.scanDiagnostics(catalog,{},now);
  assert.deepEqual(d.otherFilters,{total:3,positive:1,zero:1,unknown:1,max:23.54});
  assert.equal(d.loaded.max,100000);
});
