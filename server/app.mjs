import http from 'node:http';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createApi} from './api.mjs';

export const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.avif':'image/avif','.woff2':'font/woff2','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};

/** Only generated pages and assets are public; source code and databases are never served. */
export async function createSiteServer({publicRoot=projectRoot,dbPath=path.join(projectRoot,'data/royal.sqlite'),allowedOrigins=[],requireHttps=process.env.NODE_ENV==='production',trustedProxyIps=[],base='/'}={}){
 if(!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base))throw Error('Invalid base path');
 const root=await realpath(publicRoot),assetRoot=await realpath(path.join(root,'assets'));
 const manifest=JSON.parse(await readFile(path.join(root,'.root-export-manifest.json'),'utf8'));
 const publicPages=new Set(manifest.filter(file=>/^[a-z0-9-]+\.html$/.test(file)));
 const notFound=await readFile(path.join(root,'404.html'),'utf8');
 const scriptHashes=[...notFound.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>"'sha256-"+createHash('sha256').update(match[1]).digest('base64')+"'").join(' ');
 const api=createApi({dbPath,allowedOrigins,requireHttps,trustedProxyIps});
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' ${scriptHashes}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-src https://maps.google.com https://www.google.com; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
  if(requireHttps)res.setHeader('Strict-Transport-Security','max-age=31536000');
  const missing=()=>{res.writeHead(404,{'Content-Type':mime['.html'],'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:notFound);};
  try{
   const requested=new URL(req.url,'http://localhost');
   const pathname=decodeURIComponent(requested.pathname);
   if(!pathname.startsWith(base)||/[\\\0]/.test(pathname))return missing();
   const relative=pathname.slice(base.length);
   if(relative==='api'||relative.startsWith('api/')){req.url='/'+relative+requested.search;await api.handle(req,res);return;}
   if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'});res.end();return;}
   if(relative==='healthz'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:'{"status":"ok"}');return;}
   const file=relative||'index.html';
   // Keep old links usable after switching from nested static routes to flat pages.
   if(/^(?:(?:en|uk|ka)\/)?(?:[a-z-]+\/)*$/.test(relative)&&relative){
    const parts=relative.replace(/\/$/,'').split('/'),lang=['en','uk','ka'].includes(parts[0])?parts.shift()+'-':'';
    const flat=lang+(parts.join('-')||'index')+'.html';
    if(publicPages.has(flat)){res.writeHead(308,{'Location':base+flat+requested.search});res.end();return;}
   }
   const isAsset=file.startsWith('assets/')&&!file.split('/').some(part=>part.startsWith('.'))&&!!mime[path.extname(file)];
   if(!publicPages.has(file)&&file!=='robots.txt'&&!isAsset)return missing();
   const resolved=await realpath(path.resolve(root,file));
   if(isAsset?!resolved.startsWith(assetRoot+path.sep):path.dirname(resolved)!==root)return missing();
   const data=await readFile(resolved);
   res.writeHead(file==='404.html'?404:200,{'Content-Type':mime[path.extname(file)],'Content-Length':data.length,'Cache-Control':'no-cache'});
   res.end(req.method==='HEAD'?undefined:data);
  }catch(error){if(res.headersSent){res.destroy();return;}if(['ENOENT','ENOTDIR'].includes(error.code)||error instanceof URIError)return missing();console.error('Royal server error:',error.code||error.name);res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end('Server error. Please try again.');}
 });
 server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
 server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
 return {server,api,close:()=>new Promise((resolve,reject)=>server.close(error=>{api.close();error?reject(error):resolve();}))};
}

export function environmentOptions(){
 if(Number(process.versions.node.split('.')[0])<24)throw Error('Node.js 24 or newer is required.');
 const production=process.env.NODE_ENV==='production';
 const origin=process.env.PUBLIC_ORIGIN?.trim();
 if(production&&!origin)throw Error('Set PUBLIC_ORIGIN=https://your-domain before production startup.');
 const port=Number(process.env.PORT||4173);if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid PORT');
 return {dbPath:path.resolve(projectRoot,process.env.DATA_DIR||'data','royal.sqlite'),allowedOrigins:origin?[origin]:[],requireHttps:production,trustedProxyIps:(process.env.TRUSTED_PROXY_IPS||'').split(',').map(x=>x.trim()).filter(Boolean),port,host:process.env.HOST||'127.0.0.1'};
}
export function gracefulShutdown(site){
 let stopping=false;
 const shutdown=()=>{if(stopping)return;stopping=true;const timeout=setTimeout(()=>process.exit(1),30000);timeout.unref();site.close().then(()=>{clearTimeout(timeout);process.exitCode=0;},()=>{process.exitCode=1;});};
 process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const options=environmentOptions();const site=await createSiteServer(options);site.server.on('error',error=>{console.error('Cannot start Royal UA Cleaning:',error.code||error.message);site.api.close();process.exitCode=1;});site.server.listen(options.port,options.host,()=>console.log(`Royal UA Cleaning server: http://${options.host}:${site.server.address().port}\nDatabase: ${options.dbPath}`));gracefulShutdown(site);}catch(error){console.error(error.message);process.exitCode=1;}
}
