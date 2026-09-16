export const layouts = ['studio','1+1','2+1','2+2','3+1','3+2','4+1','4+2'];
export const areas = [35,50,70,80,90,120,130,160];
export const types = ['regular','deep','construction','airbnb','office'];
export const prices = {
 regular:[100,120,150,160,160,170,200,250],
 deep:[130,150,200,250,220,280,290,350],
 construction:[230,350,490,560,650,850,950,1150],
 airbnb:[130,150,200,250,220,280,290,350],
 office:[100,120,150,160,160,170,200,250]
};
export const times = {
 regular:['3','1:30–2','2–2:30','2:30–3','3','3–3:30','4','4–4:30'],
 deep:['5','3','4–4:30','5–5:30','5–5:30','6','6','6:30'],
 airbnb:['5','3','4–4:30','5–5:30','5–5:30','6','6','6:30'],
 office:['3','1:30–2','2–2:30','2:30–3','3','3–3:30','4','4–4:30']
};
export const extras = {oven:35,fridge:35,hood:25,cabinets:40,windows:40,manager:50};
export function availableExtras(type) {return type==='regular'?Object.keys(extras):type==='office'?['fridge','cabinets','windows','manager']:['manager'];}
export function quote(type,index,selected=[]) {
 if(!types.includes(type)||!Number.isInteger(index)||index<0||index>7) throw new Error('Invalid pricing selection');
 const allowed=availableExtras(type), valid=[...new Set(selected)].filter(x=>allowed.includes(x));
 return {base:prices[type][index],extras:valid,total:prices[type][index]+valid.reduce((s,x)=>s+extras[x],0),cleaners:type==='construction'||index>0?2:1,time:times[type]?.[index]??null};
}
