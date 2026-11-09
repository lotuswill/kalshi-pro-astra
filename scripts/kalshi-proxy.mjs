import {Agent} from 'node:https';

// http-proxy otherwise bypasses Node's environment-aware global agent.
// Honor the operator's existing HTTPS_PROXY / NO_PROXY configuration.
export function kalshiProxy(target, prefix) {
  return {
    target,
    changeOrigin: true,
    agent: new Agent({proxyEnv: process.env, keepAlive: false}),
    proxyTimeout: 8000,
    timeout: 12000,
    rewrite: path => path.slice(prefix.length),
    configure(proxy) {
      proxy.on('proxyReq', request => {
        // Socket timeouts alone do not bound DNS lookup or connection setup.
        const timer=setTimeout(() => {
          const error=new Error('Kalshi upstream deadline exceeded');
          error.code='ETIMEDOUT';request.destroy(error);
        },8000);
        request.once('close',()=>clearTimeout(timer));
      });
      proxy.on('error',(error,_request,response)=>{
        if(!response?.writeHead||response.headersSent||response.writableEnded)return;
        const code=/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'UPSTREAM_ERROR';
        response.writeHead(502,{'Content-Type':'application/json','Cache-Control':'no-store'});
        response.end(JSON.stringify({error:{code,message:'The local server could not reach Kalshi.'}}));
      });
    },
  };
}
