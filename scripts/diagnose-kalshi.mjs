import {createServer} from 'vite';
import http from 'node:http';
import {createTransport} from '../src/astra/transport.mjs';
import {REFERENCE_COMBO_TICKERS,comboQuery} from '../src/astra/ticker-lookup.mjs';

const ticker=(process.argv[2]||REFERENCE_COMBO_TICKERS[0]).trim().toUpperCase();
if(comboQuery(ticker).kind!=='full')throw new Error('Provide a full combo ticker');
console.log(`Node ${process.version}; configured HTTPS proxy: ${!!(process.env.https_proxy||process.env.HTTPS_PROXY)}`);
console.log('Checking the actual local Vite proxy and combo lookup. Public GETs only; no keys or orders.');
// Use an available loopback port without disturbing either running app.
const app=await createServer({server:{host:'127.0.0.1',port:5180,strictPort:false}});
try {
  await app.listen();const port=app.httpServer.address().port;
  const fetcher=(path,{signal}={})=>new Promise((resolve,reject)=>{
    // Loopback is deliberately direct; the upstream proxy honors HTTPS_PROXY.
    const req=http.get({hostname:'127.0.0.1',port,path,agent:false,signal},res=>{
      let body='';res.on('data',chunk=>body+=chunk);
      res.on('error',reject);res.on('aborted',()=>reject(new Error('Local proxy response interrupted')));
      res.on('end',()=>{console.log(`Local proxy HTTP ${res.statusCode} (${path.startsWith('/kalshi-alt/')?'alternate':'primary'})`);resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,json:async()=>JSON.parse(body)});});
    });req.on('error',reject);
  });
  const transport=createTransport({apiBase:'/kalshi/trade-api/v2',fetcher,onStatus:message=>console.log(message)});
  const started=Date.now(),data=await transport('/api/kalshi/market?ticker='+encodeURIComponent(ticker));
  const m=data.markets[0];
  console.log(`PASS: ${m.id}\n${m.legs.length} legs; status ${m.status}; OI ${m.openInterest}; ${Date.now()-started} ms`);
} catch(error) {
  console.error(`FAIL: ${error.message}`);process.exitCode=1;
} finally {await app.close();}
