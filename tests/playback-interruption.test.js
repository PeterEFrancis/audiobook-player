import test from 'node:test';
import assert from 'node:assert/strict';
import {Player} from '../js/player.js';
import {db} from '../js/db.js';

class FakeAudio extends EventTarget {
  constructor() { super(); Object.assign(this,{paused:true,currentTime:0,duration:NaN,readyState:0,playbackRate:1,volume:1,playCalls:0,pauseCalls:0,loadCalls:0}); }
  set src(value) { this._src=this.currentSrc=value; this.currentTime=0; this.duration=NaN; this.readyState=0; }
  get src() { return this._src; }
  async play() { this.playCalls++; this.paused=false; this.dispatchEvent(new Event('playing')); }
  pause() { this.pauseCalls++; const active=!this.paused; this.paused=true; if(active&&!this.deferPause)this.dispatchEvent(new Event('pause')); }
  load() { this.loadCalls++; }
  metadata() { this.duration=100;this.readyState=4;this.dispatchEvent(new Event('loadedmetadata')); }
}
const selected={id:'book',serverId:'plex',title:'Book',author:'Author',tracks:[{id:'track',title:'Chapter',duration:100,key:'/audio'}]};
const settle=async player=>{await new Promise(setImmediate);await player.saves;};
function setup(t,{full=true}={}) {
  const globals=['Audio','document','window','navigator'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
  const session=full?Object.assign(new EventTarget(),{type:'playback',state:'active'}):{type:'playback'};
  const handlers=new Map(),writes=[];
  const mediaSession={setActionHandler:(action,handler)=>handlers.set(action,handler),setPositionState(){}};
  Object.defineProperties(globalThis,{
    Audio:{configurable:true,value:FakeAudio},
    document:{configurable:true,value:Object.assign(new EventTarget(),{hidden:true})},
    window:{configurable:true,value:new EventTarget()},
    navigator:{configurable:true,value:{userAgent:'iPhone',onLine:true,audioSession:session,mediaSession}},
  });
  t.mock.method(db,'get',async()=>undefined);
  t.mock.method(db,'put',async(store,value)=>writes.push({store,value:structuredClone(value)}));
  const player=new Player({plex:{mediaURL:()=> 'https://server.test/audio'},downloads:{hasTrack:async()=>false},getServer:()=>({}),artworkURL:()=>''});
  t.after(()=>{clearInterval(player.timer);for(const[key,descriptor]of globals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  return {player,session,handlers,mediaSession,writes};
}

for(const event of ['visibilitychange','pageshow']) test(`${event} reconciles a missed native pause immediately while storage is blocked`,async t=>{
  const {player,mediaSession,writes}=setup(t,{full:false});
  await player.open(selected);player.audio.metadata();await settle(player);
  const audio=player.audio,source=audio.src,plays=audio.playCalls,listened=player.session.listened;
  audio.currentTime=42.5;audio.paused=true;player.lastTick=Date.now()-40000;
  let unblock;const blocked=new Promise(resolve=>{unblock=resolve;});t.after(unblock);
  const put=db.put;db.put=async(...args)=>{await blocked;return put(...args);};
  const changes=[];player.addEventListener('change',()=>changes.push(player.playing));
  document.hidden=false;(event==='pageshow'?window:document).dispatchEvent(new Event(event));
  assert.equal(changes.at(-1),false);assert.equal(player.playing,false);
  assert.equal(player.resumeRequired,true);
  assert.equal(player.listening,false);assert.equal(player.playbackStarted,false);
  assert.equal(player.session.listened,listened);assert.ok(Date.now()-player.lastTick<1000);
  assert.equal(mediaSession.playbackState,'paused');assert.ok(player.pausedAt>0);
  assert.equal(audio.src,source);assert.equal(audio.playCalls,plays);assert.equal(audio.loadCalls,0);
  unblock();await settle(player);
  const progress=writes.filter(row=>row.store==='progress').at(-1).value;
  const sync=writes.filter(row=>row.store==='sync').at(-1).value;
  assert.equal(progress.position,42.5);assert.equal(progress.trackIndex,0);
  assert.equal(sync.position,42.5);assert.equal(sync.state,'stopped');
});

test('audio-session interruption pauses once without unloading and does not resume when active returns',async t=>{
  const {player,session,mediaSession,writes}=setup(t);
  await player.open(selected);player.audio.metadata();await settle(player);
  const audio=player.audio,source=audio.src,plays=audio.playCalls,pauses=audio.pauseCalls;
  audio.currentTime=27;audio.playbackRate=1.5;audio.volume=.4;
  session.state='interrupted';session.dispatchEvent(new Event('statechange'));
  assert.equal(player.playing,false);assert.equal(mediaSession.playbackState,'paused');
  assert.ok(audio.pauseCalls>pauses);assert.equal(audio.src,source);assert.equal(audio.loadCalls,0);
  assert.equal(player.position,27);assert.equal(player.speed,1.5);assert.equal(audio.volume,.4);
  session.state='active';session.dispatchEvent(new Event('statechange'));
  assert.equal(audio.playCalls,plays);assert.equal(audio.paused,true);
  document.hidden=false;
  for(const type of ['play','playing']) {
    audio.paused=false;audio.dispatchEvent(new Event(type));
    assert.equal(audio.paused,true);assert.equal(player.playing,false);
  }
  window.dispatchEvent(new Event('pageshow'));
  assert.equal(player.resumeRequired,true);assert.equal(audio.playCalls,plays);
  await settle(player);assert.equal(writes.filter(row=>row.store==='sync').at(-1).value.state,'stopped');
  await player.play();
  assert.equal(player.resumeRequired,false);assert.equal(player.playing,true);
  assert.equal(audio.playCalls,plays+1);assert.equal(player.position,27);
  assert.equal(player.speed,1.5);assert.equal(audio.volume,.4);assert.equal(audio.loadCalls,0);
});

test('foreground reconciliation leaves active playback running',async t=>{
  const {player,mediaSession}=setup(t);
  await player.open(selected);player.audio.metadata();await settle(player);
  const audio=player.audio,source=audio.src,plays=audio.playCalls,pauses=audio.pauseCalls;
  const changes=[];player.addEventListener('change',()=>changes.push(player.playing));
  document.hidden=false;document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pageshow'));
  assert.equal(changes.at(-1),true);assert.equal(player.playing,true);assert.equal(mediaSession.playbackState,'playing');
  assert.equal(audio.playCalls,plays);assert.equal(audio.pauseCalls,pauses);assert.equal(audio.loadCalls,0);assert.equal(audio.src,source);
});

test('remote Pause updates controls before storage or a deferred native pause event completes',async t=>{
  const {player,handlers,mediaSession}=setup(t,{full:false});
  await player.open(selected);player.audio.metadata();await settle(player);
  let unblock;const blocked=new Promise(resolve=>{unblock=resolve;});t.after(unblock);
  const put=db.put;db.put=async(...args)=>{await blocked;return put(...args);};
  player.audio.deferPause=true;
  const changes=[];player.addEventListener('change',()=>changes.push(player.playing));
  const pausing=handlers.get('pause')({});
  assert.equal(changes.at(-1),false);assert.equal(player.playing,false);assert.equal(mediaSession.playbackState,'paused');
  assert.equal(player.resumeRequired,true);
  unblock();await pausing;await settle(player);
});

test('an external pause with a stale paused flag blocks native, system, and automatic restarts',async t=>{
  const {player,handlers,mediaSession}=setup(t,{full:false});
  const twoTracks={...selected,tracks:[...selected.tracks,{id:'next',title:'Next chapter',duration:100,key:'/next'}]};
  await player.open(twoTracks);player.audio.metadata();await settle(player);
  const audio=player.audio,source=audio.src,calls=audio.playCalls;
  audio.currentTime=33;
  audio.dispatchEvent(new Event('pause'));
  assert.equal(audio.paused,true);assert.equal(player.resumeRequired,true);
  assert.equal(player.playing,false);assert.equal(mediaSession.playbackState,'paused');
  document.hidden=false;document.dispatchEvent(new Event('visibilitychange'));
  for(const type of ['play','playing']) {
    audio.paused=false;audio.dispatchEvent(new Event(type));
    assert.equal(audio.paused,true);assert.equal(player.playing,false);
  }
  await handlers.get('play')({});
  await player.continuePlayback();
  audio.ended=true;await player.ended();
  assert.equal(audio.playCalls,calls);assert.equal(audio.src,source);
  assert.equal(player.index,0);assert.equal(player.position,33);assert.equal(audio.loadCalls,0);
  audio.ended=false;
  await player.play();
  assert.equal(player.resumeRequired,false);assert.equal(player.playing,true);
  assert.equal(audio.playCalls,calls+1);assert.equal(player.position,33);
});

test('a delayed pause from an internal source change does not block the selected book',async t=>{
  const {player}=setup(t,{full:false});
  await player.open(selected);player.audio.metadata();await settle(player);
  player.audio.deferPause=true;
  await player.open({...selected,id:'other'});player.audio.metadata();
  assert.equal(player.playing,true);
  player.audio.dispatchEvent(new Event('pause'));
  assert.equal(player.resumeRequired,false);assert.equal(player.playing,true);
  assert.equal(player.book.id,'other');
});

test('a source load that cancels its old pause cannot hide a later real interruption',async t=>{
  const {player}=setup(t,{full:false});
  await player.open(selected);player.audio.metadata();await settle(player);
  player.audio.deferPause=true;
  await player.open({...selected,id:'other'});player.audio.metadata();
  player.audio.dispatchEvent(new Event('loadstart'));
  player.audio.deferPause=false;
  player.audio.pause();
  assert.equal(player.resumeRequired,true);assert.equal(player.playing,false);
  const calls=player.audio.playCalls;
  document.hidden=false;window.dispatchEvent(new Event('pageshow'));
  player.audio.paused=false;player.audio.dispatchEvent(new Event('playing'));
  assert.equal(player.audio.paused,true);assert.equal(player.audio.playCalls,calls);
});
