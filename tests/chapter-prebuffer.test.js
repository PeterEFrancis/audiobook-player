import test from 'node:test';
import assert from 'node:assert/strict';
import {setMaxListeners} from 'node:events';
import {Player} from '../js/player.js';
import {db} from '../js/db.js';

class FakeAudio extends EventTarget {
  constructor() { super(); Object.assign(this,{paused:true,playbackRate:1,volume:1,playCalls:0}); }
  set src(value) { this._src=this.currentSrc=value; this.currentTime=0; this.duration=NaN; this.readyState=0; this.ended=false; }
  get src() { return this._src; }
  async play() { this.playCalls++; this.paused=false; this.ended=false; this.dispatchEvent(new Event('playing')); }
  pause() { const playing=!this.paused; this.paused=true; if(playing)this.dispatchEvent(new Event('pause')); }
  metadata() { this.duration=100; this.readyState=1; this.dispatchEvent(new Event('loadedmetadata')); }
  finish() { this.currentTime=100; this.paused=true; this.ended=true; }
}
globalThis.Audio=FakeAudio;
globalThis.document=Object.assign(new EventTarget(),{hidden:true});
globalThis.window=new EventTarget();
setMaxListeners(30,document,window);
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:true,userAgent:'iPhone'}});

const book=id=>({id,serverId:'server',title:id,author:'Author',tracks:[0,1].map(n=>({id:`${id}-${n}`,title:`Chapter ${n+1}`,duration:100,key:`/${id}/${n}`}))});
const turn=()=>new Promise(setImmediate);
const ready=async predicate=>{for(let i=0;i<20&&!predicate();i++)await turn();assert.ok(predicate(),'prebuffer did not settle');};
function setup(t,fetch) {
  const writes=[],created=[],revoked=[];
  const original={create:URL.createObjectURL,revoke:URL.revokeObjectURL,get:db.get,put:db.put};
  URL.createObjectURL=blob=>{const url=`blob:chapter-${created.length}`;created.push({url,blob});return url;};
  URL.revokeObjectURL=url=>revoked.push(url);
  db.get=async()=>undefined;
  db.put=async(store,value)=>writes.push({store,value:structuredClone(value)});
  window.fetch=fetch;
  const player=new Player({plex:{mediaURL:(_s,track)=>`https://server.test${track.key}`},downloads:{hasTrack:async()=>false},getServer:()=>({}),artworkURL:()=>''});
  t.after(()=>{clearInterval(player.timer);player.clearPreparation();if(player.activeObjectURL)URL.revokeObjectURL(player.activeObjectURL);URL.createObjectURL=original.create;URL.revokeObjectURL=original.revoke;db.get=original.get;db.put=original.put;delete window.fetch;});
  return {player,writes,created,revoked};
}

test('next chapter buffers during playback and hands off on the same audio before blocked storage',async t=>{
  const calls=[];
  const {player,writes,created,revoked}=setup(t,async(url,options)=>{calls.push({url,playing:player.playing,signal:options.signal});return new Response('next-audio',{headers:{'Content-Type':'audio/mpeg','Content-Length':'10'}});});
  await player.open(book('a'));player.audio.metadata();
  await ready(()=>player.nextSource?.bufferedSource);
  assert.deepEqual(calls.map(c=>({url:c.url,playing:c.playing})),[{url:'https://server.test/a/1',playing:true}]);
  assert.equal(player.audio.src,'https://server.test/a/0');
  assert.equal(await created[0].blob.text(),'next-audio');
  player.audio.playbackRate=1.5;player.audio.volume=.4;
  const audio=player.audio,plays=audio.playCalls;
  let unblock;const gate=new Promise(resolve=>{unblock=resolve;});t.after(unblock);
  const put=db.put;
  db.get=async()=>{await gate;};db.put=async(...args)=>{await gate;return put(...args);};
  audio.finish();const ending=player.ended();
  assert.equal(player.audio,audio);assert.equal(player.index,1);assert.equal(audio.src,'blob:chapter-0');
  assert.equal(audio.playCalls,plays+1);assert.equal(audio.paused,false);
  assert.equal(audio.playbackRate,1.5);assert.equal(audio.volume,.4);
  assert.equal(calls.length,1);assert.equal(player.activeObjectURL,'blob:chapter-0');assert.deepEqual(revoked,[]);
  audio.metadata();unblock();await ending;await player.saves;
  assert.ok(writes.some(row=>row.store==='progress'&&row.value.trackIndex===1));
  await player.open(book('b'),{autoplay:false});
  assert.ok(revoked.includes('blob:chapter-0'));
});

test('failed, oversized, and incomplete look-ahead keeps ordinary chapter streaming usable',async t=>{
  const cases={
    failure:()=>Promise.reject(new TypeError('offline')),
    declaredOversize:()=>new Response('small',{headers:{'Content-Length':String(64*1024*1024+1)}}),
    streamedOversize:()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(64*1024*1024+1));c.close();}})),
    truncated:()=>new Response('short',{headers:{'Content-Length':'50'}}),
    partial:()=>new Response('partial',{status:206}),
  };
  for(const [name,response] of Object.entries(cases))await t.test(name,async t=>{
    let calls=0,signal;
    const {player,created}=setup(t,async(_url,options)=>{calls++;signal=options.signal;return response();});
    await player.open(book(name));player.audio.metadata();
    await ready(()=>signal?.aborted);
    assert.equal(created.length,0);
    player.audio.finish();await player.ended();await player.saves;
    assert.equal(player.audio.src,`https://server.test/${name}/1`);assert.equal(player.playing,true);assert.equal(calls,1);
  });
});

test('changing books aborts pending bytes and discards a late fetch response',async t=>{
  let respond,signal;
  const pending=new Promise(resolve=>{respond=resolve;});t.after(()=>respond(new Response('late')));
  const {player,created}=setup(t,(_url,options)=>{signal=options.signal;return pending;});
  await player.open(book('a'));player.audio.metadata();await ready(()=>!!signal);
  await player.open(book('b'),{autoplay:false});
  assert.equal(signal.aborted,true);
  respond(new Response('late'));await turn();await turn();
  assert.equal(created.length,0);assert.equal(player.book.id,'b');assert.equal(player.audio.src,'https://server.test/b/0');assert.equal(player.audio.paused,true);
});
