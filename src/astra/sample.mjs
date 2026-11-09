export function sample(now=Date.now()){
  const fee={rate:0.07,rounding:'ceil'},all=[];
  for(const venue of ['kalshi','polymarket-us']){
    const names=['A · Home team wins','B · Total points over 40','C · Player gains 50+ yards','D · Visitor scores 14+ points'];
    const singles=[0.58,0.65,0.74,0.88].map((ask,i)=>({id:`DEMO-${i+1}`,venue,title:`Synthetic ${names[i]}`,legs:[{marketId:`DEMO-${i+1}`,outcome:'yes',title:names[i],eventId:`DEMO-GAME-${i+1}`}],status:'open',payout:1,openInterest:350000,volume:750000,volume24h:125000,expiration:now+(12+i*6)*3600000,closeAt:now+(10+i*6)*3600000,bid:ask-0.02,ask,bidSize:500,askSize:500,bids:[[ask-0.02,100],[ask-0.03,400]],asks:[[ask,100],[ask+0.01,400]],quoteAt:now,source:'sample',fee,productSettlement:true,rulesVerified:true}));
    const sets=[{id:'DEMO-ABCD',ix:[0,1,2,3],bid:0.31,ask:0.33,oi:220000},{id:'DEMO-ABC',ix:[0,1,2],bid:0.30,ask:0.32,oi:160000},{id:'DEMO-ABD',ix:[0,1,3],bid:0.24,ask:0.26,oi:180000},{id:'DEMO-ACD',ix:[0,2,3],bid:0.46,ask:0.48,oi:110000},{id:'DEMO-BCD',ix:[1,2,3],bid:0.53,ask:0.55,oi:130000},{id:'DEMO-AB',ix:[0,1],bid:0.36,ask:0.38,oi:80000}];
    all.push(...singles,...sets.map((s,i)=>({id:s.id,venue,title:`Synthetic combo ${s.id.replace('DEMO-','')}`,legs:s.ix.map(j=>({...singles[j].legs[0]})),status:'open',payout:1,openInterest:s.oi,volume:560000+i*60000,volume24h:65000+i*10000,expiration:Math.max(...s.ix.map(j=>singles[j].expiration)),closeAt:Math.min(...s.ix.map(j=>singles[j].closeAt)),bid:s.bid,ask:s.ask,bidSize:120,askSize:120,bids:[[s.bid,60],[s.bid-0.01,60]],asks:[[s.ask,60],[s.ask+0.02,60]],quoteAt:now,source:'sample',fee,productSettlement:true,rulesVerified:true})));
  }
  return {version:1,generatedAt:now,description:'Synthetic examples only. Deliberate price inconsistencies demonstrate the optimizer; these are not trading opportunities.',markets:all};
}
