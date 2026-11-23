import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),"split-pair-http-")),sock=path.join(root,"native.sock");
const home=path.join(root,"home");fs.mkdirSync(home);const seen=[];let reply={ok:true,supported:true,sdk:32,phase:"opening",path:"fullscreen"};
const peers=new Set();
const native=net.createServer(c=>{peers.add(c);c.on("close",()=>peers.delete(c));let buffer="";c.on("data",chunk=>{buffer+=chunk;if(!buffer.includes("\n"))return;const request=JSON.parse(buffer.split("\n")[0]);seen.push(request);c.end(JSON.stringify(reply)+"\n");});});
await new Promise(r=>native.listen(sock,r));
const portProbe=net.createServer();await new Promise(r=>portProbe.listen(0,"127.0.0.1",r));const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
const gateway=path.resolve(new URL("..",import.meta.url).pathname),prefix=process.env.PREFIX||"/data/user/0/cc.codroid/files/usr";
const env={...process.env,HOME:home,CCAPP_TEST:"1",CCAPP_HOME:home,CCAPP_WORKSPACE:home,CCAPP_PREFIX:prefix,CCAPP_PRIV_SOCK:sock,CCAPP_TOKEN_FILE:home+"/token",CCAPP_LOG:home+"/log",CCAPP_SHARED:""};
let child,token,checks=0,log="";
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function call(method,body,authenticated=true){
 const r=await fetch("http://127.0.0.1:"+port+"/api/app/shz_split_settings",{method,headers:{"content-type":"application/json",...(authenticated?{"x-cc-token":token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {status:r.status,data:await r.json()};
}
async function check(name,fn){await fn();checks++;console.log("ok "+checks+" "+name);}
try{
 child=spawn(process.execPath,[gateway+"/server.mjs",String(port)],{cwd:gateway,env,stdio:["ignore","pipe","pipe"]});
 child.stdout.on("data",d=>log+=d);child.stderr.on("data",d=>log+=d);
 for(let i=0;i<100;i++){try{token=fs.readFileSync(home+"/token","utf8").trim();if((await call("GET")).status===405)break;}catch{}await wait(100);}
 assert(token,"gateway did not start: "+log.slice(-500));
 await check("unauthenticated request cannot launch Settings",async()=>{const before=seen.length;assert.equal((await call("POST",{},false)).status,403);assert.equal(seen.length,before);});
 await check("GET is read-only and never reaches native launcher",async()=>{const before=seen.length;assert.equal((await call("GET")).status,405);assert.equal(seen.length,before);});
 await check("POST forwards only the fixed split operation, never arbitrary intents or codes",async()=>{const r=await call("POST",{code:"123456",uri:"https://invalid.example",flags:123});assert.equal(r.status,200);assert.equal(r.data.phase,"opening");assert.deepEqual(seen.at(-1),{op:"shz_split_settings"});});
 await check("native capability and manual fallback are returned without pretending pairing succeeded",async()=>{reply={ok:true,supported:true,sdk:31,phase:"manual",message:"manual"};const r=await call("POST",{});assert.equal(r.data.phase,"manual");assert.equal(r.data.sdk,31);assert(!r.data.paired);});
 await check("foreground denial remains a failure",async()=>{reply={ok:false,message:"foreground required"};const r=await call("POST",{});assert.equal(r.data.ok,false);});
 await check("version refusal is preserved",async()=>{reply={ok:false,supported:false,sdk:23};const r=await call("POST",{});assert.equal(r.data.supported,false);assert.equal(r.data.ok,false);});
 console.log(checks+"/"+checks+" passed");
}finally{
 if(child?.exitCode===null){child.kill();await new Promise(r=>child.once("exit",r));}
 for(const p of peers)p.destroy();await new Promise(r=>native.close(r));fs.rmSync(root,{recursive:true,force:true});
}
