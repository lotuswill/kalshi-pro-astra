import {DEFAULT_FILTERS,DEFAULT_LIMITS,validateCatalog,validateLimits,marketKey,legKey,signature,legMarket,legProduct,scan,scanDiagnostics,optimize,analyze,matchingMarkets,sortAlternatives,scenarioTable,draftFor} from './engine.mjs';
import {emptyLedger,validateLedger,totals,queuePaper,cancelPending,processPending,settlePaper} from './paper.mjs';
import {comboQuery,resolveComboTickers,REFERENCE_COMBO_TICKERS} from './ticker-lookup.mjs';
import { createTransport } from './transport.mjs';
import { createComboRequest, validateCreatedMarket, quoteObservations } from './venue.mjs';

export function mountWorkbench(root,{apiBase,authFetch,profile='default'}={}) {
const surface=root.getRootNode(), document=root.ownerDocument;
const timers=[];const setInterval=(fn,ms)=>{const id=window.setInterval(fn,ms);timers.push(id);return id;};
let disposed=false,workspaceActive=true;
const disclosures=new Set();
const storageKey='kalshi-astra-combo-paper-v1:'+profile;
const draftKey='kalshi-astra-combo-drafts-v1:'+profile;
const tickerIndexKey='kalshi-astra-combo-tickers-v1:'+profile;
let tickerIndex=[...REFERENCE_COMBO_TICKERS];
try{const saved=JSON.parse(localStorage.getItem(tickerIndexKey)||'[]');if(Array.isArray(saved))tickerIndex=[...new Set([...tickerIndex,...saved.filter(id=>typeof id==='string'&&comboQuery(id).kind==='full').slice(-10000)])];}catch{}
function rememberTickers(markets){
  tickerIndex=[...new Set([...tickerIndex,...markets.filter(m=>m.venue==='kalshi'&&m.source==='live'&&comboQuery(m.id).kind==='full').map(m=>m.id)])].slice(-10000);
  try{localStorage.setItem(tickerIndexKey,JSON.stringify(tickerIndex));}catch{/* Index persistence is optional; current-session lookup still works. */}
}
const transport=createTransport({apiBase,authFetch});
const dialog=document.createElement('dialog');surface.append(dialog);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>v==null||!Number.isFinite(v)?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(v);
const px=v=>v==null||!Number.isFinite(v)?'—':`${(100*v).toFixed(2)}¢`;
const number=v=>v==null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(v);
const when=v=>v?new Intl.DateTimeFormat('en-US',{timeZone:'America/Denver',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(v)):'Unknown';
const sign=v=>v==null?'':v>=0?'positive':'negative';
const badge=(v,color='')=>`<span class="badge ${color}">${esc(v)}</span>`;
const stat=(name,value,color='')=>`<div class="stat"><span>${esc(name)}</span><strong class="${color}">${esc(value)}</strong></div>`;
const button=(action,label,disabled=false,cls='')=>`<button data-action="${action}" ${disabled?'disabled':''} class="${cls}">${label}</button>`;
const s={page:'scanner',catalog:{version:1,markets:[]},source:'empty',lookupIds:[],cursor:null,pages:0,filters:{...DEFAULT_FILTERS},limits:{...DEFAULT_LIMITS},selected:null,pinned:new Set(),keep:new Set(),maxRemoved:1,selectedVariant:null,custom:false,sort:'cost',direction:'asc',busy:false,auto:false,error:'',notice:'',storageError:false,drafts:[],rfqs:[],ledger:emptyLedger()};
try{const stored=localStorage.getItem(storageKey);if(stored)s.ledger=validateLedger(JSON.parse(stored));const drafts=JSON.parse(localStorage.getItem(draftKey)||'[]');if(!Array.isArray(drafts)||drafts.length>500)throw new Error('Invalid draft store');s.drafts=drafts;}catch(e){s.error=`Local storage needs attention: ${e.message}. Paper actions are disabled; existing stored data was not replaced.`;s.storageError=true;}
const original=()=>s.catalog.markets.find(m=>marketKey(m)===s.selected);
function compare(){
  const o=original();if(!o)return {rows:[],truncated:false};if(s.custom&&(s.keep.size===0||s.keep.size===o.legs.length))return {rows:[],truncated:false};
  const result=optimize(o,s.catalog,{maxRemoved:s.maxRemoved,pinned:[...s.pinned],maxCandidates:128},s.limits);
  if(s.custom&&s.keep.size>0&&s.keep.size<o.legs.length){
    const legs=o.legs.filter(l=>s.keep.has(legKey(l))),variant={id:signature(o.venue,legs),venue:o.venue,legs,removed:o.legs.filter(l=>!s.keep.has(legKey(l)))};
    if(!result.rows.some(r=>r.id===variant.id)){
      const matches=matchingMarkets(variant,s.catalog),analyses=matches.map(m=>analyze(o,m,variant,s.catalog,s.limits));
      analyses.sort((a,b)=>Number(b.eligible)-Number(a.eligible)||(a.buy?.value??Infinity)-(b.buy?.value??Infinity));result.rows.unshift(analyses[0]??analyze(o,null,variant,s.catalog,s.limits));
    }
    s.selectedVariant=variant.id;
  }
  result.rows=sortAlternatives(result.rows,s.sort,s.direction);return result;
}
function selectedRow(){const c=compare();return c.rows.find(r=>r.id===s.selectedVariant)||c.rows[0]||null;}
function pick(key){s.maxRemoved=1;s.selected=key;s.pinned.clear();s.custom=false;s.selectedVariant=null;s.keep=new Set(original()?.legs.map(legKey)||[]);s.page='optimizer';s.auto=false;}
let requestAbort=null,stopRequested=false;
async function json(url){if(disposed)throw new Error('Combos page closed');return transport(url,requestAbort?AbortSignal.any([requestAbort.signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000));}
function merge(markets){const map=new Map(s.catalog.markets.map(m=>[marketKey(m),m]));for(const m of markets){const old=map.get(marketKey(m));const sameRules=old&&JSON.stringify([old.legs,old.rules,old.payout])===JSON.stringify([m.legs,m.rules,m.payout]);map.set(marketKey(m),sameRules?{...m,rulesVerified:old.rulesVerified,productSettlement:old.productSettlement,fee:old.fee}:m);}s.catalog=validateCatalog({version:1,markets:[...map.values()]});rememberTickers(markets);}
async function paperChange(fn){
  if(disposed)throw new Error('Combos page closed');
  if(s.storageError)throw new Error('Resolve the local ledger storage problem first');
  if(!navigator.locks)throw new Error('Paper execution requires a browser with Web Locks support');
  await navigator.locks.request(storageKey+'-writer',{ifAvailable:true},async lock=>{if(!lock)throw new Error('Another tab is updating the paper ledger');const raw=localStorage.getItem(storageKey),current=raw?validateLedger(JSON.parse(raw)):emptyLedger(),next=fn(current);validateLedger(next);localStorage.setItem(storageKey,JSON.stringify(next));s.ledger=next;});
}
async function work(fn){if(s.busy||disposed||!workspaceActive)return;s.busy=true;requestAbort=new AbortController();s.error='';render();try{await fn();}catch(e){if(!stopRequested)s.error=e.message;s.auto=false;}finally{requestAbort=null;if(stopRequested){try{await paperChange(cancelPending);s.notice='Stopped. Pending paper orders cancelled. Existing paper positions remain open.';}catch(e){s.error=e.message;}stopRequested=false;}s.busy=false;render();}}
function download(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function refresh(){
  if(s.source==='sample'){merge((await json('/api/sample')).markets);}
  else if(s.source==='kalshi'){
    const o=original();if(!o)throw new Error('Select a combo first');
    const c=compare();const ids=[...new Set([o.id,...o.legs.map(l=>l.marketId),...c.rows.map(r=>r.candidate?.id).filter(id=>id&&!id.endsWith('::NO'))])];
    const chosen=ids.slice(0,40),result=await json(`/api/kalshi/snapshot?ids=${encodeURIComponent(chosen.join(','))}`);
    merge(result.markets);if(result.errors.length)throw new Error(`Some quotes could not refresh: ${result.errors.map(e=>`${e.id}: ${e.error}`).join('; ')}`);
    if(ids.length>40)s.notice='Refreshed the first 40 instruments. Unrefreshed alternatives keep their original timestamps and may be stale.';
  }else throw new Error('Imported quotes cannot be refreshed automatically. Import a new timestamped catalog or enter a manual quote.');
  if(!stopRequested&&s.ledger.pending.length)await paperChange(current=>processPending(current,s.catalog));
}
// Search a bounded batch instead of treating the first (often zero-OI) page as the market.
async function discover(maxPages,suffix=null){
  let reason='Page budget reached';
  const seen=new Set();
  for(let page=0;page<maxPages&&!stopRequested&&!disposed;page++){
    // Leave room for leg books and reduced combos within the 10,000-instrument catalog.
    if(s.catalog.markets.length+200>9600){reason='Local catalog limit reached; export or reload to start a new scan';break;}
    const cursor=s.cursor||'';
    if(seen.has(cursor))throw new Error('Kalshi repeated a pagination cursor. Loaded results are retained; reload to retry.');
    seen.add(cursor);
    const result=await json('/api/kalshi/markets'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
    merge(result.markets);s.cursor=result.cursor;s.pages++;
    const matches=scan(s.catalog,s.filters).length;
    s.notice=`Searching: ${s.pages} pages loaded, ${matches} matches. Stop keeps loaded results.${result.warnings?.length?` ${result.warnings.length} unsupported records skipped on this page.`:''}`;
    render();
    if(suffix&&resolveComboTickers(suffix,tickerIndex).length){reason='Suffix found';break;}
    if(!s.cursor){reason='End of listing reached';break;}
  }
  if(!stopRequested)s.notice=`${reason}. ${s.pages} pages loaded; ${scan(s.catalog,s.filters).length} matches. ${s.cursor?'Search more pages to continue. Results are not exchange-wide.':''} Listing quotes require a book refresh.`;
}
async function lookupTicker(){
  s.auto=false;
  const {kind,query}=comboQuery(s.filters.search);s.lookupIds=[];
  if(kind==='text'){s.notice='Text search filters loaded markets. Enter a full combo ticker or its last 9 characters for direct lookup.';return;}
  let ids=resolveComboTickers(query,[...tickerIndex,...s.catalog.markets.filter(m=>m.venue==='kalshi').map(m=>m.id)]);
  if(!ids.length){
    if(s.source!=='kalshi'){
      if(s.ledger.pending.length)await paperChange(cancelPending);
      s.catalog={version:1,markets:[]};s.source='kalshi';s.cursor=null;s.pages=0;s.selected=null;
    }
    if(!s.pages||s.cursor)await discover(20,query);
    if(stopRequested||disposed)return;
    ids=resolveComboTickers(query,tickerIndex);
  }
  if(!ids.length){s.notice=`Suffix ${query} was not found in known or searched tickers. This is not an exchange-wide suffix index. Paste the full ticker once to look it up directly and remember its suffix, or search more pages.`;return;}
  if(ids.length>1){
    s.notice=`${ids.length} tickers share suffix ${query}. Paste the exact full ticker to choose: ${ids.join(', ')}`;return;
  }
  const result=await json('/api/kalshi/market?ticker='+encodeURIComponent(ids[0]));
  if(stopRequested||disposed)return;
  if(s.source!=='kalshi'){
    if(s.ledger.pending.length)await paperChange(cancelPending);
    s.catalog={version:1,markets:[]};s.source='kalshi';s.cursor=null;s.pages=0;s.selected=null;
  }
  merge(result.markets);s.lookupIds=result.markets.map(marketKey);
  s.notice='Direct ticker match shown below, independently of scanner filters. Select it to inspect its legs; refresh books for executable prices.';
}
function lookupResults(){
  const matches=s.catalog.markets.filter(m=>s.lookupIds.includes(marketKey(m)));
  if(!matches.length)return '';
  return `<section class="panel padded"><h2>Direct ticker match</h2><p class="note">Shown regardless of open interest, expiration, leg-count filters, or top-100 rank.</p>${matches.map(m=>`<div class="paper-row"><button class="text-select" data-market="${esc(marketKey(m))}">${esc(m.title)}</button><p class="note">${esc(m.id)}</p><p class="note">${m.legs.length} legs · ${esc(m.status)} · OI ${number(m.openInterest)} · Expires ${when(m.expiration)}</p></div>`).join('')}</section>`;
}
function fold(id,label,body,cls=''){
  return `<details data-disclosure="${id}" class="${cls}" ${disclosures.has(id)?'open':''}><summary>${label}</summary>${body}</details>`;
}
function sourceControls(){return `<div class="actions">${button('live',s.source==='kalshi'?'Reload markets':'Load markets',s.busy||s.auto,'primary')}${s.cursor?button('scan-pages','Search more',s.busy||s.auto):''}${button('price-visible','Refresh match prices',s.busy||s.auto||s.source!=='kalshi')}${fold('data-tools','Data options',`<div class="actions">${button('sample','Load synthetic examples',s.busy||s.auto)}<label class="button">Import catalog<input id="import-file" class="sr-only" type="file" accept="application/json" ${s.busy||s.auto?'disabled':''}></label>${button('export','Export workspace',s.busy||!s.catalog.markets.length)}</div>`,'data-tools')}</div>`;}
function scanner(){
  const rows=scan(s.catalog,s.filters),f=s.filters,diagnostics=scanDiagnostics(s.catalog,f),oi=diagnostics.otherFilters;
  const opts=(values,value)=>values.map(([v,l])=>`<option value="${v}" ${v===value?'selected':''}>${l}</option>`).join('');
  const advanced=`<div class="more-filters"><label class="field">Volume period<select data-filter="volumePeriod">${opts([['total','Total'],['24h','Last 24 hours']],f.volumePeriod)}</select></label><label class="field">Venue<select data-filter="venue">${opts([['all','All loaded venues'],['kalshi','Kalshi'],['polymarket-us','Polymarket US']],f.venue)}</select></label><label class="field">Expiration basis<select data-filter="expiryBasis">${opts([['combo','Combo expiration'],['first-leg','First leg expiration']],f.expiryBasis)}</select></label><label class="field">Order<select data-filter="direction">${opts([['asc','Ascending / earliest first'],['desc','Descending / largest first']],f.direction)}</select></label><label class="field">Maximum legs<input data-filter="maxLegs" type="number" min="2" max="32" value="${f.maxLegs}"></label>${button('reset-filters','Reset defaults',s.busy)}</div>`;
  const advancedCount=['volumePeriod','venue','expiryBasis','direction','maxLegs'].filter(k=>f[k]!==DEFAULT_FILTERS[k]).length;
  return `<div class="hero"><div><h1>Find combos</h1><p>Compare bids, asks, and the cost of each leg.</p></div>${sourceControls()}</div>
  ${lookupResults()}<section class="panel scanner-panel">
  <fieldset class="filter-fields" ${s.busy?'disabled':''}><div class="filters"><label class="field">Search<input data-filter="search" value="${esc(f.search)}" placeholder="Title, ticker, or last 9 characters"><small>Press Enter to look up a ticker</small></label><label class="field">Minimum open interest<input data-filter="minOI" type="number" min="0" value="${f.minOI}"></label><label class="field">Expires within (hours)<input data-filter="hours" type="number" min="1" value="${f.hours}"></label><label class="field">Minimum volume<input data-filter="minVolume" type="number" min="0" value="${f.minVolume}"></label><label class="field">Sort by<select data-filter="sort">${opts([['expiration','First expiration'],['openInterest','Open interest'],['volume','Volume'],['gap','Bid − leg ask product'],['bid','Combo bid'],['ask','Combo ask'],['legs','Leg count']],f.sort)}</select></label></div>
  ${fold('filters',`More filters${advancedCount?` · ${advancedCount} changed`:''}`,advanced,'filter-disclosure')}</fieldset>
  <div class="results-bar"><strong>Showing ${number(Math.min(100,rows.length))} of ${number(rows.length)} matches</strong><span>${number(diagnostics.loaded.total)} combos loaded</span><span>Highest OI: ${number(diagnostics.loaded.max)}</span>${badge(s.source==='sample'?'SYNTHETIC':s.source==='kalshi'?'KALSHI':s.source==='import'?'IMPORTED':'NO DATA',s.source==='sample'?'amber':'')}</div>
  ${rows.length?`<div class="table-wrap"><table><thead><tr><th>Combo</th><th>Legs</th><th>Open interest</th><th>${f.volumePeriod==='24h'?'24h':'Total'} volume</th><th>Expiration · Denver</th><th>Bid</th><th>Ask</th><th>Leg ask product</th><th>Bid − product</th></tr></thead><tbody>${rows.slice(0,100).map(m=>`<tr class="click-row" data-market="${esc(marketKey(m))}"><td class="name"><button class="text-select" data-market="${esc(marketKey(m))}">${esc(m.title)}</button><small>${esc(m.venue)} · ${esc(m.id)}</small></td><td>${m.legs.length}</td><td>${number(m.openInterest)}</td><td>${number(f.volumePeriod==='24h'?m.volume24h:m.volume)}</td><td>${when(m.expirationForFilter)}</td><td>${px(m.bid)}</td><td>${px(m.ask)}</td><td>${px(m.product)}</td><td class="${sign(m.gap)}">${px(m.gap)}</td></tr>`).join('')}</tbody></table></div>`:`<div class="empty"><strong>${s.catalog.markets.length?'No loaded combos match these filters':'Start with a market catalog'}</strong><p>${s.catalog.markets.length?(oi.total&&f.minOI>0?`None of the ${number(oi.total)} loaded combos passing your other filters meets minimum OI ${number(f.minOI)}. Highest reported OI in that group: ${number(oi.max)}. `:'No loaded combos pass your other filters. ')+(s.cursor?'Search more pages to continue; this is not a search of the entire exchange. ':'Review expiration, volume, search, and leg-count filters. ')+ 'Unknown OI is shown as — and cannot satisfy a positive minimum.':'Load synthetic examples to try the complete workflow, load public Kalshi markets, or import a catalog from either app.'}</p></div>`}
  <div class="caption">${s.source==='kalshi'?`${s.pages} pages searched · ${s.cursor?'Partial results. Search more to continue.':'End of listing.'}`:'Prices in cents per $1 contract · Open interest and volume in contracts.'} ${f.sort==='openInterest'&&f.direction==='desc'?'Top 100 by open interest among loaded matches.':'Showing up to 100 matches in your selected order.'}
  ${fold('diagnostics','Search details',`<p class="note" data-oi-diagnostics>Loaded combos: ${number(diagnostics.loaded.total)}; highest reported OI: ${number(diagnostics.loaded.max)}. After other filters: ${number(oi.total)} combos — ${number(oi.positive)} with positive OI, ${number(oi.zero)} with zero OI, ${number(oi.unknown)} unknown; highest OI: ${number(oi.max)}. OI is the combo’s own contract count. Set minimum OI to 0 for any value.</p><p class="note">Products use each required outcome’s ask. Missing or stale quotes show —. The leg product is a comparison benchmark, not an executable hedge cost.</p>${s.cursor?`<div class="actions gap-top">${button('more','Load next 200 markets',s.busy||s.auto)}</div>`:''}`)}</div></section>`;
}
function optimizer(){
  const o=original();if(!o)return `<div class="empty"><strong>Select a combo in the scanner</strong><p>The leg editor, fresh quote comparison, and hedge scenarios appear here.</p>${button('go-scanner','Open scanner')}</div>`;
  const c=compare(),row=c.rows.find(r=>r.id===s.selectedVariant)||c.rows[0],product=legProduct(o,s.catalog);const frozen=s.auto||s.busy;
  return `<div class="hero"><div><h1>Build a hedge</h1><p>${esc(o.title)} · ${esc(o.venue)}</p></div><div class="actions">${button('refresh','Refresh selected quotes',frozen||!['sample','kalshi'].includes(s.source),'primary')}${button('go-scanner','Back to scanner',s.auto)}</div></div>
  <div class="stats">${stat('Original bid · sell reference',px(o.bid))}${stat('Original ask',px(o.ask))}${stat('Required-leg ask product',px(product))}${stat('Compared alternatives',c.rows.length)}</div>
  <div class="split"><section class="panel"><div class="panel-head"><div><h2>Leg editor</h2><p>Uncheck to remove. Pin a leg to keep it in every generated alternative.</p></div></div><div class="padded">${o.legs.map(l=>{const q=legMarket(l,o,s.catalog);return `<div class="leg"><input aria-label="Keep ${esc(l.title||l.marketId)}" type="checkbox" data-keep="${esc(legKey(l))}" ${s.keep.has(legKey(l))?'checked':''} ${frozen||s.pinned.has(legKey(l))?'disabled':''}><div><strong>${esc(l.title||l.marketId)}</strong><small>${esc(l.outcome.toUpperCase())} · Bid ${px(q?.bid)} / Ask ${px(q?.ask)}</small></div><label class="pin"><input type="checkbox" aria-label="Pin ${esc(l.title||l.marketId)}" data-pin="${esc(legKey(l))}" ${s.pinned.has(legKey(l))?'checked':''} ${frozen?'disabled':''}>Pin</label></div>`;}).join('')}
  <div class="two gap-top"><label class="field">Maximum legs to remove<select id="max-removed" ${frozen?'disabled':''}>${[1,2,3,4].filter(n=>n<o.legs.length).map(n=>`<option ${n===s.maxRemoved?'selected':''}>${n}</option>`).join('')}</select></label><label class="field">Contracts<input data-limit="quantity" type="number" min="1" step="1" value="${s.limits.quantity}" ${frozen?'disabled':''}></label></div><div class="actions gap-top">${button('compare-all','Compare all removals',frozen)}${button('compare-custom','Compare checked legs',frozen||s.keep.size===0||s.keep.size===o.legs.length)}</div><p class="note gap-top">Each alternative is a separate instrument. Unchecking a leg does not change an existing position. ${c.truncated?'Search stopped at 128 alternatives; pin legs or reduce the removal limit to narrow it.':''}</p></div></section>
  <section class="panel"><div class="panel-head"><div><h2>Selected hedge</h2><p>${row?`Remove ${esc(row.removed.map(l=>l.title||l.marketId).join(' + '))}`:'Choose an alternative'}</p></div>${row?badge(row.eligible?'PAPER CHECKS PASS':row.candidate?'CHECKS REQUIRED':'QUOTE REQUIRED',row.eligible?'green':'amber'):''}</div><div class="padded">${row?`<div class="stats">${stat('Hedge ask',px(row.candidate?.ask))}${stat('Ask change vs original',px(row.askDelta),sign(row.askDelta==null?null:-row.askDelta))}${stat('Hedge buy cost + fees',row.buy&&row.buy.fee!==null?money(row.buy.value+row.buy.fee):'—')}${stat('Conservative capital',money(row.capital))}</div><div class="two"><div><h3>Worst-case model P&L</h3><p class="${sign(row.worst)}">${money(row.worst)}</p></div><div><h3>Best-case model P&L</h3><p class="${sign(row.best)}">${money(row.best)}</p></div></div><p class="note gap-top">${number(s.limits.quantity)} contracts per side. Original short is modeled as buying its NO at 1 − YES bid; hedge buys the reduced combo’s YES. No cross-margin credit is assumed. Fees and configured adverse slippage are included.</p>${row.reasons.length?`<ul class="reason">${row.reasons.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>`:''}<div class="actions gap-top">${button('paper','Preview paper order',frozen||!row.eligible||s.storageError,'primary')}${button('draft','Save draft',frozen)}${button('create-market','Create / find on Kalshi',frozen||s.source!=='kalshi'||row.legs.length<2)}</div>${fold('quote-tools','Quotes & model assumptions',`<div class="actions gap-top">${button('rfq-original','Request original quote',frozen||s.source!=='kalshi')}${button('rfq-hedge','Request hedge quote',frozen||s.source!=='kalshi'||!row.candidate||row.candidate.source!=='live')}${button('manual-quote','Enter received quote',frozen)}${button('review','Review rules / fees',frozen||!row.candidate)}</div>`)}<details><summary>Scenario payoff and quote provenance</summary><p class="note gap-top">Original quote: ${when(o.quoteAt)} (${esc(o.source)}). Hedge quote: ${when(row.candidate?.quoteAt)} (${esc(row.candidate?.source||'unavailable')}). This model assumes both orders fill. Failed or partial live fills are not covered by this payoff bound; live order execution is disabled.</p>${row.worst!==null?scenarios(o,row):'<p>No scenario P&L until both quotes, full depth and fee assumptions are supplied.</p>'}</details>`:'<p class="note">No removable legs remain.</p>'}</div></section></div>
  <section class="panel"><div class="panel-head"><div><h2>Alternative combinations</h2><p>Sorted by full hedge purchase cost after fees. Prices are quote-based; leg products remain comparison benchmarks.</p></div><div class="actions"><select aria-label="Alternative sort" id="alt-sort">${[['cost','Hedge cost + fees'],['change','Ask change'],['gap','Original bid − hedge ask'],['worst','Worst-case P&L'],['capital','Capital required'],['product','Leg ask product']].map(([v,l])=>`<option value="${v}" ${s.sort===v?'selected':''}>${l}</option>`).join('')}</select><select aria-label="Alternative order" id="alt-direction"><option value="asc" ${s.direction==='asc'?'selected':''}>Ascending</option><option value="desc" ${s.direction==='desc'?'selected':''}>Descending</option></select></div></div>
  <div class="table-wrap"><table><thead><tr><th>Removed legs</th><th>Remaining</th><th>Bid</th><th>Ask</th><th>Ask change</th><th>Leg ask product</th><th>Original bid − ask</th><th>Hedge cost + fees</th><th>Worst P&L</th><th>Status</th></tr></thead><tbody>${c.rows.map(r=>`<tr class="click-row ${r.id===row?.id?'selected':''}" data-variant="${esc(r.id)}"><td class="name"><button class="small-btn" data-variant="${esc(r.id)}">${esc(r.removed.map(l=>l.title||l.marketId).join(' + '))}</button></td><td>${r.legs.length}</td><td>${px(r.candidate?.bid)}</td><td>${px(r.candidate?.ask)}</td><td>${px(r.askDelta)}</td><td>${px(r.product)}</td><td class="${sign(r.gap)}">${px(r.gap)}</td><td>${r.buy&&r.buy.fee!==null?money(r.buy.value+r.buy.fee):'—'}</td><td class="${sign(r.worst)}">${money(r.worst)}</td><td>${badge(r.eligible?'Paper-ready':r.candidate?'Review':'Quote required',r.eligible?'green':'amber')}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function scenarios(o,row){if(o.legs.length>12)return '<p class="note gap-top">The full scenario table is limited to 12 legs. For this larger combo, the displayed subset payoff bounds are calculated without enumerating every outcome.</p>';const rows=scenarioTable(o,row.legs,row.net,s.limits.quantity);return `<div class="scenario-scroll gap-top"><table><thead><tr>${o.legs.map((l,i)=>`<th>Leg ${i+1} YES settlement</th>`).join('')}<th>Net P&L</th></tr></thead><tbody>${rows.slice(0,64).map(r=>`<tr>${o.legs.map(l=>`<td>${r.values[l.marketId]}</td>`).join('')}<td class="${sign(r.pnl)}">${money(r.pnl)}</td></tr>`).join('')}</tbody></table></div><p class="note">Showing ${Math.min(64,rows.length)} of ${rows.length} binary scenarios. With matching product-settlement rules, scalar settlements in [0,1] are also bounded by the displayed worst/best cases. Some binary combinations may be impossible due to related events; no independence assumption is needed for the subset payoff bound.</p>`;}
function paperPage(){
  let t;try{t=totals(s.ledger);}catch(e){return `<div class="notice error">${esc(e.message)}</div>`;}
  return `<div class="hero"><div><h1>Paper trading</h1><p>Manual approval or automatic paper monitoring. No exchange orders are submitted.</p></div>${button('kill','Stop & cancel pending',false,'danger')}</div><div class="stats">${stat('Free simulated cash',money(t.free))}${stat('Reserved capital',money(t.reserved))}${stat('Realized paper P&L',money(t.realized),sign(t.realized))}${stat('Daily gross losses · Denver',money(t.dailyLoss))}</div>
  <section class="panel padded"><div class="detail-title"><h2>Limits for the next paper order</h2>${badge(s.auto?'AUTOMATIC PAPER ON':'AUTOMATIC PAPER OFF',s.auto?'green':'')}</div><div class="three">${[['quantity','Contracts per side'],['maxCapital','Maximum capital per trade ($)'],['maxTotalCapital','Maximum total capital ($)'],['maxPerUnderlying','Maximum underlying/event capital ($)'],['minWorstPnl','Minimum worst-case P&L ($)'],['maxDailyLoss','Daily realized loss stop ($)'],['maxQuoteAgeSec','Maximum quote age (seconds)'],['maxQuoteSkewSec','Maximum quote time difference (seconds)'],['maxSpread','Maximum bid/ask spread ($)'],['slippage','Adverse price allowance per side ($)']].map(([k,l])=>`<label class="field">${l}<input data-limit="${k}" type="number" step="${['quantity','maxQuoteAgeSec','maxQuoteSkewSec'].includes(k)?'1':'.001'}" value="${s.limits[k]}" ${s.auto||s.busy?'disabled':''}></label>`).join('')}</div><div class="actions gap-top">${button('auto',s.auto?'Disable automatic paper':'Enable automatic paper',s.busy||!original()||!['sample','kalshi'].includes(s.source)||s.storageError,'primary')}${button('refresh','Refresh & process pending',s.busy||s.auto||!original()||!['sample','kalshi'].includes(s.source))}${button('export-ledger','Export paper ledger',s.busy)}</div><p class="note gap-top">Automatic mode monitors the selected combo and current removal constraints every 15 seconds while this tab is visible. It queues the lowest-cost eligible alternative, then requires a later observation of both books before simulating a fill. Import/manual quotes require manual paper approval. Missing rules, fees, depth or timestamps block the trade. The paper simulator assumes both sides fill; it does not model live order rejection or partial-fill recovery.</p></section>
  <section class="panel"><div class="panel-head"><h2>Pending and open paper positions</h2><span class="muted">${t.active.length} active</span></div><div class="padded">${s.ledger.pending.map(p=>`<div class="paper-row"><h3>${esc(p.original.id)} → ${esc(p.candidate.id)}</h3><p class="note">Pending next qualifying quotes · reserved ${money(p.capital)} · expires after 60 seconds</p></div>`).join('')}${s.ledger.positions.slice().reverse().map(p=>`<div class="paper-row"><div class="detail-title"><h3>${esc(p.original.id)} → ${esc(p.hedge.id)}</h3>${badge(p.status,p.status==='settled'?'':'green')}</div><p class="note">${p.qty} contracts per side · ${esc(p.source)} · capital ${money(p.capital)} · entry net ${money(p.net)}${p.status==='settled'?` · realized ${money(p.realized)}`:''}</p>${p.status==='open'?`<div class="actions"><button data-settle="${esc(p.id)}" ${s.busy?'disabled':''}>Enter simulated settlement</button></div>`:''}</div>`).join('')}${!s.ledger.pending.length&&!s.ledger.positions.length?'<p class="note">No paper orders yet. Select a combo and preview an eligible reduced-leg hedge.</p>':''}</div></section><section class="panel"><div class="panel-head"><h2>Audit trail</h2><small>Latest 30 events</small></div><div class="table-wrap"><table><thead><tr><th>Time · Denver</th><th>Event</th><th>Details</th></tr></thead><tbody>${s.ledger.events.slice(-30).reverse().map(e=>`<tr><td>${when(e.at)}</td><td>${esc(e.type)}</td><td class="name">${esc(e.reason||e.assumption||e.original||e.id)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function draftsPage(){return `<div class="hero"><div><h1>Saved drafts</h1><p>Retained outcomes ready for a venue’s create-and-quote workflow.</p></div>${button('export-drafts','Export all drafts',!s.drafts.length||s.busy)}</div><div class="notice warning">These drafts are saved locally. They do not create instruments at an exchange or request RFQs. Select an alternative in the optimizer to create its Kalshi instrument and request quotes. No quote is accepted automatically.</div>${s.drafts.length?s.drafts.map((d,i)=>`<section class="panel padded"><div class="detail-title"><h2>${esc(d.venue)} · ${d.legs.length} legs</h2><button data-draft-export="${i}">Export draft</button></div><p class="note">From ${esc(d.parentId)}</p><div class="gap-top">${d.legs.map(l=>`<span class="pill">${esc(l.outcome.toUpperCase())} ${esc(l.marketId)}</span>`).join('')}</div></section>`).join(''):'<div class="empty"><strong>No drafts yet</strong><p>Remove a leg in the optimizer and select Save draft.</p></div>'}`;}
function render(){
  if(disposed)return;
  for(const d of root.querySelectorAll('details[data-disclosure]')){if(d.open)disclosures.add(d.dataset.disclosure);else disclosures.delete(d.dataset.disclosure);}
  let content;try{content=s.page==='scanner'?scanner():s.page==='optimizer'?optimizer():s.page==='paper'?paperPage():draftsPage();}catch(e){content=`<div class="notice error">${esc(e.message)}</div>`;}
  root.innerHTML=`<div class="shell"><header class="topbar"><nav aria-label="Combo workflow">${[['scanner','Find combos'],['optimizer','Build hedge'],['paper','Paper trading'],['drafts','Saved drafts']].map(([id,label])=>`<button data-page="${id}" aria-current="${s.page===id?'page':'false'}" class="${s.page===id?'active':''}">${label}</button>`).join('')}</nav><div class="actions">${s.busy?badge('WORKING…','amber'):''}${badge(s.auto?'AUTO PAPER ACTIVE':'PAPER ONLY',s.auto?'green':'')}${button('kill','Stop',!s.busy&&!s.auto&&!s.ledger.pending.length,'danger')}</div></header><main>${s.error?`<div class="notice error" role="alert">${esc(s.error)}</div>`:''}${s.notice?`<div class="notice compact-notice" role="status"><span>${esc(s.notice)}</span>${button('dismiss-notice','Dismiss',s.busy)}</div>`:''}${s.source==='sample'?'<div class="notice warning">Synthetic examples · Invented prices for testing.</div>':''}${content}${rfqPanel()}</main></div>`;
}
function modal(html,onSubmit){dialog.innerHTML=html;dialog.showModal();dialog.querySelector('[data-close]')?.addEventListener('click',()=>dialog.close());dialog.querySelector('form')?.addEventListener('submit',e=>{e.preventDefault();const form=new FormData(e.target);dialog.close();work(()=>onSubmit(form));});}
function previewPaper(){const o=original(),r=selectedRow();if(!o||!r?.eligible)throw new Error('A fresh, eligible alternative is required');const snapshot=JSON.stringify([o,r.candidate,s.limits]);modal(`<form><h2>Confirm paper order</h2><p>Simulate ${s.limits.quantity} original NO contracts and ${s.limits.quantity} reduced-combo YES contracts.</p><div class="stats">${stat('Reserved capital',money(r.capital))}${stat('Worst-case model P&L',money(r.worst))}</div><p class="note">Both books must be observed again after approval. This submits no exchange orders. Limits freeze for this pending order.</p><div class="dialog-actions"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Queue paper order</button></div></form>`,async()=>{const fresh=selectedRow();if(JSON.stringify([original(),fresh?.candidate,s.limits])!==snapshot)throw new Error('Quotes or settings changed; preview again');await paperChange(current=>queuePaper(current,original(),fresh,s.limits));s.notice='Paper order queued. Refresh quotes to evaluate the next observation.';});}
function quoteDialog(){const o=original(),r=selectedRow();if(!r)return;modal(`<form><h2>Enter a received quote</h2><p class="note">For the exact ${r.legs.length} retained outcomes. This is a manually entered quote, not a live exchange connection. It cannot trigger automatic paper execution.</p><div class="two"><label class="field">Bid (dollars)<input name="bid" type="number" min="0" max="1" step=".0001" required></label><label class="field">Ask (dollars)<input name="ask" type="number" min="0" max="1" step=".0001" required></label><label class="field">Bid size<input name="bidSize" type="number" min="0" required></label><label class="field">Ask size<input name="askSize" type="number" min="0" required></label></div><label class="field">Fee coefficient θ (estimate)<input name="rate" type="number" min="0" max="1" step=".0001" required></label><label class="check"><input name="rules" type="checkbox" required>I verified that this instrument uses these exact outcomes and a $1 product-settlement payout.</label><p class="note">Close and expiration times initially inherit the original’s conservative dates; review the exported draft against the actual contract before any real integration.</p><div class="dialog-actions"><button type="button" data-close>Cancel</button><button class="primary">Save manual quote</button></div></form>`,async f=>{const m={...o,id:r.candidate?.source==='manual'?r.candidate.id:`MANUAL-${crypto.randomUUID()}`,title:`Manual quote: ${r.legs.length} retained legs`,legs:r.legs,openInterest:null,volume:null,volume24h:null,bid:Number(f.get('bid')),ask:Number(f.get('ask')),bidSize:Number(f.get('bidSize')),askSize:Number(f.get('askSize')),bids:undefined,asks:undefined,quoteAt:Date.now(),source:'manual',fee:{rate:Number(f.get('rate')),rounding:'ceil'},rulesVerified:true,productSettlement:true};merge([m]);s.notice='Manual quote added. Automatic paper mode will not use it.';});}
function reviewDialog(){const o=original(),r=selectedRow();if(!r?.candidate)return;modal(`<form><h2>Review model assumptions</h2><p class="note">Confirm the exact original and hedge terms. These are local modeling assumptions, not verification by the exchange.</p><details><summary>Original supplied rules</summary><pre>${esc(o.rules||'No contract rule text supplied. Verify it in your exchange app.')}</pre></details><details><summary>Hedge supplied rules</summary><pre>${esc(r.candidate.rules||'No contract rule text supplied. Verify it in your exchange app.')}</pre></details><div class="two"><label class="field">Original taker fee coefficient θ<input name="originalRate" type="number" min="0" max="1" step=".0001" value="${o.fee?.rate??''}" required></label><label class="field">Hedge taker fee coefficient θ<input name="hedgeRate" type="number" min="0" max="1" step=".0001" value="${r.candidate.fee?.rate??''}" required></label></div><label class="field">Fee rounding<select name="rounding"><option value="ceil">Round up to cent (conservative)</option><option value="half-even">Half-even cents</option></select></label><label class="check"><input type="checkbox" required>I checked that the original and hedge use identical retained outcomes, $1 maximum payouts and product settlement, including exceptional/partial settlements.</label><div class="dialog-actions"><button type="button" data-close>Cancel</button><button class="primary">Save model assumptions</button></div></form>`,async f=>{for(const [m,field] of [[o,'originalRate'],[r.candidate,'hedgeRate']]){const base=s.catalog.markets.find(x=>marketKey(x)===marketKey(m)|| (m.id.endsWith('::NO')&&x.venue===m.venue&&x.id===m.id.slice(0,-4)));if(!base)throw new Error('Instrument disappeared');base.fee={rate:Number(f.get(field)),rounding:f.get('rounding')};base.productSettlement=true;base.rulesVerified=true;}validateCatalog(s.catalog);s.notice='Local fee and settlement assumptions saved; quotes still require independent freshness and depth checks.';});}
function settlementDialog(id){const p=s.ledger.positions.find(p=>p.id===id);if(!p)return;modal(`<form><h2>Simulated settlement</h2><p class="note">Enter the underlying YES settlement values, including fractional values if applicable. This updates only the local paper ledger.</p>${p.original.legs.map((l,i)=>`<label class="field">${esc(l.title||l.marketId)} · YES value<input name="v${i}" type="number" min="0" max="1" step=".0001" required></label>`).join('')}<div class="dialog-actions"><button type="button" data-close>Cancel</button><button class="primary">Settle paper position</button></div></form>`,async f=>{const values=Object.fromEntries(p.original.legs.map((l,i)=>[l.marketId,Number(f.get(`v${i}`))]));await paperChange(current=>settlePaper(current,id,values));s.notice='Paper position settled using your supplied values.';});}
function creationDialog(){
  const o=original(),r=selectedRow();if(!o||!r)return;
  let request;try{request=createComboRequest(o,r);}catch(e){s.error=e.message;render();return;}
  const frozen=JSON.stringify([o.id,r.id,request]);
  modal(`<form><h2>Create reduced combo on Kalshi</h2><p>This sends a real instrument-creation request using your Key Vault. It does not place a trade.</p><p class="note">Collection: ${esc(o.collection)}. Creating instruments may consume your exchange quota; only this selected alternative is requested.</p><ul>${r.legs.map(l=>`<li>${esc(l.outcome.toUpperCase())} ${esc(l.marketId)}</li>`).join('')}</ul><div class="dialog-actions"><button type="button" data-close>Cancel</button><button class="primary">Create / find this combo</button></div></form>`,async()=>{
    if(frozen!==JSON.stringify([original()?.id,selectedRow()?.id,createComboRequest(original(),selectedRow())]))throw new Error('Selection changed; preview again');
    const info=await authFetch(request.path,'GET',null),collection=info.multivariate_contract;
    if(!collection||collection.collection_ticker!==o.collection)throw new Error('Collection identity could not be verified');
    if(collection.is_ordered!==false)throw new Error('Ordered or unspecified collection semantics are unsupported');
    if(!Number.isFinite(collection.size_min)||!Number.isFinite(collection.size_max)||r.legs.length<collection.size_min||r.legs.length>collection.size_max)throw new Error('Retained leg count is outside verified collection limits');
    if(collection.is_all_yes&&r.legs.some(l=>l.outcome==='no'))throw new Error('This collection only supports YES selections');
    if(disposed||stopRequested)throw new Error('Creation stopped before submission');
    const response=await authFetch(request.path,'POST',request.body);
    let raw=response.market;
    if(!raw&&response.market_ticker){const result=await authFetch('/markets/'+encodeURIComponent(response.market_ticker),'GET',null);raw=result.market;}
    if(!raw)throw new Error('Creation returned no market; inspect Kalshi before retrying');
    const m=validateCreatedMarket(raw,r);merge([m]);s.notice=`Kalshi instrument ${m.id} is available. Request a quote or refresh its book; a computed leg product is not its price.`;
  });
}
function rfqDialog(m){
  if(!m||m.source!=='live'||m.venue!=='kalshi'||m.id.endsWith('::NO')){s.error='Choose an actual live YES instrument';render();return;}
  try{validateLimits(s.limits);}catch(e){s.error=e.message;render();return;}
  const quantity=s.limits.quantity;
  if(s.rfqs.length>=10){s.error='Cancel an RFQ before adding another (10 per session maximum)';render();return;}
  modal(`<form><h2>Request a real quote</h2><p>${esc(m.id)} · ${quantity} contracts</p><p class="note">This sends an RFQ to Kalshi. It does not accept a price or execute a trade. Returned maker quotes appear below separately from public-book prices.</p><div class="dialog-actions"><button type="button" data-close>Cancel</button><button class="primary">Send RFQ</button></div></form>`,async()=>{
    if(disposed||stopRequested)throw new Error('RFQ stopped');
    if(s.rfqs.some(x=>x.ticker===m.id&&x.quantity===quantity))throw new Error('An RFQ for this instrument and quantity is already tracked');
    const response=await authFetch('/communications/rfqs','POST',{market_ticker:m.id,contracts_fp:quantity.toFixed(2),rest_remainder:false,replace_existing:false});
    const id=response.rfq_id||response.rfq?.id||response.id;if(!id)throw new Error('RFQ submitted but no ID returned; inspect the account before retrying');
    s.rfqs.push({id,ticker:m.id,quantity,quotes:[],createdAt:Date.now()});s.notice=`RFQ ${id} submitted. Refresh RFQ quotes to inspect responses. No trade was placed.`;
  });
}
async function refreshRfqs(){
  for(const r of s.rfqs){
    if(disposed||stopRequested)break;
    const result=await authFetch('/communications/quotes?rfq_id='+encodeURIComponent(r.id)+'&status=open&limit=100','GET',null);
    if(!Array.isArray(result.quotes))throw new Error('Unrecognized quote response');
    r.quotes=quoteObservations(result.quotes,r);r.more=!!result.cursor;
  }
}
function rfqPanel(){
  if(!s.rfqs.length)return '';
  const o=original();
  return `<section class="panel gap-top"><div class="panel-head"><div><h2>Requested Kalshi quotes</h2><p>One row per maker. Read-only comparison; no quote acceptance.</p></div>${button('refresh-rfqs','Refresh RFQ quotes',s.busy||s.auto)}</div><div class="padded">${s.rfqs.map(r=>`<div class="paper-row"><div class="detail-title"><h3>${esc(r.ticker)} · ${r.quantity} contracts</h3><button data-action="cancel-rfq" data-rfq="${esc(r.id)}" ${s.busy?'disabled':''}>Cancel RFQ</button></div><small>${esc(r.id)}</small><div class="table-wrap"><table><thead><tr><th>Maker quote</th><th>YES bid</th><th>YES ask</th><th>Size</th><th>Ask change vs original</th><th>Size / age checks</th></tr></thead><tbody>${r.quotes.map(q=>`<tr><td>${esc(q.id)}</td><td>${px(q.bid)}</td><td>${px(q.ask)}</td><td>${number(q.size)}</td><td>${px(q.ask!=null&&o?.ask!=null?q.ask-o.ask:null)}</td><td>${q.usable&&Date.now()-q.at<=30000?'Pass at last observation':'Stale, incomplete, or too small'}</td></tr>`).join('')}</tbody></table></div>${!r.quotes.length?'<p class="note">No matching quotes returned yet.</p>':''}${r.more?'<p class="note">Only the first 100 responses are shown.</p>':''}</div>`).join('')}<p class="note">RFQs are tracked for this visit. Stop cancels paper orders only; use Cancel RFQ for each live request. Leaving this page does not cancel exchange RFQs. Manage outstanding requests in your Kalshi account after leaving.</p></div></section>`;
}
root.addEventListener('click',e=>{const el=e.target.closest('button,[data-market],[data-variant]');if(!el)return;const action=el.dataset.action;
  if(el.dataset.page){s.page=el.dataset.page;render();return;}
  if(el.dataset.market){if(s.auto)return;pick(el.dataset.market);render();return;}
  if(el.dataset.variant){if(s.auto)return;s.selectedVariant=el.dataset.variant;s.custom=false;render();return;}
  if(el.dataset.settle){settlementDialog(el.dataset.settle);return;}
  if(el.dataset.draftExport){download('combo-draft.json',s.drafts[Number(el.dataset.draftExport)]);return;}
  if(!action)return;
  const menu=el.closest('details.data-tools');if(menu)menu.open=false;
  if(action==='dismiss-notice'){s.notice='';render();return;}
  if(action==='kill'&&s.busy){s.auto=false;stopRequested=true;requestAbort?.abort();s.notice='Stopping monitoring and cancelling pending paper orders…';render();return;}
  if(action==='paper'){try{previewPaper();}catch(e){s.error=e.message;render();}return;}
  if(action==='create-market'){creationDialog();return;}if(action==='rfq-original'||action==='rfq-hedge'){rfqDialog(action==='rfq-original'?original():selectedRow()?.candidate);return;}if(action==='manual-quote'){quoteDialog();return;}if(action==='review'){reviewDialog();return;}
  work(async()=>{
    if(action==='sample'){s.auto=false;if(s.ledger.pending.length)await paperChange(cancelPending);s.lookupIds=[];s.catalog=validateCatalog(await json('/api/sample'));s.source='sample';s.cursor=null;s.pages=0;s.selected=null;s.notice='Synthetic example catalog loaded. No account connection is used.';}
    if(action==='live'){
      s.auto=false;if(s.ledger.pending.length)await paperChange(cancelPending);
      s.lookupIds=[];s.catalog={version:1,markets:[]};s.cursor=null;s.pages=0;s.selected=null;s.source='kalshi';
      await discover(20);
    }
    if(action==='more'||action==='scan-pages'){
      if(s.source!=='kalshi'||!s.cursor)throw new Error('No more live pages available');
      await discover(action==='more'?1:20);
    }
    if(action==='price-visible'){
      const targets=scan(s.catalog,{...s.filters,expiryBasis:'combo'}).slice(0,20);
      const ids=[...new Set(targets.flatMap(m=>[m.id,...m.legs.map(l=>l.marketId)]))];
      if(!ids.length)throw new Error('No loaded combos match the filters; load more pages or adjust filters');
      const errors=[];
      for(let at=0;at<ids.length&&!stopRequested&&!disposed;at+=40){const result=await json('/api/kalshi/snapshot?ids='+encodeURIComponent(ids.slice(at,at+40).join(',')));merge(result.markets);errors.push(...result.errors);}
      s.notice=`Requested books for ${targets.length} combos and their legs. ${errors.length} books unavailable. Missing or stale prices remain unknown; no price is inferred.`;
    }
    if(action==='refresh')await refresh();
    if(action==='refresh-rfqs')await refreshRfqs();
    if(action==='cancel-rfq'){const id=el.dataset.rfq;await authFetch('/communications/rfqs/'+encodeURIComponent(id),'DELETE',null);s.rfqs=s.rfqs.filter(x=>x.id!==id);s.notice='RFQ cancelled.';}
    if(action==='reset-filters')s.filters={...DEFAULT_FILTERS};
    if(action==='go-scanner')s.page='scanner';
    if(action==='compare-all'){s.custom=false;s.selectedVariant=null;}
    if(action==='compare-custom')s.custom=true;
    if(action==='draft'){const r=selectedRow();if(!r)throw new Error('Choose a variant first');const d=draftFor(original(),r);if(!s.drafts.some(x=>signature(x.venue,x.legs)===signature(d.venue,d.legs))){if(s.drafts.length>=500)throw new Error('Draft limit reached; export your drafts');const next=[...s.drafts,d];localStorage.setItem(draftKey,JSON.stringify(next));s.drafts=next;}s.notice='Local combo draft saved. Exchange creation and a fresh quote are still required.';}
    if(action==='export')download('astra-combo-workspace.json',{...s.catalog,filters:s.filters,limits:s.limits,drafts:s.drafts,exportedAt:Date.now()});
    if(action==='export-ledger')download('astra-paper-ledger.json',s.ledger);
    if(action==='export-drafts')download('astra-combo-drafts.json',{version:1,drafts:s.drafts});
    if(action==='auto'){if(s.auto){s.auto=false;s.notice='Automatic paper monitoring stopped. Pending orders remain until cancelled or processed.';}else{validateLimits(s.limits);if(!original())throw new Error('Select a combo first');if(!['sample','kalshi'].includes(s.source))throw new Error('Automatic paper mode needs a live/sample refresh source');s.auto=true;s.notice='Automatic PAPER monitoring enabled for the selected combo. It pauses when the tab is hidden.';}}
    if(action==='kill'){s.auto=false;await paperChange(cancelPending);s.notice='Stopped. Pending paper orders cancelled. Existing paper positions remain open.';}
  });
});
root.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.dataset.filter==='search'){e.preventDefault();s.filters={...s.filters,search:e.target.value.trim()};work(lookupTicker);}});
root.addEventListener('change',e=>{const el=e.target;try{
  if(el.id==='import-file'){const file=el.files?.[0];if(!file)return;work(async()=>{if(file.size>15000000)throw new Error('Maximum catalog size is 15 MB');const data=validateCatalog(JSON.parse(await file.text()));const updating=s.source==='import';if(!updating&&s.ledger.pending.length)await paperChange(cancelPending);s.auto=false;s.catalog={...data,markets:data.markets.map(m=>({...m,source:'import'}))};s.source='import';s.cursor=null;if(!updating||!original())s.selected=null;if(updating&&s.ledger.pending.length)await paperChange(current=>processPending(current,s.catalog));s.notice='Imported observations retain their timestamps. Imported quotes are not eligible for automatic paper execution.';});return;}
  if(el.dataset.filter){if(el.dataset.filter==='search')s.lookupIds=[];const k=el.dataset.filter,n=['minOI','minVolume','hours','minLegs','maxLegs'].includes(k);if(n&&(el.value===''||!Number.isFinite(Number(el.value))))throw new Error('Enter a valid numeric filter');s.filters={...s.filters,[k]:n?Number(el.value):el.value};}
  if(el.dataset.limit){if(s.auto)return;const next={...s.limits,[el.dataset.limit]:el.value===''?NaN:Number(el.value)};validateLimits(next);s.limits=next;}
  if(el.dataset.keep){if(el.checked)s.keep.add(el.dataset.keep);else s.keep.delete(el.dataset.keep);s.custom=true;}
  if(el.dataset.pin){if(el.checked){s.pinned.add(el.dataset.pin);s.keep.add(el.dataset.pin);}else s.pinned.delete(el.dataset.pin);s.custom=false;}
  if(el.id==='max-removed'){s.maxRemoved=Number(el.value);s.custom=false;s.selectedVariant=null;}
  if(el.id==='alt-sort')s.sort=el.value;if(el.id==='alt-direction')s.direction=el.value;
  s.error='';
}catch(e){s.error=e.message;}render();});
let ticking=false;
setInterval(async()=>{
  if(!workspaceActive||!s.auto||s.busy||ticking||document.hidden||dialog.open)return;ticking=true;
  await work(async()=>{await refresh();if(!workspaceActive||!s.auto||stopRequested||document.hidden)return;const o=original();if(!o)throw new Error('Selected combo disappeared');const best=compare().rows.find(r=>r.eligible);if(best&&!s.ledger.pending.some(p=>p.originalKey===marketKey(o))&&!s.ledger.positions.some(p=>p.originalKey===marketKey(o)&&p.status==='open'))await paperChange(current=>queuePaper(current,o,best,s.limits,Date.now(),'automatic'));});ticking=false;
},15000);
setInterval(()=>{if(workspaceActive&&!s.busy&&!dialog.open&&!(surface.activeElement||document.activeElement).matches('input,select,textarea'))render();},5000);
const onVisibility=()=>{if(document.hidden){s.auto=false;s.notice='Automatic paper monitoring paused because the tab is hidden.';render();}};
document.addEventListener('visibilitychange',onVisibility);
const onStorage=e=>{if(e.key===storageKey){s.auto=false;try{s.ledger=validateLedger(JSON.parse(e.newValue));s.notice='Paper ledger changed in another tab; automatic monitoring paused.';}catch(error){s.storageError=true;s.error=error.message;}render();}};
window.addEventListener('storage',onStorage);
render();
const dispose=()=>{disposed=true;s.auto=false;requestAbort?.abort();timers.forEach(window.clearInterval);document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('storage',onStorage);dialog.remove();root.replaceChildren();};
dispose.setActive=active=>{
  workspaceActive=active;
  if(!active){s.auto=false;if(s.busy){stopRequested=true;requestAbort?.abort();}if(dialog.open)dialog.close();s.notice='Workspace paused. Your scan and selected hedge are preserved.';}
  render();
};
return dispose;
}
