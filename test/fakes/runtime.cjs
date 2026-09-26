#!/usr/bin/env node
const fs=require('fs'),path=require('path'),net=require('net'),{spawn}=require('child_process'),{randomUUID}=require('crypto');
const root=process.env.MUSTER_FAKE_ROOT;
if(!root)throw new Error('Fake requires isolated root');
// Threads and writer locks live under CODEX_HOME, resolved the way real Codex
// resolves it, because that is the property under test: a thread created by an
// agent launched under a per-launch identity copy must be invisible to anything
// reading the operator's own CODEX_HOME. Keyed off MUSTER_FAKE_ROOT this store
// was shared by every launch, which made a Codex identity launch that works
// indistinguishable from one that does not.
const codexHome=process.env.CODEX_HOME||path.join(process.env.HOME||root,'.codex');
const records=path.join(codexHome,'threads');fs.mkdirSync(records,{recursive:true});
const argv=process.argv.slice(2), runtime=path.basename(process.argv[1]).startsWith('claude')?'claude':'codex';
const live=()=>fs.readdirSync(records).map(f=>JSON.parse(fs.readFileSync(path.join(records,f),'utf8'))).filter(t=>{try{process.kill(t.pid,0);return true;}catch{return false;}});
if(argv.includes('--version')){console.log('fake 1');process.exit(0);}
if(argv.includes('mcp')&&argv.includes('list')){
 if(process.env.MUSTER_FAKE_MCP_FAIL_CONFIG==='1' && argv.some(v=>v.startsWith('mcp_servers.fixture='))){console.error('config failed');process.exit(1);}
 // Real codex rejects --ignore-user-config on `mcp list`; it is an exec flag.
 if(argv.includes('--ignore-user-config')){console.error("error: unexpected argument '--ignore-user-config' found");process.exit(2);}
 const entries=Object.fromEntries((process.env.MUSTER_FAKE_MCP||'').split(',').filter(Boolean).map(name=>[name,true]));
 for(let i=0;i<argv.length;i++) if(argv[i]==='-c') {
  const value=argv[++i];
  let match=/^mcp_servers\.([a-zA-Z0-9_-]+)\.enabled=(true|false)$/.exec(value);
  if(match) entries[match[1]]=match[2]==='true';
  match=/^mcp_servers\.([a-zA-Z0-9_-]+)=/.exec(value);
  if(match) entries[match[1]]=/enabled\s*=\s*true/.test(value);
 }
 if(process.env.MUSTER_FAKE_IGNORE_MCP_DISABLE==='1') for(const name of Object.keys(entries)) entries[name]=true;
 console.log(JSON.stringify(Object.entries(entries).map(([name,enabled])=>({name,enabled}))));process.exit(0);
}

if(argv.includes('app-server')){
 let experimental=false,buffer='';
 process.stdin.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\n'))>=0){
  const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;
  const m=JSON.parse(line);let result,error;
  const threads=live();
  if(m.method==='initialize'){experimental=m.params.capabilities?.experimentalApi===true;result={userAgent:'fake'};}
  else if(m.method==='thread/list')result={data:threads.filter(t=>Date.now()>=t.readyAt).map(t=>({...t,status:'idle',canAcceptDirectInput:true})),nextCursor:null};
  else if(m.method==='thread/read'){
   const t=threads.find(t=>t.id===m.params.threadId);
   if(t?.ephemeral&&process.env.MUSTER_FAKE_REVIEWER==='unloaded')error={code:-32600,message:'thread not loaded: '+t.id};
   else if(!t||Date.now()<t.readyAt)error={code:-32600,message:'no rollout found for thread id '+m.params.threadId};
   else result={thread:{...t,status:{type:'idle'},canAcceptDirectInput:t.canAcceptDirectInput??true}};
  }else if(m.method==='thread/queue/add'){
   if(!experimental)error={code:-32600,message:'requires experimentalApi'};
   else {const t=threads.find(t=>t.id===m.params.threadId);if(!t)error={code:-32600,message:'no thread'};
    else {fs.appendFileSync(path.join(root,'receipts.jsonl'),JSON.stringify({uuid:t.id,pid:t.pid,input:m.params.input})+'\n');result={queuedSubmission:{id:randomUUID()}};}}
  }else error={code:-32601,message:'unknown method'};
  process.stdout.write(JSON.stringify({id:m.id,...(error?{error}:{result})})+'\n');
 }});process.stdin.on('end',()=>process.exit(0));
}else{
 if(process.env.MUSTER_FAKE_EXIT==='1')process.exit(7);
 if(process.env.MUSTER_FAKE_ORPHAN==='1'){
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  fs.appendFileSync(path.join(root,'orphan.jsonl'),JSON.stringify({pid:child.pid})+'\n');
  setTimeout(()=>process.exit(7),400);return;
 }

 const depth=Number(process.env.MUSTER_FAKE_NEST||0);
 if(depth>0){const child=spawn(process.execPath,[process.argv[1],...argv],{env:{...process.env,MUSTER_FAKE_NEST:String(depth-1)},stdio:'inherit'});child.on('exit',code=>process.exit(code||0));}
 else {
  const id=randomUUID(),prompt=argv[argv.length-1],isTask=argv.includes('exec')||argv.includes('-p');
  const state={id,pid:process.pid,name:prompt,cwd:process.cwd(),source:isTask?'exec':'cli',readyAt:Date.now()+Number(process.env.MUSTER_FAKE_READY_MS||0)};
  if(process.env.MUSTER_FAKE_SOURCE)state.source=process.env.MUSTER_FAKE_SOURCE;
  // `env` is recorded so a test can assert what the agent was actually spawned
  // with — the identity variables are only observable from the child's side.
  // An ALLOWLIST, not the whole environment: `{...process.env}` wrote a
  // developer's entire shell environment into a temp file on every fixture
  // launch. Only the keys tests actually assert are recorded; add a key here
  // when a test needs it, rather than widening this back to everything.
  const RECORDED=['CODEX_HOME','CLAUDE_CONFIG_DIR','CLAUDE_CODE_OAUTH_TOKEN','OPENCODE_CONFIG_DIR','XDG_DATA_HOME','HOME','PATH','LANG'];
  const env={};for(const k of RECORDED) if(process.env[k]!==undefined) env[k]=process.env[k];
  const startup={pid:process.pid,id,prompt,argv,runtime,env,intentPresent:fs.existsSync(path.join(process.env.MUSTER_TEST_HOME||root,'launches.jsonl'))};
  fs.appendFileSync(path.join(root,'starts.jsonl'),JSON.stringify(startup)+'\n');
  let fd,socket;
  const publish=()=>{
   if(runtime==='codex'){
    const locks=path.join(codexHome,'thread-writer-locks');fs.mkdirSync(locks,{recursive:true});const lockPath=path.join(locks,id+'.lock');
    const locker=spawn(process.env.MUSTER_FAKE_PYTHON||'python3',['-u','-c','import fcntl,sys; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()',lockPath],{stdio:['pipe','pipe','inherit']});
    locker.stdout.once('data',()=>fs.writeFileSync(path.join(records,id+'.json'),JSON.stringify(state)));
    if(process.env.MUSTER_FAKE_REVIEWER){
      const reviewId=randomUUID();
      const review=spawn(process.env.MUSTER_FAKE_PYTHON,['-u','-c','import fcntl,sys; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()',path.join(locks,reviewId+'.lock')],{stdio:['pipe','pipe','inherit']});
      review.stdout.once('data',()=>fs.writeFileSync(path.join(records,reviewId+'.json'),JSON.stringify({...state,id:reviewId,source:process.env.MUSTER_FAKE_REVIEWER==='ambiguous'?'cli':{subAgent:'review'},ephemeral:process.env.MUSTER_FAKE_REVIEWER!=='ambiguous',canAcceptDirectInput:process.env.MUSTER_FAKE_REVIEWER==='ambiguous'})));
    }


   }else{
    // Real Claude Code records its session under CLAUDE_CONFIG_DIR when set —
    // the whole configuration directory moves, sessions included.
    const sessions=process.env.CLAUDE_CONFIG_DIR?path.join(process.env.CLAUDE_CONFIG_DIR,'sessions'):path.join(process.env.HOME,'.claude','sessions');fs.mkdirSync(sessions,{recursive:true});
    const socketPath=path.join(root,process.pid+'.sock');
    fs.writeFileSync(path.join(sessions,process.pid+'.json'),JSON.stringify({pid:process.pid,sessionId:id,name:prompt,cwd:process.cwd(),status:'idle',messagingSocketPath:socketPath}));
    fs.writeFileSync(path.join(sessions,process.pid+'.'+'a'.repeat(64)+'.key'),JSON.stringify({peerToken:'b'.repeat(32),procStart:'fake',pidDomain:'darwin'}));
    socket=net.createServer(conn=>{let buffer='',authenticated=false;conn.on('error',()=>{});conn.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){const frame=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(frame.type==='auth'&&frame.peerToken==='b'.repeat(32))authenticated=true;if(frame.type==='user'&&authenticated)fs.appendFileSync(path.join(root,'receipts.jsonl'),JSON.stringify({uuid:id,pid:process.pid,frame})+'\n');}});});
    setTimeout(()=>socket.listen(socketPath),Math.max(0,state.readyAt-Date.now()));
   }
  };
  if(isTask){console.log('TASK_OUTPUT:'+prompt);setTimeout(()=>process.exit(0),Number(process.env.MUSTER_FAKE_TASK_MS||100));}
  else {setTimeout(publish,Number(process.env.MUSTER_FAKE_ID_MS||0));setInterval(()=>{},1000);}
 }
}
