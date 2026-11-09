import assert from 'node:assert/strict';
import {sample} from '../../src/astra/sample.mjs';
const {JSDOM}=await import(process.env.JSDOM_MODULE||'jsdom');
const dom=new JSDOM('<!doctype html><body><div id="host"></div></body>',{url:'http://127.0.0.1:5174',pretendToBeVisual:true});
const w=dom.window,intervals=new Map();let seq=0,hang=false,networkFail=false,listingCalls=0,listingMode='paged';const writes=[];
for(const key of ['window','document','localStorage','FormData','File','Blob'])Object.defineProperty(globalThis,key,{value:key==='window'?w:w[key],configurable:true,writable:true});
Object.defineProperty(globalThis,'navigator',{value:w.navigator,configurable:true});
Object.defineProperty(w.navigator,'locks',{value:{request:async(_name,_opts,fn)=>fn({})}});
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
w.setInterval=(fn,ms)=>{intervals.set(++seq,{fn,ms});return seq;};w.clearInterval=id=>intervals.delete(id);
const referenceTicker='KXMVECROSSCATEGORY-S2026S5C36JL3LF2DS5U3-EGY4ZTQ7G';let directCalls=0;
const raw=m=>({ticker:m.id,title:m.title,status:'active',notional_value_dollars:'1.00',mve_selected_legs:m.legs.length>1?m.legs.map(l=>({market_ticker:l.marketId,event_ticker:l.eventId,side:l.outcome})):undefined,open_interest_fp:String(m.openInterest),volume_fp:String(m.volume),volume_24h_fp:String(m.volume24h),expiration_time:new Date(m.expiration).toISOString(),close_time:new Date(m.closeAt).toISOString(),yes_bid_dollars:String(m.bid),yes_ask_dollars:String(m.ask),mve_collection_ticker:'COLLECTION'});
globalThis.fetch=async(url,{signal}={})=>{
  if(networkFail)return {ok:false,status:502,json:async()=>({error:{code:'EAI_AGAIN'}})};
  if(hang)await new Promise((_,reject)=>{if(signal.aborted)reject(new Error('Aborted'));else signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true});});
  const markets=sample().markets.filter(m=>m.venue==='kalshi');
  if(url.endsWith('/markets/'+referenceTicker)){
    directCalls++;
    return {ok:true,json:async()=>({market:{...raw(markets.find(m=>m.legs.length>1)),ticker:referenceTicker,title:'17-leg lookup fixture',open_interest_fp:'0.00',expiration_time:new Date(Date.now()+90*3600000).toISOString(),mve_selected_legs:Array.from({length:17},(_,i)=>({market_ticker:`LOOKUP-LEG-${i}`,event_ticker:`LOOKUP-EVENT-${i}`,side:'yes'}))}})};
  }
  if(url.includes('/markets?')){
    listingCalls++;
    const cursor=new URL(url,'http://localhost').searchParams.get('cursor');
    const page=cursor?Number(cursor):0;
    if(listingMode==='capacity'){
      const base=raw(markets.find(m=>m.legs.length>1));
      return {ok:true,json:async()=>({markets:Array.from({length:200},(_,i)=>({...base,ticker:`CAP-${page}-${i}`,title:'Capacity fixture',open_interest_fp:'0.00'})),cursor:String(page+1)})};
    }
    if(listingMode==='ranked'){
      const base=raw(markets.find(m=>m.legs.length>1));
      return {ok:true,json:async()=>({markets:page===0?Array.from({length:120},(_,i)=>({...base,ticker:`RANK-${i+1}`,open_interest_fp:String(i+1)})):[{...base,ticker:'LATER-HIGH',open_interest_fp:'9999'}],cursor:page===0?'1':null})};
    }
    if(listingMode==='zero'||listingMode==='repeat'||page<2)return {ok:true,json:async()=>({markets:markets.filter(m=>m.legs.length>1).map(m=>({...raw(m),ticker:`ZERO-${page}-${m.id}`,open_interest_fp:'0.00'})),cursor:listingMode==='repeat'?'1':String(page+1)})};
    assert.equal(page,2,'Must follow opaque listing cursors through the zero-OI pages');
    return {ok:true,json:async()=>({markets:markets.filter(m=>m.legs.length>1).map(raw),cursor:null})};
  }
  const id=decodeURIComponent(url.split('/markets/')[1]?.split('/')[0]),m=markets.find(m=>m.id===id);
  return {ok:!!m,status:m?200:404,json:async()=>url.includes('orderbook')?{orderbook_fp:{yes_dollars:m.bids,no_dollars:m.asks.map(([p,q])=>[1-p,q])}}:{market:raw(m)}};
};
const authFetch=async(path,method,body)=>{
  if(method!=='GET')writes.push({path,method,body});
  if(path.startsWith('/multivariate_event_collections/'))return method==='GET'?{multivariate_contract:{collection_ticker:'COLLECTION',is_ordered:false,size_min:2,size_max:12}}:{market:raw(sample().markets.find(m=>m.id==='DEMO-ABD'))};
  if(path==='/communications/rfqs')return {rfq_id:'test-rfq'};
  if(path.startsWith('/communications/quotes?'))return {quotes:[]};
  if(method==='DELETE')return {};
  throw new Error('Unexpected authenticated request '+path);
};
const {mountWorkbench}=await import('../../src/astra/workbench.mjs');
const shadow=w.document.querySelector('#host').attachShadow({mode:'open'}),root=w.document.createElement('div');shadow.append(root);
const dispose=mountWorkbench(root,{apiBase:'/kalshi/trade-api/v2',authFetch,profile:'test'});
const $=x=>shadow.querySelector(x),click=x=>{assert.ok($(x),'Missing '+x);$(x).click();};
const idle=async()=>{for(let i=0;i<25;i++)await new Promise(r=>setTimeout(r,0));assert.equal($('[role="alert"]'),null,$('[role="alert"]')?.textContent);};
const submit=()=>$('dialog form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
assert.equal($('[data-filter="minOI"]').value,'1');assert.equal($('[data-filter="hours"]').value,'72');
click('[data-action="sample"]');await idle();assert.equal(shadow.querySelectorAll('tbody tr').length,6);
click('button[data-market="kalshi:DEMO-ABCD"]');assert.match(root.textContent,/PAPER CHECKS PASS/);
click('[data-action="draft"]');await idle();assert.equal(JSON.parse(localStorage.getItem('kalshi-astra-combo-drafts-v1:test')).length,1);
click('[data-action="paper"]');submit();await idle();assert.equal(JSON.parse(localStorage.getItem('kalshi-astra-combo-paper-v1:test')).pending.length,1);
click('[data-action="refresh"]');await idle();assert.equal(JSON.parse(localStorage.getItem('kalshi-astra-combo-paper-v1:test')).positions.length,1);
click('[data-page="paper"]');click('[data-settle]');for(const input of shadow.querySelectorAll('dialog input'))input.value='1';submit();await idle();assert.equal(JSON.parse(localStorage.getItem('kalshi-astra-combo-paper-v1:test')).positions[0].status,'settled');
click('[data-page="scanner"]');click('[data-action="live"]');await idle();
assert.equal(listingCalls,3,'Initial load must search past zero-OI pages');
assert.equal(shadow.querySelectorAll('tbody tr').length,6);
assert.match($('[data-oi-diagnostics]').textContent,/12 with zero OI/);
const filter=value=>{const input=$('[data-filter="minOI"]');input.value=String(value);input.dispatchEvent(new w.Event('change',{bubbles:true}));};
for(const [min,count] of [[1,6],[10,6],[100000,5]]){filter(min);assert.equal(shadow.querySelectorAll('tbody tr').length,count);}
filter(0);assert.equal(shadow.querySelectorAll('tbody tr').length,18);filter(100000);
click('button[data-market="kalshi:DEMO-ABCD"]');
// Explicitly select the retained ABD subset; no remote write before approval.
const variant=[...shadow.querySelectorAll('button[data-variant]')].find(b=>b.textContent.includes('DEMO-3'));assert.ok(variant);variant.click();
click('[data-action="create-market"]');assert.equal(writes.length,0);submit();await idle();assert.equal(writes.length,1);assert.equal(writes[0].body.selected_markets.length,3);
click('[data-action="rfq-original"]');assert.equal(writes.length,1);submit();await idle();assert.equal(writes.length,2);assert.equal(writes[1].body.rest_remainder,false);
click('[data-action="cancel-rfq"]');await idle();assert.equal(writes[2].method,'DELETE');
click('[data-page="scanner"]');listingMode='zero';listingCalls=0;click('[data-action="live"]');await idle();
assert.equal(listingCalls,20,'Search must stop at its page budget');assert.equal(shadow.querySelectorAll('tbody tr').length,0);
assert.match(root.textContent,/Page budget reached/);assert.match(root.textContent,/highest reported OI: 0/);
assert.equal($('[data-action="scan-pages"]').disabled,false);
click('[data-action="scan-pages"]');await idle();assert.equal(listingCalls,40,'Continue must retain the cursor');
listingMode='repeat';listingCalls=0;click('[data-action="live"]');
for(let i=0;i<25;i++)await new Promise(r=>setTimeout(r,0));
assert.match($('[role="alert"]').textContent,/repeated a pagination cursor/);assert.equal(listingCalls,2);
listingMode='ranked';listingCalls=0;click('[data-action="reset-filters"]');await idle();
assert.equal($('[data-filter="sort"]').value,'openInterest');assert.equal($('[data-filter="direction"]').value,'desc');assert.equal($('[data-filter="minOI"]').value,'1');
click('[data-action="live"]');await idle();assert.equal(listingCalls,2,'Continue beyond the first 100 matches');
assert.equal(shadow.querySelectorAll('tbody tr').length,100);
assert.equal($('tbody tr').dataset.market,'kalshi:LATER-HIGH');
assert.equal([...shadow.querySelectorAll('tbody tr')].at(-1).dataset.market,'kalshi:RANK-22');
assert.match(root.textContent,/Showing 100 of 121 matches/);
hang=true;click('[data-action="live"]');await new Promise(r=>setTimeout(r,0));assert.equal($('[data-action="kill"]').disabled,false);click('[data-action="kill"]');await idle();hang=false;
const findTicker=async value=>{const input=$('[data-filter="search"]');input.value=value;input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await idle();};
await findTicker(' egy4ztq7g ');assert.equal(directCalls,1);
assert.match(root.textContent,/Direct ticker match/);assert.match(root.textContent,/17 legs/);
assert.equal(shadow.querySelectorAll('tbody tr').length,0,'Lookup should be visible even when normal filters exclude it');
assert.ok(JSON.parse(localStorage.getItem('kalshi-astra-combo-tickers-v1:test')).includes(referenceTicker));
click(`button[data-market="kalshi:${referenceTicker}"]`);assert.equal(shadow.querySelectorAll('[data-keep]').length,17);
click('[data-page="scanner"]');await findTicker(referenceTicker.toLowerCase());assert.equal(directCalls,2);
listingMode='zero';listingCalls=0;await findTicker('UNKNOWN99');assert.equal(listingCalls,0);assert.match(root.textContent,/No market pages were scanned/);
networkFail=true;
const failedInput=$('[data-filter="search"]');failedInput.value=referenceTicker;failedInput.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
for(let i=0;i<25;i++)await new Promise(r=>setTimeout(r,0));
assert.match($('[role="alert"]').textContent,/Cannot reach Kalshi.*EAI_AGAIN/);
assert.ok(!root.textContent.includes('WORKING…'),'Failed lookup must release the busy state');
assert.equal($('[role="status"]'),null,'Stale lookup progress must be cleared after failure');
networkFail=false;await findTicker(referenceTicker);assert.match(root.textContent,/Direct ticker match/);
// Pasting, clicking Find and even the old scanner buttons must bypass pagination.
const beforeListing=listingCalls;
for(const value of [referenceTicker,'EGY4ZTQ7G']){
  const before=directCalls,input=$('[data-filter="search"]');input.value=value;
  input.dispatchEvent(new w.Event('input',{bubbles:true}));
  await new Promise(r=>setTimeout(r,500));await idle();
  assert.equal(directCalls,before+1,'Typing/pasting a complete ID auto-fetches it');
  assert.equal(listingCalls,beforeListing,'Exact lookup must not scan pages');
}
for(const action of ['lookup','live','scan-pages']){
  const before=directCalls;const input=$('[data-filter="search"]');input.value=referenceTicker;
  // Keep the pre-render scanner button present to model clicking just after pasting.
  let b=$(`[data-action="${action}"]`);
  if(!b){b=w.document.createElement('button');b.dataset.action=action;root.append(b);}
  b.click();await idle();assert.equal(directCalls,before+1);assert.equal(listingCalls,beforeListing);
}
// Reproduce a full scanner catalog, then fetch the exact ticker without another page.
listingMode='capacity';listingCalls=0;
const broad=$('[data-filter="search"]');broad.value='no matching title';broad.dispatchEvent(new w.Event('change',{bubbles:true}));
click('[data-action="live"]');await idle();click('[data-action="scan-pages"]');await idle();click('[data-action="scan-pages"]');await idle();
assert.equal(listingCalls,48);assert.match(root.textContent,/Local catalog limit reached/);assert.equal($('[data-action="scan-pages"]').disabled,true);
const beforeCapacityLookup=directCalls;await findTicker(referenceTicker);
assert.equal(directCalls,beforeCapacityLookup+1);assert.equal(listingCalls,48);assert.match(root.textContent,/Direct ticker match/);assert.match(root.textContent,/9,601 combos loaded/);
assert.ok(writes.every(r=>!r.path.includes('/orders')&&!r.path.includes('/accept')));
dispose();assert.equal(intervals.size,0);assert.equal(root.children.length,0);assert.equal(shadow.querySelector('dialog'),null);
dom.window.close();console.log('Integrated shadow-DOM workflow passed: scanner, paper lifecycle, explicit create/RFQ approvals, cancel, Stop, and unmount cleanup.');
