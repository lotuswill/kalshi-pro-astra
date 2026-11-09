import {kalshiMarket,kalshiBook,assertTicker} from './adapters.mjs';
import {checkLegs,validateCatalog} from './engine.mjs';
import {sample} from './sample.mjs';

export function createTransport({apiBase,fetcher=(...args)=>fetch(...args)}={}) {
  if(typeof apiBase!=='string'||!apiBase.startsWith('/kalshi/'))throw new Error('Expected the local Kalshi proxy');
  const get=async(path,signal)=>{const response=await fetcher(apiBase+path,{signal,cache:'no-store'});if(!response.ok)throw new Error(`Kalshi HTTP ${response.status}`);return response.json();};
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
