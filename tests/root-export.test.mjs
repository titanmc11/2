import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const entries=JSON.parse(fs.readFileSync('.root-export-manifest.json','utf8'));
test('portable export has 60 localized pages and a classic browser bundle',()=>{
 assert.equal(entries.filter(x=>x.endsWith('.html')&&x!=='404.html').length,60);
 new vm.Script(fs.readFileSync('assets/bundle.js','utf8'));
 for(const file of entries.filter(x=>x.endsWith('.html')&&x!=='404.html')){
  const html=fs.readFileSync(file,'utf8');
  assert.ok(html.includes('<script defer src="assets/bundle.js"></script>'),file);
  assert.ok(!html.includes('type="module"'),file);
  assert.ok(!html.includes('rel="canonical"'),file);
  assert.ok(!/auth-dialog|data-auth-open|auth-nav|data-booking-protected|booking-gate/.test(html),file);
  if(/(?:^|-)book\.html$/.test(file))assert.match(html,/<section class="container booking-layout section-first"><form id="booking-form">/);
 }
});
test('links and assets resolve at root, repository subpath, and from local files',()=>{
 for(const file of entries.filter(x=>x.endsWith('.html')&&x!=='404.html')){const html=fs.readFileSync(file,'utf8');
  for(const [,attribute,value]of html.matchAll(/\b(href|src|action)="([^"]*)"/g)){
   if(/^(?:[a-z]+:|#|\/\/)/i.test(value))continue;
   assert.ok(!value.startsWith('/'),`${file}: root-absolute ${value}`);
   const decoded=value.replaceAll('&amp;','&').split(/[?#]/)[0];
   if(!decoded)continue;
   assert.ok(fs.existsSync(decoded),`${file}: missing ${decoded}`);
   for(const base of ['https://example.test/','https://example.test/my-repository/','file:///C:/site/']){
    const resolved=new URL(value,new URL(file,base));assert.ok(resolved.href.startsWith(base),`${file}: escapes ${base}`);
   }
  }
 }
});
test('404 is self-contained for incorrect URLs at arbitrary depth',()=>{
 const html=fs.readFileSync('404.html','utf8');
 assert.ok(html.includes('Страница не найдена'));
 assert.ok(html.includes('name="robots" content="noindex"'));
 assert.ok(html.includes('id="back-home"'));
 assert.ok(!/<(?:link|script|img)\b[^>]*(?:src|href)=/.test(html));
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 new vm.Script(script);
});
