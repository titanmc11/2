import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {quote,availableExtras,prices,types} from '../assets/pricing.js';
import {dictionary,languages} from '../assets/i18n.js';
import {routes,url} from '../assets/site.js';
test('all 40 supplied base prices are preserved',()=>{
 const expected={regular:[100,120,150,160,160,170,200,250],deep:[130,150,200,250,220,280,290,350],construction:[230,350,490,560,650,850,950,1150],airbnb:[130,150,200,250,220,280,290,350],office:[100,120,150,160,160,170,200,250]};
 for(const [type,rows]of Object.entries(expected))rows.forEach((price,i)=>assert.equal(quote(type,i).total,price));
});
test('extras do not charge twice for items already included',()=>{
 assert.equal(quote('regular',2,['oven','fridge','hood','cabinets','windows','manager']).total,375);
 assert.equal(quote('deep',2,['oven','fridge','hood','cabinets','windows','manager']).total,250);
 assert.equal(quote('airbnb',7,['oven','manager']).total,400);
 assert.equal(quote('construction',0,['windows','manager']).total,280);
 assert.equal(quote('office',7,['oven','hood','fridge','manager']).total,335);
 assert.equal(quote('regular',0,['oven','oven']).total,135);
});
test('crew sizes and renovation uncertainty',()=>{
 for(const type of types){assert.equal(quote(type,0).cleaners,type==='construction'?2:1);for(let i=1;i<8;i++)assert.equal(quote(type,i).cleaners,2);}
 assert.equal(quote('construction',3).time,null);
});
test('invalid inputs are rejected',()=>{for(const [type,index]of [['nope',0],['deep',-1],['deep',8],['deep',1.5]])assert.throws(()=>quote(type,index));});
test('every message has four nonempty translations',()=>{for(const [key,values]of Object.entries(dictionary)){assert.equal(values.length,4,key);values.forEach(v=>assert.ok(typeof v==='string'&&v.trim(),key));}});
test('all 60 pages have localized metadata and working internal destinations',()=>{
 for(const lang of languages)for(const route of routes){const html=fs.readFileSync((lang==='ru'?'':lang+'-')+(route?route.replaceAll('/','-'):'index')+'.html','utf8');assert.ok(html.includes('<html lang="'+lang+'">'));assert.equal((html.match(/<h1[ >]/g)||[]).length,1);assert.ok(!html.includes('undefined'));for(const m of html.matchAll(/(?:href|src)="(\/[^"?#]*)(?:[^\"]*)"/g)){const p=m[1];const file='dist'+p+(p.endsWith('/')?'index.html':'');assert.ok(fs.existsSync(file),file);}}
});
