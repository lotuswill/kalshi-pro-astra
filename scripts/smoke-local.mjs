import {createServer} from 'vite';

// Run the real local server inside the same process as the checks. This also
// works in hosted development sessions with isolated process networking.
const app=await createServer({server:{host:'127.0.0.1',port:0,strictPort:true}});
try {
  await app.listen();
  const port=app.httpServer.address().port;
  for(const path of ['/', '/src/Combos.jsx', '/src/astra/workbench.mjs']) {
    const response=await fetch(`http://127.0.0.1:${port}${path}`);
    const body=await response.text();
    if(!response.ok||!body.length)throw new Error(`${path}: HTTP ${response.status} or empty response`);
    console.log(`${path}: HTTP ${response.status}`);
  }
  console.log('Local app and combo modules served successfully; no exchange requests made.');
} finally {
  await app.close();
}
