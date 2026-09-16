// Portable export: all pages next to index.html, usable from any repository path.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {routes,url,header,footer,renderPage,esc} from '../assets/site.js';
import {languages,t} from '../assets/i18n.js';
import {company} from '../assets/config.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const filename=(route,lang)=>`${lang==='ru'?'':lang+'-'}${route?route.replaceAll('/','-'):'index'}.html`;
const pages=new Map(languages.flatMap(lang=>routes.map(route=>[url(route,lang),filename(route,lang)])));
function localLink(value){
 if(company.publicOrigin&&value.startsWith(company.publicOrigin+'/'))value=value.slice(company.publicOrigin.length);
 if(!value.startsWith('/')||value.startsWith('//'))return value;
 const match=value.match(/^([^?#]*)(.*)$/);
 const pathname=match[1],suffix=match[2];
 if(pathname.startsWith('/assets/'))return pathname.slice(1)+suffix;
 const page=pages.get(pathname)||pages.get(pathname.replace(/index\.html$/,''));
 if(!page)throw new Error('Unknown internal path: '+value);
 return page+suffix;
}

// Root contains only generated public files plus the original project folders.
const outputs=[...pages.values(),'404.html','robots.txt'];
let previous=[];
try{previous=JSON.parse(await fs.readFile(path.join(root,'.root-export-manifest.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
for(const name of [...outputs,'assets']){
 try{await fs.stat(path.join(root,name));if(!previous.includes(name))throw new Error('Refusing to overwrite an existing file or folder: '+name);}catch(e){if(e.code!=='ENOENT')throw e;}
}
const moduleFiles=['i18n.js','pricing.js','config.js','site.js','app.js'];
let bundle='// Royal UA Cleaning: generated portable browser bundle.\n(()=>{\n';
for(const file of moduleFiles){let source=await fs.readFile(path.join(root,'assets',file),'utf8');
 source=source.replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'');
 if(file==='site.js')source=source.replace(/const url=\(route='',lang='ru'\)=>[^;]+;/,"const url=(route='',lang='ru')=>(lang==='ru'?'':lang+'')+(lang==='ru'?'':'-')+(route?route.replaceAll('/','-'):'index')+'.html';").replaceAll('src="/assets/','src="assets/');
 bundle+='\n// '+file+'\n'+source+'\n';
}
bundle+='\n})();\n';
await fs.writeFile(path.join(root,'assets/bundle.js'),bundle);
for(const lang of languages)for(const route of routes){const name=filename(route,lang);const title=route?t(route.startsWith('services/')?route.split('/')[1]:route,lang):t('premium',lang);const desc=t(route.startsWith('services/')?route.split('/')[1]+'Desc':route==='book'?'bookingLead':'heroText',lang);let html=`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#1b4332"><title>${esc(title)} | Royal UA Cleaning</title><meta name="description" content="${esc(desc)}"><link rel="icon" href="assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="assets/style.css">${languages.map(l=>`<link rel="alternate" hreflang="${l}" href="${url(route,l)}">`).join('')}<meta property="og:title" content="${esc(title)} | Royal UA Cleaning"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website"><script type="module" src="assets/app.js"></script></head><body data-lang="${lang}" data-route="${route}">${header(lang,route)}<main id="main">${renderPage(route,lang)}</main>${footer(lang)}<noscript><style>.reveal{opacity:1!important;transform:none!important}</style></noscript></body></html>`;
 html=html.replace(/<link rel="canonical"[^>]*>/g,'');
 html=html.replace(/\b(href|src|action)="([^"]*)"/g,(_,attr,value)=>`${attr}="${localLink(value)}"`);
 html=html.replace('<script type="module" src="assets/app.js"></script>','<script defer src="assets/bundle.js"></script>');
 await fs.writeFile(path.join(root,name),html);
}
// Self-contained: assets must not depend on the depth of the incorrect URL.
let notFound=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="theme-color" content="#1b4332"><title>Страница не найдена | Royal UA Cleaning</title><style>*{box-sizing:border-box}body{margin:0;min-height:100svh;background:#f4f8f2;color:#1b4332;font-family:Arial,sans-serif;display:grid;place-items:center;padding:28px}main{max-width:680px;width:100%;text-align:center}.brand{font-size:14px;letter-spacing:3px;font-weight:700}.crown{font-size:42px;color:#b5934b;margin-bottom:14px}.code{font-size:clamp(100px,24vw,180px);font-weight:700;letter-spacing:-8px;line-height:1.1;margin:45px 0 18px;color:#d3dfce}h1{font-size:clamp(28px,5vw,42px);line-height:1.2;margin:0 0 18px}p{font-size:17px;line-height:1.8;color:#6b766e;margin:0 auto 30px;max-width:480px}.button{display:inline-block;background:#1b4332;color:#fff;border-radius:7px;padding:17px 28px;font-size:16px;text-decoration:none;transition:background .2s}.button:hover{background:#2b6045}.button:focus-visible{outline:3px solid #b5934b;outline-offset:5px}small{display:block;font-size:13px;color:#7b8775;margin-top:45px}</style></head><body><main><div class="crown" aria-hidden="true">♛</div><div class="brand">ROYAL UA CLEANING</div><div class="code" aria-hidden="true">404</div><h1>Страница не найдена</h1><p>Возможно, в ссылке опечатка или эта страница больше не существует. Вернитесь на главную, чтобы выбрать уборку.</p><a id="back-home" class="button" href="/">На главную</a><small>Батуми · Royal UA Cleaning</small></main><script>
(()=>{const home=document.getElementById('back-home');if(location.protocol==='file:'){home.href='index.html';return;}const first=location.pathname.split('/').filter(Boolean)[0];if(!first)return;const candidate='/'+encodeURIComponent(decodeURIComponent(first))+'/';fetch(candidate+'index.html',{credentials:'same-origin'}).then(async r=>{if(!r.ok)return;const html=await r.text();if(html.includes('data-route=""')&&html.includes('Royal UA Cleaning'))home.href=candidate;}).catch(()=>{});})();
</script></body></html>`;
await fs.writeFile(path.join(root,'404.html'),notFound);
await fs.writeFile(path.join(root,'robots.txt'),'User-agent: *\nAllow: /\n');
await fs.writeFile(path.join(root,'.root-export-manifest.json'),JSON.stringify([...outputs,'assets'],null,2));
console.log(`Built ${pages.size} pages and browser scripts.`);
