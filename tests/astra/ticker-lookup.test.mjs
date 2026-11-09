import test from 'node:test';
import assert from 'node:assert/strict';
import {comboQuery,resolveComboTickers,REFERENCE_COMBO_TICKERS} from '../../src/astra/ticker-lookup.mjs';
import {validateCatalog,scan,generateVariants,scenarioTable} from '../../src/astra/engine.mjs';
import {sample} from '../../src/astra/sample.mjs';

test('full tickers and nine-character suffixes are normalized without inventing a full ID',()=>{
  const ticker=REFERENCE_COMBO_TICKERS[0];
  assert.deepEqual(resolveComboTickers(' egy4ztq7g ',REFERENCE_COMBO_TICKERS),[ticker]);
  assert.deepEqual(resolveComboTickers(ticker.toLowerCase(),[]),[ticker]);
  assert.deepEqual(resolveComboTickers('UNKNOWN99',REFERENCE_COMBO_TICKERS),[]);
  const collision='KXMVEOTHER-S2026EXAMPLE-EGY4ZTQ7G';
  assert.equal(resolveComboTickers('EGY4ZTQ7G',[ticker,ticker,collision]).length,2);
  assert.equal(comboQuery('../orders').kind,'text');
});
test('larger combos pass discovery and bounded optimization without exponential scenarios',()=>{
  const now=Date.now(),m=sample(now).markets.find(m=>m.legs.length>1);
  m.legs=Array.from({length:17},(_,i)=>({marketId:`LEG-${i}`,outcome:i%2?'no':'yes'}));
  const catalog=validateCatalog({version:1,markets:[m]});
  assert.equal(scan(catalog,{},now).length,1);
  assert.equal(generateVariants(m).variants.length,17);
  const limited=generateVariants(m,{maxRemoved:4,maxCandidates:128});assert.equal(limited.variants.length,128);assert.equal(limited.truncated,true);
  assert.deepEqual(scenarioTable(m,m.legs.slice(1),0,1),[]);
});
