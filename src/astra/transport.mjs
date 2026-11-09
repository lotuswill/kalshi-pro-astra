import {kalshiMarket,kalshiBook,assertTicker} from './adapters.mjs';
import {checkLegs,validateCatalog} from './engine.mjs';
import {sample} from './sample.mjs';

export function createTransport({apiBase,fetcher=(...args)=>fetch(...args),onStatus=()=>{},requestTimeoutMs=10000}={}) {
  if(typeof apiBase!=='string'||!apiBase.startsWith('/kalshi/'))throw new Error('Expected the local Kalshi proxy');
  if(!Number.isFinite(requestTimeoutMs)||requestTimeoutMs<=0)throw new Error('Invalid request timeout');
  const alternate=apiBase.replace('/kalshi/','/kalshi-alt/');let preferred=apiBase;
  async function read(base,path,parent){
    if(parent?.aborted)throw parent.reason||new Error('Request stopped');
    const controller=new AbortController();let timer,onAbort;
    const deadline=new Promise((_,reject)=>{
      const fail=error=>{controller.abort(error);reject(error);};
      timer=setTimeout(()=>fail(new Error(`Timed out after ${requestTimeoutMs/1000}s`)),requestTimeoutMs);
      onAbort=()=>fail(parent.reason||new Error('Request stopped'));
      parent?.addEventListener('abort',onAbort,{once:true});
    });
    try{return await Promise.race([deadline,(async()=>{
      const response=await fetcher(base+path,{signal:controller.signal,cache:'no-store'});
      if(!response.ok){
        let code='';try{const body=await response.json();if(/^[A-Z0-9_]+$/.test(body?.error?.code||''))code=` (${body.error.code})`;}catch{}
        const error=new Error(`Kalshi HTTP ${response.status}${code}`);error.status=response.status;throw error;
      }
      try{return await response.json();}catch{throw new Error('Local proxy returned an invalid response; restart the dev server');}
    })()]);}finally{clearTimeout(timer);parent?.removeEventListener('abort',onAbort);}
  }
  const get=async(path,signal)=>{
    const bases=[preferred,preferred===apiBase?alternate:apiBase],failures=[];
    for(const base of bases){
      try{const data=await read(base,path,signal);preferred=base;return data;}
      catch(error){
        if(signal?.aborted)throw signal.reason||error;
        // Only these public GETs can fall back. Authenticated actions never use this transport.
        if(error.status&&error.status<500&&![408,429].includes(error.status))throw error;
        failures.push(error.message);
        if(failures.length===1)onStatus('Kalshi connection is slow or unavailable. Trying the alternate public endpoint…');
      }
    }
    throw new Error(`Cannot reach Kalshi through the local server. ${failures.join('; ')}. Stop and restart npm run dev after updating. Run npm run diagnose:kalshi for a connection report.`);
  };
  return async function request(route,signal) {
    const url=new URL(route,'http://localhost');
    if(url.pathname==='/api/sample'){const data=sample();data.markets=data.markets.filter(m=>m.venue==='kalshi');return data;}
    if(url.pathname==='/api/kalshi/markets'){
      const cursor=url.searchParams.get('cursor')||'';if(cursor.length>3000)throw new Error('Invalid cursor');
      const query=new URLSearchParams({limit:'200',status:'open',mve_filter:'only'});if(cursor)query.set('cursor',cursor);
      const data=await get('/markets?'+query,signal),markets=[],warnings=[];
      if(!Array.isArray(data.markets))throw new Error('Unrecognized market response');
      for(const raw of data.markets){try{const m=kalshiMarket(raw);checkLegs(m.legs);if(m.legs.length<2)continue;validateCatalog({version:1,markets:[m]});markets.push(m);}catch(e){warnings.push(e.message);}}
      return {version:1,markets,cursor:data.cursor||null,warnings};
    }
    if(url.pathname==='/api/kalshi/market'){
      const ticker=assertTicker((url.searchParams.get('ticker')||'').trim().toUpperCase());
      const data=await get('/markets/'+encodeURIComponent(ticker),signal);
      if(data.market?.ticker!==ticker)throw new Error('Market identity mismatch');
      const m=kalshiMarket(data.market);checkLegs(m.legs);
      if(m.legs.length<2)throw new Error('This ticker is not a combo');
      return validateCatalog({version:1,markets:[m]});
    }
    if(url.pathname==='/api/kalshi/snapshot'){
      const ids=[...new Set((url.searchParams.get('ids')||'').split(',').filter(Boolean))];if(!ids.length||ids.length>40)throw new Error('Refresh 1–40 instruments');ids.forEach(assertTicker);
      const queue=[...ids],markets=[],errors=[];
      await Promise.all(Array.from({length:Math.min(3,ids.length)},async()=>{while(queue.length){if(signal?.aborted)throw new Error('Refresh stopped');const id=queue.shift();try{
        const [md,book]=await Promise.all([get('/markets/'+encodeURIComponent(id),signal),get('/markets/'+encodeURIComponent(id)+'/orderbook?depth=100',signal)]);
        if(md.market?.ticker!==id)throw new Error('Market identity mismatch');
        const m={...kalshiMarket(md.market),...kalshiBook(book)};validateCatalog({version:1,markets:[m]});markets.push(m);
      }catch(e){if(signal?.aborted)throw e;errors.push({id,error:e.message});}}}));
      return {version:1,markets,errors};
    }
    throw new Error('Unsupported read-only route');
  };
}
