import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBatchMusic, batchKeywordMessages } from '../app/shared/batch-music.mjs';
import { analyzeWithWeb } from '../app/shared/web-script-analysis.mjs';
import { parseSegments, segmentMessages } from '../app/shared/script-segments.mjs';
import { createMusicUsageStore, excludeUsedMusic } from '../app/shared/library-usage.mjs';

const tracks = Array.from({length:18},(_,n)=>({id:`local-${n}`,title:`悬疑弦乐${n}`}));
const episodes = [31,32,33].map(n=>({id:`ep-${n}`,episodeNumber:n,title:`第${n}集`,script:`第${n}集\n${n}-1 办公室\n[EN] A: Wait...\n${n}-2 走廊\n[EN] B: Come here.`}));
const match = id => ({id,reason:'弦乐与持续紧张的情绪匹配',keywords:['紧张']});
const planned = input => ({episodes:input.episodes.map(e=>({id:e.id,summary:'连续紧张的对峙',keywords:['悬疑'],segments:[{title:'追问真相',summary:'质问逐步升级',keywords:['悬疑'],startLine:1,endLine:5}]}))});

test('one invalid second music ID is corrected only for its episode; other five-track results survive',async()=>{
  let calls=0;
  const result=await analyzeBatchMusic({episodes,tracks,segmented:true,segmentCount:2},async messages=>{
    const input=JSON.parse(messages[1].content);
    if(++calls===1)return JSON.stringify(planned(input));
    if(calls===2)return JSON.stringify({episodes:input.episodes.map((e,n)=>({id:e.id,segments:[{id:'segment-1',matches:n===1?[match('local-5'),match('invented-id')]:tracks.slice(n*5,n*5+5).map(t=>match(t.id))}]}))});
    assert.deepEqual(input.episodes.map(e=>e.id),['ep-32']);
    assert.equal(input.episodes[0].segments[0].acceptedMatches[0].id,'local-5');
    assert.match(input.episodes[0].segments[0].validationError,/ID 无效/);
    return JSON.stringify({episodes:[{id:'ep-32',segments:[{id:'segment-1',matches:tracks.slice(6,10).map(t=>match(t.id))}]}]});
  });
  assert.equal(calls,3);
  assert.ok(result.episodes.every(e=>e.value.segments[0].matches.length===5));
  assert.equal(new Set(result.episodes.flatMap(e=>e.value.matches.map(m=>m.id))).size,15);
  assert.ok(result.episodes.every(e=>e.value.segments[0].warning===''));
});

test('repeated invalid IDs are filtered after one repair while every valid episode and section is retained',async()=>{
  let calls=0;
  const result=await analyzeBatchMusic({episodes,tracks,segmented:true,segmentCount:2},async messages=>{
    const input=JSON.parse(messages[1].content);
    if(++calls===1)return JSON.stringify(planned(input));
    return JSON.stringify({episodes:input.episodes.map(e=>({id:e.id,segments:[{id:'segment-1',matches:[match('local-0'),match('bad')]}]}))});
  });
  assert.equal(calls,3);
  assert.deepEqual(result.episodes.map(e=>e.value.matches.map(m=>m.id)),[['local-0'],[],[]]);
  for(const {value} of result.episodes){assert.match(value.segments[0].warning,/已过滤/);assert.ok(value.segments[0].noMatchReason);}
});

test('missing recommendations are supplemented to five in workspace whole and segment workflows',async()=>{
  for(const segmented of [false,true]){
    let calls=0;
    const result=await analyzeWithWeb('library-match',{script:episodes[0].script,tracks,segmented,segmentCount:2},async messages=>{
      calls++;
      const input=JSON.parse(messages[1].content);
      if(calls===1)return JSON.stringify(segmented?{segments:planned({episodes}).episodes[0].segments}:{summary:'紧张对峙',keywords:['悬疑']});
      assert.match(messages[0].content,/至少推荐5首/);
      const selected=tracks.slice(calls===2?0:2,calls===2?2:5).map(t=>match(t.id));
      return JSON.stringify(segmented?{segments:input.segments.map(s=>({id:s.id,matches:selected}))}:{matches:selected});
    });
    assert.equal(calls,3);assert.equal((segmented?result.segments[0]:result).matches.length,5);
  }
});

test('one continuous plot may span several printed scene numbers with complete coverage',()=>{
  const input={...episodes[0],segmentCount:2,segmented:true,episodes};
  assert.match(batchKeywordMessages(input)[0].content,/场次号/);
  assert.match(segmentMessages(input,'library')[0].content,/1–2/);
  const one=planned({episodes}).episodes[0].segments;
  assert.equal(parseSegments(JSON.stringify({segments:one}),input,'library').length,1);
  assert.throws(()=>parseSegments(JSON.stringify({segments:[{...one[0],endLine:4}]}),input,'library'),/完整剧本/);
});

test('usage toggles off persistently, informs both pages, and restores eligibility without changing other records',()=>{
  const usageTracks = tracks.slice(0,8);
  const values=new Map();const storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const usage=createMusicUsageStore(storage);let events=0;usage.subscribe(()=>events++);
  for(const track of usageTracks)usage.remember(track);
  assert.equal(usage.toggle(usageTracks[0]),false);
  assert.deepEqual(excludeUsedMusic(usageTracks,usage.snapshot().history).map(t=>t.id),['local-0']);
  const reopened=createMusicUsageStore(storage);assert.equal(reopened.snapshot().history.length,7);
  assert.equal(reopened.toggle(usageTracks[0]),true);assert.equal(reopened.snapshot().history[0].id,'local-0');
  reopened.forget('local-1');assert.ok(!reopened.snapshot().history.some(t=>t.id==='local-1'));assert.equal(events,9);
});
