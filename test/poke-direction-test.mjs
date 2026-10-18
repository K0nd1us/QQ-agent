import assert from 'node:assert/strict';
import {bootApp,waitFor,sleep} from './_harness.mjs';
import {normalizePokeEvent} from '../src/poke-event.js';
const common={post_type:'notice',notice_type:'notify',sub_type:'poke',self_id:888};
assert.equal(normalizePokeEvent({...common,user_id:777,sender_id:888,target_id:777},'888'),null);
assert.equal(normalizePokeEvent({...common,user_id:888,target_id:777},'888'),null);
assert.equal(normalizePokeEvent({...common,user_id:777,sender_id:'invalid',target_id:888},'888'),null);
assert.equal(normalizePokeEvent({...common,user_id:777},'888'),null);
assert.equal(normalizePokeEvent({...common,user_id:777,sender_id:777,target_id:888},'888').operatorId,'777');
assert.equal(normalizePokeEvent({...common,user_id:777,target_id:888},'888').targetId,'888');
assert.equal(normalizePokeEvent({...common,group_id:456,user_id:111,target_id:222},'888').operatorId,'111');
const originalFetch=globalThis.fetch;
globalThis.fetch=(url,opts)=>{const u=new URL(typeof url==='string'?url:url.url);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('Offline test: non-loopback request blocked');return originalFetch(url,opts);};
const ctx=await bootApp();
try{
 await waitFor(()=>ctx.app.onebot.selfId==='888');ctx.app.orchestrator.setPaused(true);
 const read=k=>ctx.app.store.recent(k,{limit:20});
 await ctx.app.sender.poke('private:777');
 assert.match(read('private:777').at(-1).text,/机器人发出.*我\(QQ:888\).*对方\(QQ:777\)/);
 const before=read('private:777').length;
 ctx.onebotWs.push({...common,user_id:777,sender_id:888,target_id:777});
 await sleep(150);assert.equal(read('private:777').length,before,'own echo must not enter input');
 ctx.onebotWs.push({...common,user_id:777,sender_id:777,target_id:888});
 await waitFor(()=>read('private:777').length===before+1);
 let e=read('private:777').at(-1);assert.equal(e.senderId,'777');assert.match(e.text,/拍了拍 我$/);assert.equal(e.isPoke,true);
 // The real reply poke immediately after a bot poke must not be time-window suppressed.
 ctx.onebotWs.push({...common,user_id:777,sender_id:777,target_id:777});
 await waitFor(()=>read('private:777').length===before+2);assert.match(read('private:777').at(-1).text,/拍了拍自己$/);
 ctx.onebotWs.push({...common,group_id:456,user_id:111,target_id:888});
 await waitFor(()=>read('group:456').length===1);assert.equal(read('group:456')[0].senderId,'111');
 ctx.onebotWs.push({...common,group_id:456,user_id:888,target_id:111});await sleep(150);assert.equal(read('group:456').length,1);
 const {getTool}=await import('../src/tool-registry.js');const tool=getTool('send_poke');
 const fake={kind:'private',chatKey:'private:777',session:{sent:[]},sender:{poke:async()=>({})}};await tool.execute(fake,{});assert.equal(fake.session.sent.length,1);assert.equal(fake.session.sent[0].type,'poke');
 fake.session.sent=[];fake.sender.poke=async()=>{throw new Error('synthetic failure')};await tool.execute(fake,{});assert.equal(fake.session.sent.length,0);
 assert.equal(ctx.app.sessions.listSummaries(20).length,0,'paused fixture must make no model runs');
 console.log('PASS NapCat private directions, bot echo filtered, immediate user reply retained, self-poke/group handling, explicit outbound actor; no real model/QQ');
}finally{await ctx.teardown();}
