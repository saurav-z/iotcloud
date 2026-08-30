import React,{useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlow,Background,Controls,MiniMap,addEdge,useEdgesState,useNodesState,Connection,Node} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';

const DEFAULT_API='https://iotcloud-api-a04c.onrender.com';

function normalizeApi(raw:string){
  let value=(raw||'').trim().replace(/\/+$/,'');
  if(!value) return '';
  if(!/^https?:\/\//i.test(value)) value='https://'+value;
  return value.replace(/^http:\/\//i,'https://');
}
function apiBase(){return normalizeApi(localStorage.getItem('iotcloud_api_url')||import.meta.env.VITE_API_URL||DEFAULT_API)}
function wsBase(){return apiBase().replace(/^https:\/\//i,'wss://')}
async function api(path:string,opts:RequestInit={}){
  const token=localStorage.getItem('iot_token');
  const base=apiBase();
  const headers:Record<string,string>={'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})};
  Object.entries((opts.headers||{}) as Record<string,string>).forEach(([k,v])=>headers[k]=v);
  const r=await fetch(base+path,{...opts,headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
  return data;
}

const palette=[['mqtt.trigger','MQTT Trigger'],['webhook.trigger','Webhook Trigger'],['logic.if','IF / Condition'],['logic.filter','Filter'],['action.telegram.send','Telegram'],['action.discord.send','Discord'],['action.email.send','Email'],['action.webhook.send','HTTP Webhook'],['iot.mqtt.publish','MQTT Publish'],['event.trigger','Event Trigger']];

function App(){
  const[token,setToken]=useState(localStorage.getItem('iot_token'));
  const[page,setPage]=useState(()=>window.location.hash.replace('#','')||'events');
  const[project,setProject]=useState<any>(null);
  const[projects,setProjects]=useState<any[]>([]);
  const[devices,setDevices]=useState<any[]>([]);
  const[events,setEvents]=useState<any[]>([]);
  const[connected,setConnected]=useState(false);
  const[apiUrl,setApiUrl]=useState(apiBase());

  const navigate=(p:string)=>{
    setPage(p);
    window.location.hash=p;
  };

  useEffect(()=>{
    const handle=()=>{
      const p=window.location.hash.replace('#','')||'events';
      const valid=['events','dashboard','devices','workflows','developer','settings','credentials'];
      if(valid.includes(p)) setPage(p);
    };
    window.addEventListener('hashchange',handle);
    return()=>window.removeEventListener('hashchange',handle);
  },[]);

  useEffect(()=>{if(!token)return;
    api('/api/projects').then(async(p)=>{
      setProjects(p);
      if(p[0]){
        const ds=await api(`/api/projects/${p[0].id}/devices`);
        setDevices(ds); setProject({...p[0],__deviceToken:ds[0]?.token||''});
      }
    }).catch(()=>{localStorage.removeItem('iot_token');setToken(null)})
  },[token]);

  useEffect(()=>{
    if(!project || !project.__deviceToken){setConnected(false);return}
    let es:EventSource|undefined;
    const url=`${apiBase()}/v1/events?token=${encodeURIComponent(project.__deviceToken)}`;
    try{
      es=new EventSource(url);
      es.onopen=()=>setConnected(true);
      es.onerror=()=>setConnected(false);
      es.addEventListener('mqtt.message',(e:any)=>{
        try{setEvents(v=>[JSON.parse(e.data),...v].slice(0,250))}catch{}
      });
      es.addEventListener('device.online',(e:any)=>{try{setEvents(v=>[JSON.parse(e.data),...v].slice(0,250))}catch{}});
      es.addEventListener('device.offline',(e:any)=>{try{setEvents(v=>[JSON.parse(e.data),...v].slice(0,250))}catch{}});
      es.addEventListener('webhook',(e:any)=>{try{setEvents(v=>[JSON.parse(e.data),...v].slice(0,250))}catch{}});
    }catch{}
    return()=>{es?.close();setConnected(false)}
  },[project?.id,project?.__deviceToken,apiUrl]);

  if(!token)return <Auth onLogin={(t)=>{localStorage.setItem('iot_token',t);setToken(t)}}/>;

  async function selectProject(p:any){
    const ds=await api(`/api/projects/${p.id}/devices`);
    setDevices(ds);setProject({...p,__deviceToken:ds[0]?.token||''});
  }
  async function newProject(){
    const name=prompt('Project name');
    if(!name)return;
    const p=await api('/api/projects',{method:'POST',body:JSON.stringify({name})});
    setProjects(v=>[p,...v]);await selectProject(p);
  }

  return <div className="appShell">
    <aside className="sidebar">
      <div className="brand"><div className="brandMark">◈</div><div>IoT<span>Cloud</span></div></div>
      <div className="projectBox">
        <div className="sideLabel">PROJECT</div>
        <select value={project?.id||''} onChange={e=>selectProject(projects.find(p=>p.id===e.target.value))}>
          {!projects.length&&<option value="">No projects</option>}
          {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="ghostBtn" onClick={newProject}>＋ New project</button>
      </div>
      <nav>
        {[
          ['events','◎','Live Events'],
          ['dashboard','⌂','Overview'],
          ['devices','◉','Devices'],
          ['workflows','⌘','Workflows'],
          ['developer','</>','Developer'],
          ['settings','⚙','Settings'],
          ['credentials','⚿','Credentials']
        ].map(([id,icon,label])=><button key={id} className={`navItem ${page===id?'active':''}`} onClick={()=>navigate(id)}><b>{icon}</b><span>{label}</span></button>)}
      </nav>
      <div className="sideBottom">
        <div className={`connection ${connected?'online':''}`}><i/>{connected?'Live connection':'Disconnected'}</div>
        <button className="navItem" onClick={()=>{localStorage.removeItem('iot_token');setToken(null)}}><b>↪</b><span>Sign out</span></button>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div><div className="crumb">IoTCloud / {project?.name||'No project'}</div><h1>{pageTitle(page)}</h1></div>
        <div className="topActions">
          <button className="apiPill" onClick={()=>navigate('settings')}><i/>{new URL(apiBase()).host}</button>
          <div className="avatar">{(localStorage.getItem('iot_email')||'U')[0].toUpperCase()}</div>
        </div>
      </header>
      {!project?<EmptyState text="Create a project to start receiving events."/>:
        page==='events'?<Events project={project} devices={devices} events={events} setEvents={setEvents} onRefresh={async()=>{const ds=await api(`/api/projects/${project.id}/devices`);setDevices(ds);setProject({...project,__deviceToken:ds[0]?.token||''})}}/>:
        page==='dashboard'?<Dashboard events={events} connected={connected} devices={devices}/>:
        page==='devices'?<Devices project={project} devices={devices} setDevices={setDevices} setProject={setProject}/>:
        page==='workflows'?<Workflows project={project}/>:
        page==='developer'?<Developer project={project} devices={devices}/>:
        page==='settings'?<Settings apiUrl={apiUrl} setApiUrl={(v)=>{const n=normalizeApi(v);localStorage.setItem('iotcloud_api_url',n);setApiUrl(n);location.reload()}}/>:
        <Credentials project={project}/>
      }
    </main>
  </div>
}
function pageTitle(p:string){return ({events:'Live Events',dashboard:'Overview',devices:'Devices',workflows:'Workflow Editor',developer:'Developer Center',settings:'Connection Settings',credentials:'Credentials'} as any)[p]||'IoTCloud'}

function Auth({onLogin}:{onLogin:(t:string)=>void}){
 const[mode,setMode]=useState<'login'|'register'>('register');const[email,setEmail]=useState('');const[pw,setPw]=useState('');const[err,setErr]=useState('');
 return <div className="authPage"><div className="authGlow"/><div className="authCard">
  <div className="brand big"><div className="brandMark">◈</div><div>IoT<span>Cloud</span></div></div>
  <div className="authEyebrow">REALTIME IOT INFRASTRUCTURE</div><h1>{mode==='register'?'Build your realtime IoT stack.':'Welcome back.'}</h1>
  <p>Publish, observe and automate device events from one clean control plane.</p>
  {err&&<div className="error">{err}</div>}
  <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email address"/>
  <input value={pw} onChange={e=>setPw(e.target.value)} placeholder="Password (8+ chars)" type="password"/>
  <button className="primary wide" onClick={async()=>{try{const r=await fetch(normalizeApi(localStorage.getItem('iotcloud_api_url')||import.meta.env.VITE_API_URL||DEFAULT_API)+`/api/auth/${mode}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:pw})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Authentication failed');localStorage.setItem('iot_email',email);onLogin(d.token)}catch(e:any){setErr(e.message)}}}>{mode==='register'?'Create account':'Sign in'}</button>
  <button className="linkBtn" onClick={()=>setMode(mode==='register'?'login':'register')}>{mode==='register'?'Already have an account? Sign in':'Need an account? Create one'}</button>
  <div className="endpointMini">API <code>{new URL(apiBase()).host}</code><span>● HTTPS</span></div>
 </div></div>
}

function Events({project,devices,events,setEvents,onRefresh}:{project:any;devices:any[];events:any[];setEvents:any;onRefresh:any}){
 const[selected,setSelected]=useState(devices[0]?.id||'');const[topic,setTopic]=useState('events');const[payload,setPayload]=useState('{"message":"Hello from IoTCloud"}');const[filter,setFilter]=useState('');const[status,setStatus]=useState('');
 useEffect(()=>{if(!selected&&devices[0])setSelected(devices[0].id)},[devices]);
 const filtered=useMemo(()=>events.filter(e=>!filter||JSON.stringify(e).toLowerCase().includes(filter.toLowerCase())),[events,filter]);
 async function send(){
   const d=devices.find(x=>x.id===selected);if(!d){setStatus('Create/select a device first.');return}
   try{const data=JSON.parse(payload);await fetch(`${apiBase()}/api/device/publish`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${d.token}`},body:JSON.stringify({deviceId:d.id,topic,data})}).then(async r=>{const x=await r.json().catch(()=>({}));if(!r.ok)throw new Error(x.error||`HTTP ${r.status}`)});setStatus('Published successfully');setTimeout(()=>setStatus(''),1800)}
   catch(e:any){setStatus(e.message)}
 }
 return <div className="eventsPage">
   <div className="heroRow"><div><div className="liveBadge"><i/> LIVE STREAM</div><h2>Everything happening in your project.</h2><p>Watch MQTT messages, device presence and webhooks arrive in real time.</p></div><button className="outlineBtn" onClick={()=>setEvents([])}>Clear stream</button></div>
   <div className="eventLayout">
    <section className="streamPanel panel">
      <div className="panelHead"><div><b>Event stream</b><span>{filtered.length} visible</span></div><input className="search" placeholder="Filter events..." value={filter} onChange={e=>setFilter(e.target.value)}/></div>
      <div className="stream">{filtered.length?filtered.map((e,i)=><EventRow key={e.id||i} e={e}/>):<EmptyState text="Waiting for events… publish something on the right or connect a device."/>}</div>
    </section>
    <aside className="publishPanel panel">
      <div className="panelHead"><div><b>Publish event</b><span>Live → MQTT → stream</span></div></div>
      <label>Device<select value={selected} onChange={e=>setSelected(e.target.value)}>{devices.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label>Topic<input value={topic} onChange={e=>setTopic(e.target.value)} placeholder="telemetry"/></label>
      <label>JSON payload<textarea value={payload} onChange={e=>setPayload(e.target.value)}/></label>
      <button className="primary wide" onClick={send}>Publish event <span>↗</span></button>
      {status&&<div className={`sendStatus ${status.includes('success')?'ok':''}`}>{status}</div>}
      <div className="hint"><b>ntfy-style workflow</b><br/>Choose a device, enter a topic and JSON payload, then watch the event appear instantly in the stream.</div>
    </aside>
   </div>
 </div>
}
function EventRow({e}:{e:any}){
 const [open,setOpen]=useState(false);return <div className="eventRow" onClick={()=>setOpen(!open)}>
   <div className={`eventIcon ${e.type?.includes('offline')?'warn':e.type?.includes('online')?'good':''}`}>{e.type==='mqtt.message'?'↯':e.type?.includes('online')?'●':'◆'}</div>
   <div className="eventMain"><div className="eventTitle"><b>{e.type||'event'}</b>{e.topic&&<code>{e.topic}</code>}</div><div className="eventMeta">{e.deviceId||'gateway'} · {formatTime(e.timestamp)}</div>{open&&<pre>{JSON.stringify(e.data??{},null,2)}</pre>}</div>
   <span className="chev">{open?'⌃':'›'}</span>
 </div>
}
function formatTime(v:any){if(!v)return 'now';try{return new Date(v).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch{return String(v)}}

function Dashboard({events,connected,devices}:{events:any[];connected:boolean;devices:any[]}){
 const online=devices.filter(d=>d.online).length;return <div><div className="statsGrid">
  <Stat label="Connection" value={connected?'LIVE':'OFFLINE'} sub="Server-sent events"/>
  <Stat label="Devices" value={devices.length} sub={`${online} currently online`}/>
  <Stat label="Events" value={events.length} sub="Buffered in this session"/>
  <Stat label="Transport" value="TLS" sub="HTTPS / WSS"/>
 </div><div className="dashGrid"><section className="panel"><div className="panelHead"><div><b>Recent activity</b><span>Live session</span></div></div>{events.slice(0,8).map((e,i)=><EventRow key={i} e={e}/>)}{!events.length&&<EmptyState text="No events yet."/ >}</section><section className="panel quick"><b>Quick start</b><div className="quickItem"><span>01</span><div><b>Add a device</b><p>Generate a device token and connect MQTT, REST or WebSocket.</p></div></div><div className="quickItem"><span>02</span><div><b>Publish telemetry</b><p>Use Live Events to send a JSON event immediately.</p></div></div><div className="quickItem"><span>03</span><div><b>Automate</b><p>Create workflows that react to incoming events.</p></div></div></section></div></div>
}
function Devices({project,devices,setDevices,setProject}:{project:any;devices:any[];setDevices:any;setProject:any}){
 const[name,setName]=useState('');async function add(){if(!name)return;const d=await api(`/api/projects/${project.id}/devices`,{method:'POST',body:JSON.stringify({name})});setDevices([d,...devices]);setName('');setProject({...project,__deviceToken:d.token})}
 return <div><div className="pageIntro"><div><h2>Devices</h2><p>Credentials, presence and endpoints for every device.</p></div><div className="addRow"><input value={name} onChange={e=>setName(e.target.value)} placeholder="New device name"/><button className="primary" onClick={add}>Add device</button></div></div><div className="deviceGrid">{devices.map(d=><div className="deviceCard" key={d.id}><div className="deviceHead"><div className={`deviceDot ${d.online?'on':''}`}/><div><b>{d.name}</b><small>{d.online?'Online':'Offline'} · {d.id.slice(0,8)}</small></div></div><div className="tokenBox"><span>DEVICE TOKEN</span><code>{d.token}</code></div><button className="outlineBtn" onClick={()=>navigator.clipboard?.writeText(d.token)}>Copy token</button></div>)}{!devices.length&&<EmptyState text="No devices yet."/ >}</div></div>
}
function Workflows({project}:{project:any}){const[flows,setFlows]=useState<any[]>([]);const[active,setActive]=useState<any>(null);useEffect(()=>{api(`/api/projects/${project.id}/workflows`).then(setFlows)},[project.id]);return <div className="workflowLayout"><div className="flowSide"><button className="primary wide" onClick={()=>setActive({id:null,name:'New workflow',definition:{nodes:[{id:'trigger',type:'mqtt.trigger',position:{x:80,y:120},data:{label:'MQTT Trigger',topic:'telemetry'}},{id:'if',type:'logic.if',position:{x:350,y:120},data:{label:'IF temperature > 30',field:'temperature',operator:'>',value:30}}],edges:[{id:'e1',source:'trigger',target:'if'}]}})}>＋ New workflow</button>{flows.map(f=><button className={`flowItem ${active?.id===f.id?'selected':''}`} onClick={()=>setActive(f)} key={f.id}><b>{f.name}</b><small>{f.enabled?'Enabled':'Draft'}</small></button>)}</div><div className="flowCanvas">{active?<WorkflowEditor project={project} workflow={active} onSaved={(f)=>{setFlows((v:any[])=>{const i=v.findIndex(x=>x.id===f.id);return i<0?[f,...v]:v.map(x=>x.id===f.id?f:x)});setActive(f)}}/>:<EmptyState text="Select a workflow or create one."/>}</div></div>}
function WorkflowEditor({project,workflow,onSaved}:{project:any;workflow:any;onSaved:(f:any)=>void}){const initial=workflow.definition||{nodes:[],edges:[]};const[nodes,setNodes,onNodesChange]=useNodesState(initial.nodes);const[edges,setEdges,onEdgesChange]=useEdgesState(initial.edges);const[selected,setSelected]=useState<Node|null>(nodes[0]||null);const[name,setName]=useState(workflow.name||'New workflow');const add=(type:string)=>{const id=crypto.randomUUID();setNodes(v=>[...v,{id,type,position:{x:100+v.length*40,y:100+v.length*20},data:{label:palette.find(x=>x[0]===type)?.[1]||type}} as Node])};return <div className="editor"><div className="nodePalette"><b>Nodes</b>{palette.map(p=><button key={p[0]} onClick={()=>add(p[0])}>{p[1]}</button>)}</div><div className="rf"><ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={(c:Connection)=>setEdges(e=>addEdge(c,e))} onNodeClick={(_,n)=>setSelected(n)} fitView><Background/><Controls/><MiniMap/></ReactFlow></div><div className="inspector"><input value={name} onChange={e=>setName(e.target.value)} className="titleInput"/><b>Node configuration</b>{selected?<NodeForm node={selected} setNodes={setNodes}/>:<small>Select a node</small>}<button className="primary save" onClick={async()=>{const body={name,definition:{nodes,edges},enabled:true};const f=workflow.id?await api(`/api/projects/${project.id}/workflows/${workflow.id}`,{method:'PUT',body:JSON.stringify(body)}):await api(`/api/projects/${project.id}/workflows`,{method:'POST',body:JSON.stringify(body)});onSaved(f)}}>Save & enable</button></div></div>}
function NodeForm({node,setNodes}:{node:Node;setNodes:any}){const d=(node.data||{}) as any;const update=(k:string,v:any)=>setNodes((ns:Node[])=>ns.map(n=>n.id===node.id?{...n,data:{...n.data,[k]:v,label:n.data?.label}}:n));return <div className="form">{['topic','field','operator','value','text','url','to'].map(k=><label key={k}>{k}<input value={d[k]??''} onChange={e=>update(k,e.target.value)}/></label>)}</div>}
function Developer({project, devices}:{project:any;devices:any[]}){const[docs,setDocs]=useState<any>();const[selectedDeviceId,setSelectedDeviceId]=useState<string>('');useEffect(()=>{api('/api/docs').then(setDocs).catch(()=>{})},[]);const base=apiBase();const baseHost=base.replace(/^https?:\/\//i,"").replace(/^\/\//,"");const wsUrl=`${base.replace(/^https?:\/\//i,'wss://')}/v1/ws?token=DEVICE_TOKEN`;const sseUrl=`${base}/v1/events?token=DEVICE_TOKEN`;const mqttUrl=`${base.replace(/^https?:\/\//i,'wss://')}/mqtt`;const selectedDevice=devices.find(d=>d.id===selectedDeviceId);const deviceId=selectedDevice?.id||'DEVICE_ID';const deviceToken=selectedDevice?.token||'DEVICE_TOKEN';const projectId=project?.id||'PROJECT_ID';const examples=useMemo(()=>{const curlPublish=`curl -X POST ${base}/api/device/publish \\\n  -H 'Authorization: Bearer ${deviceToken}' \\\n  -H 'content-type: application/json' \\\n  -d '{\n    "deviceId": "${deviceId}",\n    "topic": "telemetry",\n    "data": {"temperature": 28.4}\n  }'`;const curlResponse=`# Response 200\n{ "ok": true }\n\n# Response 403\n{ "error": "device token required" }`;const wsCode=`const ws = new WebSocket('${base.replace(/^https?:\/\//i,'wss://')}/v1/ws?token=${deviceToken}');\n\nws.onopen    = () => console.log('connected');\nws.onmessage = e => console.log(JSON.parse(e.data));\nws.onerror   = e => console.error(e);\nws.onclose   = e => console.log('closed', e.code);\n\n// Publish\nws.send(JSON.stringify({\n  action: 'publish',\n  topic: 'telemetry',\n  data: { temperature: 28.4 }\n}));`;const pythonCode=`import requests\n\n# Publish telemetry\nrequests.post(\n  '${base}/api/device/publish',\n  headers={'Authorization':'Bearer ${deviceToken}'},\n  json={\n    'deviceId':'${deviceId}',\n    'topic':'telemetry',\n    'data':{'temperature': 28.4}\n  }\n)\n\n# Response\n# { "ok": true }`;const mqttCode=`# MQTT over WebSocket\n# Broker: ${baseHost}\n# Port: 443 (WSS)\n# Topic: iotcloud/${projectId}/${deviceId}/telemetry\n\nimport paho.mqtt.client as mqtt\n\nclient = mqtt.Client(client_id='${deviceId}', transport='websockets')\nclient.connect('${baseHost}', 443, 60)\nclient.publish(\n  'iotcloud/${projectId}/${deviceId}/telemetry',\n  json.dumps({'temperature': 28.4})\n)`;const aiContext=`Project ID:   ${projectId}\nDevice ID:    ${deviceId}\nDevice Token: ${deviceToken}\n\nBase URL:     ${base}\nWebSocket:    ${base.replace(/^https?:\/\//i,'wss://')}/v1/ws?token=${deviceToken}\nSSE:          ${base}/v1/events?token=${deviceToken}\nMQTT/WS:      ${base.replace(/^https?:\/\//i,'wss://')}/mqtt\n\nTopic:        iotcloud/${projectId}/${deviceId}/telemetry\n\n# Interconnection\n# REST POST /api/device/publish  → broker.publish() → mqtt.message event\n# WebSocket /v1/ws publish action → broker.publish() → mqtt.message event\n# MQTT /mqtt publish            → broker.publish() → mqtt.message event\n# All paths converge at the broker and emit to WS + SSE clients.`;return{curlPublish,curlResponse,wsCode,pythonCode,mqttCode,aiContext};},[base,deviceId,deviceToken,projectId]);function CopyButton({text}:{text:string}){const[ok,setOk]=useState(false);return <button className="copyBtn" onClick={async()=>{try{await navigator.clipboard.writeText(text);setOk(true);setTimeout(()=>setOk(false),1200)}catch{}}}>{ok?'Copied':'Copy'}</button>}return <div className="docs"><div className="pageIntro"><div><h2>Developer Center</h2><p>Connect devices, publish telemetry, and inspect realtime endpoints.</p></div><div className="addRow"><select value={selectedDeviceId} onChange={e=>setSelectedDeviceId(e.target.value)}><option value="">Select device...</option>{devices.map(d=><option key={d.id} value={d.id}>{d.name} ({d.id.slice(0,8)})</option>)}</select></div></div><section className="panel"><div className="panelHead"><div><b>Realtime endpoints</b><span>Current API: {new URL(base).host}</span></div></div><div className="kv"><div className="item"><label>Base</label><span className="val">{base}</span></div><div className="item"><label>WebSocket</label><span className="val">{wsUrl.replace('DEVICE_TOKEN',selectedDevice?deviceToken:'DEVICE_TOKEN')}</span></div><div className="item"><label>SSE</label><span className="val">{sseUrl.replace('DEVICE_TOKEN',selectedDevice?deviceToken:'DEVICE_TOKEN')}</span></div><div className="item"><label>MQTT/WS</label><span className="val">{mqttUrl}</span></div><div className="item"><label>Topic</label><span className="val">iotcloud/{projectId}/{deviceId}/{"{topic}"}</span></div></div></section>{!selectedDevice?<section className="panel"><b>Getting started</b><p className="muted">Select a device above to see ready-made examples with your actual device ID and token. All protocols (REST, WebSocket, MQTT) publish through the same broker and reach every connected client in real time.</p><div className="grid3"><CodeBlock title="REST Publish" code={examples.curlPublish} copyText={examples.curlPublish}/><CodeBlock title="REST Response" code={examples.curlResponse} copyText={examples.curlResponse}/></div></section>:<><section className="panel"><b>Publish telemetry — {selectedDevice.name}</b><p className="muted">Use any of the methods below. All of them call the same broker, so events appear instantly in Live Events and on every connected dashboard.</p><div className="grid3"><CodeBlock title="cURL" code={examples.curlPublish} copyText={examples.curlPublish}/><CodeBlock title="Python" code={examples.pythonCode} copyText={examples.pythonCode}/><CodeBlock title="WebSocket" code={examples.wsCode} copyText={examples.wsCode}/></div></section><section className="panel"><b>MQTT over WebSocket</b><p className="muted">Connect your ESP32, Raspberry Pi, or any MQTT client using WebSocket transport on port 443.</p><CodeBlock title="MQTT (Python/paho)" code={examples.mqttCode} copyText={examples.mqttCode}/></section></>}<section className="panel"><b>Topic model</b><p><code>iotcloud/{projectId}/{deviceId}/{"{topic}"}</code></p><p className="muted">Device tokens authenticate MQTT and REST publishing. Browser clients use HTTPS and WSS automatically.</p></section><section className="panel"><div className="panelHead"><div><b>AI Context</b><span>Copy everything below to paste into an AI assistant</span></div><button className="outlineBtn" onClick={async()=>{try{await navigator.clipboard.writeText(examples.aiContext)}catch{}}}>Copy All</button></div><CodeBlock title="" code={examples.aiContext} copyText={examples.aiContext}/></section></div>}
function Settings({apiUrl,setApiUrl}:{apiUrl:string;setApiUrl:(v:string)=>void}){const[value,setValue]=useState(apiUrl);const[test,setTest]=useState('');async function check(){try{const u=normalizeApi(value);const r=await fetch(u+'/health');setTest(r.ok?'Connection successful':'Server returned '+r.status)}catch(e:any){setTest('Connection failed: '+e.message)}}return <div className="settingsPage"><div className="pageIntro"><div><h2>Connection settings</h2><p>Change the API endpoint without rebuilding the frontend.</p></div></div><section className="panel settingsCard"><div className="settingIcon">↗</div><div className="settingBody"><label>API base URL<input value={value} onChange={e=>setValue(e.target.value)} placeholder="https://your-api.onrender.com"/></label><p className="muted">HTTP is automatically upgraded to HTTPS. WebSocket connections automatically use WSS.</p><div className="settingActions"><button className="primary" onClick={()=>setApiUrl(value)}>Save endpoint</button><button className="outlineBtn" onClick={()=>{setValue(DEFAULT_API);localStorage.removeItem('iotcloud_api_url')}}>Use default</button><button className="outlineBtn" onClick={check}>Test connection</button></div>{test&&<div className="sendStatus">{test}</div>}</div></section><section className="panel"><b>Why CORS can still appear</b><p className="muted">The browser must call the HTTPS API directly. An HTTP Render URL redirects to HTTPS, and browsers reject redirects during CORS preflight. This app normalizes the endpoint before every request.</p></section></div>}

function Credentials({project}:{project:any}){
  const[items,setItems]=useState<any[]>([]);
  const[step,setStep]=useState(1);
  const[kind,setKind]=useState('discord');
  const[name,setName]=useState('');
  
  // Specific config fields
  const[discordWebhookUrl,setDiscordWebhookUrl]=useState('');
  const[telegramToken,setTelegramToken]=useState('');
  const[smtpHost,setSmtpHost]=useState('');
  const[smtpPort,setSmtpPort]=useState('587');
  const[smtpSecure,setSmtpSecure]=useState(false);
  const[smtpUser,setSmtpUser]=useState('');
  const[smtpPass,setSmtpPass]=useState('');
  const[webhookUrl,setWebhookUrl]=useState('');

  const[testingId,setTestingId]=useState<string|null>(null);
  const[testResults,setTestResults]=useState<Record<string,string>>({});
  const[error,setError]=useState('');

  useEffect(()=>{
    api(`/api/projects/${project.id}/credentials`).then(setItems).catch(()=>{});
  },[project.id]);

  const kinds = [
    { id: 'discord', label: 'Discord', icon: '💬', desc: 'Send rich message webhooks to your discord channels.' },
    { id: 'telegram', label: 'Telegram', icon: '✈', desc: 'Interact with the official Telegram Bot API.' },
    { id: 'smtp', label: 'Email SMTP', icon: '✉', desc: 'Deliver notification emails via secure SMTP servers.' },
    { id: 'webhook', label: 'Webhook', icon: '🔗', desc: 'Trigger third-party APIs with event payloads.' }
  ];

  async function createCredential() {
    setError('');
    let configObj: Record<string, any> = {};
    if (kind === 'discord') {
      if (!discordWebhookUrl) { setError('Webhook URL is required'); return; }
      configObj = { webhookUrl: discordWebhookUrl };
    } else if (kind === 'telegram') {
      if (!telegramToken) { setError('Bot token is required'); return; }
      configObj = { token: telegramToken };
    } else if (kind === 'smtp') {
      if (!smtpHost || !smtpPort) { setError('Host and Port are required'); return; }
      configObj = {
        host: smtpHost,
        port: Number(smtpPort),
        secure: smtpSecure,
        user: smtpUser,
        pass: smtpPass
      };
    } else if (kind === 'webhook') {
      if (!webhookUrl) { setError('Webhook Endpoint URL is required'); return; }
      configObj = { url: webhookUrl };
    }

    try {
      const cred = await api(`/api/projects/${project.id}/credentials`, {
        method: 'POST',
        body: JSON.stringify({ name, kind, config: configObj })
      });
      setItems(prev => [cred, ...prev]);
      // Reset form
      setName('');
      setDiscordWebhookUrl('');
      setTelegramToken('');
      setSmtpHost('');
      setSmtpPort('587');
      setSmtpSecure(false);
      setSmtpUser('');
      setSmtpPass('');
      setWebhookUrl('');
      setStep(1);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function testCredential(cred: any) {
    setTestingId(cred.id);
    setTestResults(prev => ({ ...prev, [cred.id]: 'testing' }));
    try {
      await api(`/api/projects/${project.id}/credentials/${cred.id}/test`, { method: 'POST', body: '{}' });
      setTestResults(prev => ({ ...prev, [cred.id]: 'success' }));
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [cred.id]: 'failed: ' + e.message }));
    } finally {
      setTestingId(null);
    }
  }

  return <div>
    <div className="pageIntro">
      <div>
        <h2>Credentials Manager</h2>
        <p>Manage encrypted connectors and secrets safely.</p>
      </div>
    </div>

    <section className="panel" style={{ marginTop: '20px' }}>
      <div className="wizard-header">
        <b>Add New Credential</b>
        <span className="wizard-step-indicator">STEP {step} OF 2</span>
      </div>

      {error && <div className="error">{error}</div>}

      {step === 1 && (
        <div>
          <label style={{ fontSize: '13px', fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: '8px' }}>
            Credential Name
            <input
              style={{ display: 'block', width: '100%', marginTop: '6px' }}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. My Telegram Alerts"
            />
          </label>

          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--muted)', marginTop: '16px' }}>Select Connector Type</div>
          <div className="integration-card-grid">
            {kinds.map(k => (
              <div
                key={k.id}
                className={`integration-card ${kind === k.id ? 'selected' : ''}`}
                onClick={() => setKind(k.id)}
              >
                <span className="icon">{k.icon}</span>
                <b>{k.label}</b>
                <p>{k.desc}</p>
              </div>
            ))}
          </div>

          <button
            className="primary"
            style={{ marginTop: '20px' }}
            disabled={!name.trim()}
            onClick={() => setStep(2)}
          >
            Next: Configure Fields →
          </button>
        </div>
      )}

      {step === 2 && (
        <div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text)', marginBottom: '12px' }}>
            Configure {kind.toUpperCase()} Connection for <i>"{name}"</i>
          </div>

          <div className="credentialFormFields">
            {kind === 'discord' && (
              <label>
                Discord Webhook URL
                <input
                  value={discordWebhookUrl}
                  onChange={e => setDiscordWebhookUrl(e.target.value)}
                  placeholder="https://discord.com/api/webhooks/..."
                />
              </label>
            )}

            {kind === 'telegram' && (
              <label>
                Telegram Bot Token
                <input
                  value={telegramToken}
                  onChange={e => setTelegramToken(e.target.value)}
                  placeholder="e.g. 123456789:ABCdefGhIJKlmNoPQRsT"
                />
              </label>
            )}

            {kind === 'smtp' && (
              <>
                <label>
                  SMTP Server Host
                  <input
                    value={smtpHost}
                    onChange={e => setSmtpHost(e.target.value)}
                    placeholder="smtp.gmail.com"
                  />
                </label>
                <div style={{ display: 'flex', gap: '16px' }}>
                  <label style={{ flex: 1 }}>
                    Port
                    <input
                      type="number"
                      value={smtpPort}
                      onChange={e => setSmtpPort(e.target.value)}
                      placeholder="587"
                    />
                  </label>
                  <label className="checkbox-label" style={{ flex: 1, marginTop: '24px' }}>
                    <input
                      type="checkbox"
                      checked={smtpSecure}
                      onChange={e => setSmtpSecure(e.target.checked)}
                    />
                    Use Secure SSL/TLS
                  </label>
                </div>
                <label>
                  Username
                  <input
                    value={smtpUser}
                    onChange={e => setSmtpUser(e.target.value)}
                    placeholder="your-email@gmail.com"
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={smtpPass}
                    onChange={e => setSmtpPass(e.target.value)}
                    placeholder="SMTP Account Password"
                  />
                </label>
              </>
            )}

            {kind === 'webhook' && (
              <label>
                Webhook URL
                <input
                  value={webhookUrl}
                  onChange={e => setWebhookUrl(e.target.value)}
                  placeholder="https://api.myplatform.com/v1/telemetry-receiver"
                />
              </label>
            )}
          </div>

          <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
            <button className="outlineBtn" onClick={() => setStep(1)}>
              ← Back
            </button>
            <button className="primary" onClick={createCredential}>
              Create Connector 🌿
            </button>
          </div>
        </div>
      )}
    </section>

    <div className="deviceGrid">
      {items.map(x => {
        const testStatus = testResults[x.id];
        return (
          <div className="deviceCard" key={x.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <b>{x.name}</b>
                <small style={{ display: 'block', color: 'var(--muted)', marginTop: '4px', textTransform: 'uppercase', fontSize: '10px', fontWeight: 700 }}>
                  {kinds.find(k => k.id === x.kind)?.icon} {x.kind}
                </small>
              </div>
            </div>
            <code style={{ fontSize: '11px', display: 'block', background: 'var(--gold-light)', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: '8px' }}>
              {x.id}
            </code>
            
            {testStatus && (
              <div className={`credential-test-status ${testStatus.startsWith('success') ? 'success' : testStatus.startsWith('failed') ? 'failed' : 'testing'}`}>
                {testStatus}
              </div>
            )}

            <button
              className="outlineBtn"
              disabled={testingId === x.id}
              onClick={() => testCredential(x)}
              style={{ marginTop: '6px' }}
            >
              {testingId === x.id ? 'Testing...' : 'Test Connection ⚡'}
            </button>
          </div>
        );
      })}
    </div>
  </div>;
}

function Stat({label,value,sub}:{label:string;value:any;sub:string}){return <div className="statCard"><small>{label}</small><strong>{value}</strong><span>{sub}</span></div>}
function Panel({children,className='' }:{children:any;className?:string}){return <section className={`panel ${className}`}>{children}</section>}
function CodeBlock({title, code, copyText}:{title:string;code:string;copyText?:string}){const[ok,setOk]=useState(false);return <div className="codeCard"><b>{title}</b><pre>{code||'Create a device to generate an authenticated example.'}<button className="copyBtn" onClick={async()=>{try{await navigator.clipboard.writeText(copyText||code);setOk(true);setTimeout(()=>setOk(false),1200)}catch{}}}>{ok?'Copied':'Copy'}</button></pre></div>}
function EmptyState({text}:{text:string}){return <div className="empty"><div className="emptyIcon">◌</div><span>{text}</span></div>}
createRoot(document.getElementById('root')!).render(<App/>);
