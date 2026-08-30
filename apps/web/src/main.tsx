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
  const headers:Record<string,string>={
    ...(opts.body ? {'content-type':'application/json'} : {}),
    ...(token?{authorization:`Bearer ${token}`}:{})
  };
  Object.entries((opts.headers||{}) as Record<string,string>).forEach(([k,v])=>headers[k]=v);
  const r=await fetch(base+path,{...opts,headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
  return data;
}

const NODE_CATEGORIES = [
  { title: 'Input', desc: 'Where events come from', items: [
    { type: 'event.trigger', label: '◎ Event Input', desc: 'Listens for any device event' },
    { type: 'webhook.trigger', label: '🔗 Webhook Input', desc: 'Receives external HTTP calls' },
  ]},
  { title: 'Condition', desc: 'Filter & route events', items: [
    { type: 'logic.if', label: '⑂ IF Condition', desc: 'Branch based on data field' },
    { type: 'logic.filter', label: '⊘ Filter', desc: 'Pass or block events' },
  ]},
  { title: 'Action', desc: 'React to events', items: [
    { type: 'action.telegram.send', label: '✈ Telegram', desc: 'Send bot message' },
    { type: 'action.discord.send', label: '💬 Discord', desc: 'Post to channel' },
    { type: 'action.email.send', label: '✉ Email', desc: 'Send via SMTP' },
    { type: 'action.webhook.send', label: '↗ HTTP Request', desc: 'Call external API' },
    { type: 'iot.mqtt.publish', label: '⬡ MQTT Publish', desc: 'Publish to broker topic' },
  ]},
];
const OPERATORS = ['>','>=','<','<=','==','!=','contains','exists'];
const EVENT_TYPES = ['mqtt.message','device.online','device.offline','webhook','schedule'];

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
        page==='workflows'?<Workflows project={project} devices={devices}/>:
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
  const[name,setName]=useState('');
  async function add(){
    if(!name)return;
    const d=await api(`/api/projects/${project.id}/devices`,{method:'POST',body:JSON.stringify({name})});
    setDevices([d,...devices]);
    setName('');
    setProject({...project,__deviceToken:d.token});
  }
  async function removeDevice(id:string){
    if(!confirm('Are you sure you want to delete this device?')) return;
    await api(`/api/projects/${project.id}/devices/${id}`,{method:'DELETE'});
    setDevices(devices.filter(d=>d.id!==id));
  }
  return <div>
    <div className="pageIntro">
      <div><h2>Devices</h2><p>Credentials, presence and endpoints for every device.</p></div>
      <div className="addRow"><input value={name} onChange={e=>setName(e.target.value)} placeholder="New device name"/><button className="primary" onClick={add}>Add device</button></div>
    </div>
    <div className="deviceGrid">
      {devices.map(d=>
        <div className="deviceCard" key={d.id}>
          <div className="deviceHead">
            <div className={`deviceDot ${d.online?'on':''}`}/>
            <div><b>{d.name}</b><small>{d.online?'Online':'Offline'} · {d.id.slice(0,8)}</small></div>
          </div>
          <div className="tokenBox"><span>DEVICE TOKEN</span><code>{d.token}</code></div>
          <div style={{display:'flex',gap:'8px',marginTop:'10px'}}>
            <button className="outlineBtn" style={{flex:1}} onClick={()=>navigator.clipboard?.writeText(d.token)}>Copy token</button>
            <button className="outlineBtn" style={{color:'var(--error)',borderColor:'var(--error)'}} onClick={()=>removeDevice(d.id)}>Delete</button>
          </div>
        </div>
      )}
      {!devices.length&&<EmptyState text="No devices yet."/>}
    </div>
  </div>
}
function Workflows({project,devices}:{project:any;devices:any[]}){
  const[flows,setFlows]=useState<any[]>([]);
  const[active,setActive]=useState<any>(null);
  const[credentials,setCredentials]=useState<any[]>([]);
  
  // Creation Form State
  const[creating,setCreating]=useState(false);
  const[newName,setNewName]=useState('');
  const[newDeviceId,setNewDeviceId]=useState('');
  const[creatingLoading,setCreatingLoading]=useState(false);

  useEffect(()=>{
    api(`/api/projects/${project.id}/workflows`).then(setFlows).catch(()=>{});
    api(`/api/projects/${project.id}/credentials`).then(setCredentials).catch(()=>{});
  },[project.id]);

  function startNewWorkflow(){
    setActive(null);
    setNewName('');
    setNewDeviceId('');
    setCreating(true);
  }

  async function handleCreateWorkflow(){
    if(!newName.trim()) return;
    setCreatingLoading(true);
    try {
      const definition = {
        nodes: [
          {
            id: crypto.randomUUID(),
            type: 'event.trigger',
            position: { x: 80, y: 140 },
            data: { label: 'Event Input', eventType: 'mqtt.message', deviceId: newDeviceId, topic: '' }
          },
          {
            id: crypto.randomUUID(),
            type: 'logic.if',
            position: { x: 380, y: 140 },
            data: { label: 'IF Condition', field: 'temperature', operator: '>', value: '30' }
          }
        ],
        edges: []
      };
      const created = await api(`/api/projects/${project.id}/workflows`, {
        method: 'POST',
        body: JSON.stringify({ name: newName, definition, enabled: true })
      });
      setFlows(prev => [created, ...prev]);
      setActive(created);
      setCreating(false);
    } catch (err: any) {
      alert(err.message || 'Failed to create workflow');
    } finally {
      setCreatingLoading(false);
    }
  }

  return <div className="workflowLayout">
    <div className="flowSide">
      <button className="primary wide" onClick={startNewWorkflow}>＋ New workflow</button>
      {flows.map(f=>
        <button
          className={`flowItem ${active?.id===f.id?'selected':''}`}
          onClick={()=>{ setActive(f); setCreating(false); }}
          key={f.id}
        >
          <b>{f.name}</b>
          <small>{f.enabled?'Enabled':'Draft'}</small>
        </button>
      )}
    </div>
    <div className="flowCanvas">
      <div className="mobileFlowSelect">
        <select value={creating?'new':(active?.id||'')} onChange={e=>{
          if(e.target.value==='new'){ startNewWorkflow(); return; }
          const f=flows.find(x=>x.id===e.target.value);
          if(f){ setActive(f); setCreating(false); }
        }}>
          <option value="" disabled>Choose a workflow...</option>
          {flows.map(f=><option key={f.id} value={f.id}>{f.name} ({f.enabled?'Enabled':'Draft'})</option>)}
          <option value="new">＋ Create New Workflow...</option>
        </select>
        <button className="primary" onClick={startNewWorkflow}>＋ New</button>
      </div>

      {creating ? (
        <div className="newWorkflowCard">
          <h3>Create New Workflow</h3>
          <p className="muted">Name your workflow and choose a target device to start automating.</p>
          
          <label style={{ marginTop: '16px' }}>
            Workflow Name
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. High Temp Emergency Alert"
              autoFocus
            />
          </label>

          <label style={{ marginTop: '16px' }}>
            Initial Device
            <select value={newDeviceId} onChange={e => setNewDeviceId(e.target.value)}>
              <option value="">All Devices</option>
              {devices.map(dev => (
                <option key={dev.id} value={dev.id}>{dev.name}</option>
              ))}
            </select>
          </label>

          <div style={{ display: 'flex', gap: '10px', marginTop: '24px' }}>
            <button
              className="primary"
              disabled={!newName.trim() || creatingLoading}
              onClick={handleCreateWorkflow}
            >
              {creatingLoading ? 'Creating...' : 'Create Workflow 🌿'}
            </button>
            <button className="outlineBtn" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : active ? (
        <WorkflowEditor
          project={project}
          workflow={active}
          devices={devices}
          credentials={credentials}
          onSaved={(f)=>{
            setFlows((v:any[])=>{
              const i=v.findIndex(x=>x.id===f.id);
              return i<0?[f,...v]:v.map(x=>x.id===f.id?f:x);
            });
            setActive(f);
          }}
          onDeleted={(id)=>{
            setFlows(v=>v.filter(x=>x.id!==id));
            setActive(null);
          }}
        />
      ) : (
        <EmptyState text="Select a workflow or create one."/>
      )}
    </div>
  </div>
}

function WorkflowEditor({project,workflow,devices,credentials,onSaved,onDeleted}:{project:any;workflow:any;devices:any[];credentials:any[];onSaved:(f:any)=>void;onDeleted:(id:string|null)=>void}){
  const initial=workflow.definition||{nodes:[],edges:[]};
  const[nodes,setNodes,onNodesChange]=useNodesState(initial.nodes);
  const[edges,setEdges,onEdgesChange]=useEdgesState(initial.edges);
  const[selectedId,setSelectedId]=useState<string|null>(initial.nodes[0]?.id||null);
  const[name,setName]=useState(workflow.name||'New workflow');
  const[mobileTab,setMobileTab]=useState<'nodes'|'canvas'|'inspector'>('canvas');

  const selected = useMemo(() => nodes.find(n => n.id === selectedId) || null, [nodes, selectedId]);

  const addNode=(type:string)=>{
    const allItems=NODE_CATEGORIES.flatMap(c=>c.items);
    const meta=allItems.find(x=>x.type===type);
    const id=crypto.randomUUID();
    const newNode:Node = {
      id,
      type,
      position:{x:120+nodes.length*50,y:130+nodes.length*30},
      data:{label:meta?.label||type}
    };
    setNodes(v=>[...v,newNode]);
    setSelectedId(id);
    setMobileTab('inspector');
  };

  async function save(){
    const body={name,definition:{nodes,edges},enabled:true};
    const f=workflow.id
      ? await api(`/api/projects/${project.id}/workflows/${workflow.id}`,{method:'PUT',body:JSON.stringify(body)})
      : await api(`/api/projects/${project.id}/workflows`,{method:'POST',body:JSON.stringify(body)});
    onSaved(f);
  }

  async function removeWorkflow(){
    if(!workflow.id){
      onDeleted(null);
      return;
    }
    if(!confirm(`Are you sure you want to delete "${name}"?`)) return;
    await api(`/api/projects/${project.id}/workflows/${workflow.id}`,{method:'DELETE'});
    onDeleted(workflow.id);
  }

  return <div className="editorWrapper">
    <div className="mobileWorkflowTabs">
      <button className={mobileTab==='nodes'?'active':''} onClick={()=>setMobileTab('nodes')}>🎨 Nodes</button>
      <button className={mobileTab==='canvas'?'active':''} onClick={()=>setMobileTab('canvas')}>🗺 Canvas</button>
      <button className={mobileTab==='inspector'?'active':''} onClick={()=>setMobileTab('inspector')}>
        ⚙ Inspector {selected?'●':''}
      </button>
    </div>
    <div className={`editor showTab-${mobileTab}`}>
      <div className="nodePalette">
        {NODE_CATEGORIES.map(cat=>
          <div key={cat.title} className="paletteGroup">
            <div className="paletteCatTitle">{cat.title}</div>
            <div className="paletteCatDesc">{cat.desc}</div>
            {cat.items.map(item=>
              <button key={item.type} onClick={()=>addNode(item.type)} title={item.desc}>
                {item.label}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="rf">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(c:Connection)=>setEdges(e=>addEdge(c,e))}
          onNodeClick={(_,n)=>{
            setSelectedId(n.id);
            setMobileTab('inspector');
          }}
          fitView
        >
          <Background/><Controls/><MiniMap/>
        </ReactFlow>
      </div>
      <div className="inspector">
        <input value={name} onChange={e=>setName(e.target.value)} className="titleInput" placeholder="Workflow name"/>
        <b>Node Inspector</b>
        {selected
          ? <NodeForm node={selected} setNodes={setNodes} devices={devices} credentials={credentials}/>
          : <div className="inspectorHint"><div className="emptyIcon">◌</div><span>Click a node on the canvas to configure it</span></div>
        }
        <div style={{display:'flex',gap:'8px',marginTop:'24px'}}>
          <button className="primary save" style={{flex:1,marginTop:0}} onClick={save}>Save & enable</button>
          {workflow.id && (
            <button className="outlineBtn" style={{color:'var(--error)',borderColor:'var(--error)'}} onClick={removeWorkflow}>Delete</button>
          )}
        </div>
      </div>
    </div>
  </div>
}

function NodeForm({node,setNodes,devices,credentials}:{node:Node;setNodes:any;devices:any[];credentials:any[]}){
  const d=(node.data||{}) as any;
  const t=node.type||'';

  const update=(k:string,v:any)=>setNodes((ns:Node[])=>
    ns.map(n=>n.id===node.id?{...n,data:{...n.data,[k]:v,label:n.data?.label}}:n)
  );

  const allItems=NODE_CATEGORIES.flatMap(c=>c.items);
  const meta=allItems.find(x=>x.type===t);

  return <div className="form">
    <div className="nodeTypeTag">{meta?.label||t}</div>
    {meta?.desc && <p className="muted" style={{fontSize:'11px',margin:'0 0 14px'}}>{meta.desc}</p>}

    {/* --- INPUT NODES --- */}
    {(t==='event.trigger'||t==='mqtt.trigger') && <>
      <label>Listen to device
        <select value={d.deviceId||''} onChange={e=>update('deviceId',e.target.value)}>
          <option value="">All devices</option>
          {devices.map(dev=><option key={dev.id} value={dev.id}>{dev.name}</option>)}
        </select>
      </label>
      <label>Event type
        <select value={d.eventType||''} onChange={e=>update('eventType',e.target.value)}>
          <option value="">Any event</option>
          {EVENT_TYPES.map(et=><option key={et} value={et}>{et}</option>)}
        </select>
      </label>
      <label>Topic filter
        <input value={d.topic||''} onChange={e=>update('topic',e.target.value)} placeholder="telemetry (optional)"/>
      </label>
    </>}

    {t==='webhook.trigger' && <>
      <label>Webhook URL
        <input readOnly value={`${apiBase()}/v1/webhooks/WORKFLOW_ID`} style={{opacity:0.7,fontSize:'11px'}}/>
      </label>
      <p className="muted" style={{fontSize:'11px',margin:'0'}}>This URL is auto-generated when you save the workflow. External services POST JSON here to trigger the flow.</p>
    </>}

    {/* --- CONDITION NODES --- */}
    {t==='logic.if' && <>
      <label>Data field
        <input value={d.field||''} onChange={e=>update('field',e.target.value)} placeholder="e.g. temperature"/>
      </label>
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {['temperature','humidity','status','battery','voltage','co2'].map(f => (
          <button key={f} type="button" className="outlineBtn" style={{ fontSize: '10px', padding: '2px 6px', marginTop: 0 }} onClick={() => update('field', f)}>
            +{f}
          </button>
        ))}
      </div>
      <label>Operator
        <select value={d.operator||'>'} onChange={e=>update('operator',e.target.value)}>
          {OPERATORS.map(op=><option key={op} value={op}>{op}</option>)}
        </select>
      </label>
      <label>Value
        <input value={d.value??''} onChange={e=>update('value',e.target.value)} placeholder="e.g. 30"/>
      </label>
      <p className="muted" style={{fontSize:'11px',margin:'4px 0 0'}}>True path → green handle · False path → red handle</p>
    </>}

    {t==='logic.filter' && <>
      <p className="muted" style={{fontSize:'11px',margin:'0'}}>Passes events that have a non-empty <code>data</code> body. Empty or null payloads are blocked.</p>
    </>}

    {/* --- ACTION NODES --- */}
    {t==='action.telegram.send' && (() => {
      const selectedCred = credentials.find(c => c.id === d.credentialId);
      const credSubscribers: any[] = selectedCred?.secret?.subscribers || selectedCred?.config?.subscribers || [];
      return <>
        <label>Telegram Credential
          <select value={d.credentialId||''} onChange={e=>update('credentialId',e.target.value)}>
            <option value="">Select Telegram credential...</option>
            {credentials.filter(c=>c.kind==='telegram').map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>

        <label>Target Recipient
          <select
            value={d.recipient || (d.chatId ? d.chatId : 'all')}
            onChange={e => {
              const val = e.target.value;
              update('recipient', val);
              if (val !== 'custom') update('chatId', val);
            }}
          >
            <option value="all">📢 Broadcast to All Subscribers ({credSubscribers.length})</option>
            {credSubscribers.map((s: any) => (
              <option key={s.chatId} value={s.chatId}>
                👤 {s.firstName || 'User'} {s.username ? `(@${s.username})` : ''} - ID: {s.chatId}
              </option>
            ))}
            <option value="custom">⚙️ Custom Chat ID (Enter manually)</option>
          </select>
        </label>

        {(d.recipient === 'custom' || (!d.recipient && d.chatId && !credSubscribers.some(s => s.chatId === d.chatId))) && (
          <label>Chat ID (Manual override)
            <input value={d.chatId||''} onChange={e=>update('chatId',e.target.value)} placeholder="e.g. 123456789 or @mychannel"/>
          </label>
        )}

        <label>Message Formatting
          <select value={d.parseMode||'HTML'} onChange={e=>update('parseMode',e.target.value)}>
            <option value="HTML">HTML (e.g. &lt;b&gt;bold&lt;/b&gt;, &lt;code&gt;code&lt;/code&gt;)</option>
            <option value="MarkdownV2">Markdown V2 (*bold*, `code`)</option>
            <option value="None">Plain Text</option>
          </select>
        </label>

        <label>Message Template
          <textarea
            value={d.text||''}
            onChange={e=>update('text',e.target.value)}
            placeholder="🚨 Alert: <b>{{data.temperature}}°C</b> on device <code>{{deviceId}}</code>"
            rows={3}
          />
        </label>

        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '12px' }}>
          {['{{data.temperature}}', '{{data.humidity}}', '{{deviceId}}', '{{topic}}', '{{timestamp}}'].map(tag => (
            <button
              key={tag}
              type="button"
              className="outlineBtn"
              style={{ fontSize: '10px', padding: '2px 6px', marginTop: 0 }}
              onClick={() => update('text', (d.text || '') + ' ' + tag)}
            >
              +{tag}
            </button>
          ))}
        </div>

        <label className="checkbox-label" style={{ marginTop: '8px' }}>
          <input
            type="checkbox"
            checked={Boolean(d.disableNotification)}
            onChange={e => update('disableNotification', e.target.checked)}
          />
          Send Silently (Disable notification sound)
        </label>

        <label className="checkbox-label" style={{ marginTop: '6px' }}>
          <input
            type="checkbox"
            checked={Boolean(d.disableWebPagePreview)}
            onChange={e => update('disableWebPagePreview', e.target.checked)}
          />
          Disable Link Previews
        </label>
      </>;
    })()}

    {t==='action.discord.send' && <>
      <label>Discord Credential
        <select value={d.credentialId||''} onChange={e=>update('credentialId',e.target.value)}>
          <option value="">Select Discord credential...</option>
          {credentials.filter(c=>c.kind==='discord').map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>

      <label>Card Format
        <select value={d.useEmbed === false ? 'plain' : 'embed'} onChange={e => update('useEmbed', e.target.value === 'embed')}>
          <option value="embed">🎨 Rich Discord Embed Card</option>
          <option value="plain">💬 Plain Text Message</option>
        </select>
      </label>

      {d.useEmbed !== false && (
        <>
          <label>Embed Title
            <input
              value={d.embedTitle || ''}
              onChange={e => update('embedTitle', e.target.value)}
              placeholder="🚨 Alert: {{deviceId}} telemetry"
            />
          </label>

          <label>Embed Accent Color
            <div style={{ display: 'flex', gap: '6px', marginTop: '4px', marginBottom: '8px' }}>
              {[
                { label: '🔴 Red', hex: '#ef4444' },
                { label: '🟢 Green', hex: '#10b981' },
                { label: '🔵 Blue', hex: '#3b82f6' },
                { label: '🟡 Gold', hex: '#f59e0b' },
              ].map(c => (
                <button
                  key={c.hex}
                  type="button"
                  className="outlineBtn"
                  style={{
                    fontSize: '11px',
                    padding: '3px 8px',
                    marginTop: 0,
                    borderColor: d.embedColor === c.hex ? c.hex : undefined,
                    fontWeight: d.embedColor === c.hex ? 700 : 400,
                  }}
                  onClick={() => update('embedColor', c.hex)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <input
              value={d.embedColor || '#3b82f6'}
              onChange={e => update('embedColor', e.target.value)}
              placeholder="#3b82f6"
            />
          </label>
        </>
      )}

      <label>Message / Description Template
        <textarea
          value={d.text || ''}
          onChange={e => update('text', e.target.value)}
          placeholder="Device **{{deviceId}}** reported temperature **{{data.temperature}}°C**"
          rows={3}
        />
      </label>

      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {['{{data.temperature}}', '{{data.humidity}}', '{{deviceId}}', '{{topic}}', '{{timestamp}}'].map(tag => (
          <button
            key={tag}
            type="button"
            className="outlineBtn"
            style={{ fontSize: '10px', padding: '2px 6px', marginTop: 0 }}
            onClick={() => update('text', (d.text || '') + ' ' + tag)}
          >
            +{tag}
          </button>
        ))}
      </div>

      <label>Bot Display Name (Optional Override)
        <input
          value={d.username || ''}
          onChange={e => update('username', e.target.value)}
          placeholder="e.g. IoT Security Bot"
        />
      </label>

      <label className="checkbox-label" style={{ marginTop: '8px' }}>
        <input
          type="checkbox"
          checked={Boolean(d.tts)}
          onChange={e => update('tts', e.target.checked)}
        />
        Enable Text-to-Speech (TTS Alert)
      </label>
    </>}

    {t==='action.email.send' && <>
      <label>SMTP Credential
        <select value={d.credentialId||''} onChange={e=>update('credentialId',e.target.value)}>
          <option value="">Select SMTP credential...</option>
          {credentials.filter(c=>c.kind==='smtp').map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label>To address
        <input value={d.to||''} onChange={e=>update('to',e.target.value)} placeholder="admin@example.com"/>
      </label>
      <label>Subject
        <input value={d.subject||''} onChange={e=>update('subject',e.target.value)} placeholder="IoTCloud alert"/>
      </label>
      <label>Body template
        <textarea value={d.text||''} onChange={e=>update('text',e.target.value)} placeholder="Device {{deviceId}} reported {{data.temperature}}°C" rows={3}/>
      </label>
    </>}

    {t==='action.webhook.send' && <>
      <label>Endpoint URL
        <input value={d.url||''} onChange={e=>update('url',e.target.value)} placeholder="https://api.example.com/notify"/>
      </label>
      <label>HTTP Method
        <select value={d.method||'POST'} onChange={e=>update('method',e.target.value)}>
          <option>POST</option><option>PUT</option><option>PATCH</option>
        </select>
      </label>
    </>}

    {t==='iot.mqtt.publish' && <>
      <label>Publish to device
        <select value={d.deviceId||''} onChange={e=>update('deviceId',e.target.value)}>
          <option value="">Gateway (default)</option>
          {devices.map(dev=><option key={dev.id} value={dev.id}>{dev.name}</option>)}
        </select>
      </label>
      <label>Topic
        <input value={d.topic||''} onChange={e=>update('topic',e.target.value)} placeholder="commands"/>
      </label>
    </>}
  </div>
}
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
  const[telegramChatId,setTelegramChatId]=useState('');
  const[smtpHost,setSmtpHost]=useState('');
  const[smtpPort,setSmtpPort]=useState('587');
  const[smtpSecure,setSmtpSecure]=useState(false);
  const[smtpUser,setSmtpUser]=useState('');
  const[smtpPass,setSmtpPass]=useState('');
  const[webhookUrl,setWebhookUrl]=useState('');

  const[testingId,setTestingId]=useState<string|null>(null);
  const[syncingId,setSyncingId]=useState<string|null>(null);
  const[expandedSubscribersId,setExpandedSubscribersId]=useState<string|null>(null);
  const[manualChatId,setManualChatId]=useState('');
  const[manualName,setManualName]=useState('');
  const[testResults,setTestResults]=useState<Record<string,string>>({});
  const[error,setError]=useState('');

  useEffect(()=>{
    api(`/api/projects/${project.id}/credentials`).then(setItems).catch(()=>{});
  },[project.id]);

  async function syncTelegramSubscribers(credId:string){
    setSyncingId(credId);
    try{
      const res = await api(`/api/projects/${project.id}/credentials/${credId}/telegram/sync`,{method:'POST',body:'{}'});
      setItems(prev=>prev.map(c=>c.id===credId?{...c,secret:{...c.secret,subscribers:res.subscribers}}:c));
      if (res.webhookActive) {
        alert(`⚡ Live Webhook is Active!\n\n${res.message}\nTotal Subscribers: ${res.totalCount}`);
      } else {
        alert(`Synced ${res.totalCount} subscribers! (${res.newCount} new)`);
      }
    }catch(e:any){
      alert('Sync failed: '+e.message);
    }finally{
      setSyncingId(null);
    }
  }

  async function addManualSubscriber(credId:string){
    if(!manualChatId.trim()) return;
    try{
      const res = await api(`/api/projects/${project.id}/credentials/${credId}/telegram/subscribers`,{
        method:'POST',
        body:JSON.stringify({chatId:manualChatId,firstName:manualName||'Subscriber'})
      });
      setItems(prev=>prev.map(c=>c.id===credId?{...c,secret:{...c.secret,subscribers:res.subscribers}}:c));
      setManualChatId('');
      setManualName('');
    }catch(e:any){
      alert('Failed to add subscriber: '+e.message);
    }
  }

  async function removeSubscriber(credId:string,targetChatId:string){
    try{
      const res = await api(`/api/projects/${project.id}/credentials/${credId}/telegram/subscribers/${targetChatId}`,{method:'DELETE'});
      setItems(prev=>prev.map(c=>c.id===credId?{...c,secret:{...c.secret,subscribers:res.subscribers}}:c));
    }catch(e:any){
      alert('Failed to remove subscriber: '+e.message);
    }
  }

  async function connectTelegramWebhook(credId: string) {
    try {
      const res = await api(`/api/projects/${project.id}/credentials/${credId}/telegram/set-webhook`, {
        method: 'POST',
        body: JSON.stringify({ webhookUrl: `${apiBase()}/v1/telegram/webhook/${credId}` })
      });
      alert('⚡ ' + (res.message || 'Telegram Webhook Connected Successfully!'));
      setItems(prev => prev.map(c => c.id === credId ? { ...c, secret: { ...c.secret, webhookUrl: res.webhookUrl } } : c));
    } catch (e: any) {
      alert('Webhook setup failed: ' + e.message);
    }
  }

  async function disconnectTelegramWebhook(credId: string) {
    try {
      const res = await api(`/api/projects/${project.id}/credentials/${credId}/telegram/delete-webhook`, { method: 'POST', body: '{}' });
      alert('ℹ️ ' + (res.message || 'Webhook disconnected. Sync mode active!'));
      setItems(prev => prev.map(c => c.id === credId ? { ...c, secret: { ...c.secret, webhookUrl: undefined } } : c));
    } catch (e: any) {
      alert('Disconnect failed: ' + e.message);
    }
  }

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
      configObj = { token: telegramToken, chatId: telegramChatId };
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
      setTelegramChatId('');
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
        <p>Manage encrypted connectors, subscribers, and secrets safely.</p>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text)', marginBottom: '12px' }}>
              Configure {kind.toUpperCase()} Connection for <i>"{name}"</i>
            </div>

            <div className="credentialFormFields">
              {kind === 'discord' && (
                <>
                  <label>
                    Discord Webhook URL
                    <input
                      value={discordWebhookUrl}
                      onChange={e => setDiscordWebhookUrl(e.target.value)}
                      placeholder="https://discord.com/api/webhooks/..."
                    />
                  </label>
                  <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px', marginTop: '12px' }}>
                    <b style={{ fontSize: '12px', color: 'var(--text)', display: 'block', marginBottom: '6px' }}>📖 Discord Webhook Setup Guide</b>
                    <ol style={{ fontSize: '11px', color: 'var(--muted)', margin: '0 0 0 16px', padding: 0, lineHeight: '1.8' }}>
                      <li>Open <b>Discord</b> and create or select a <b>Server</b> (click the <b>+</b> icon in the left sidebar).</li>
                      <li>Create or select a <b>Text Channel</b> where you want alerts to appear (e.g. <code>#iot-alerts</code>).</li>
                      <li>Click the <b>⚙ gear icon</b> next to the channel name → <b>Integrations</b> → <b>Webhooks</b>.</li>
                      <li>Click <b>New Webhook</b>, give it a name (e.g. "IoTCloud Alerts"), then click <b>Copy Webhook URL</b>.</li>
                      <li>Paste the copied URL above and click <b>Create Connector</b>.</li>
                    </ol>
                    <small style={{ display: 'block', marginTop: '8px', fontSize: '10px', color: 'var(--muted)' }}>
                      💡 The URL looks like: <code>https://discord.com/api/webhooks/123.../abc...</code>
                    </small>
                  </div>
                </>
              )}

              {kind === 'telegram' && (
                <>
                  <label>
                    Telegram Bot Token
                    <input
                      value={telegramToken}
                      onChange={e => setTelegramToken(e.target.value)}
                      placeholder="e.g. 123456789:ABCdefGhIJKlmNoPQRsT"
                    />
                  </label>
                  <label style={{ marginTop: '12px' }}>
                    Target Chat ID / Channel ID (Optional Default)
                    <input
                      value={telegramChatId}
                      onChange={e => setTelegramChatId(e.target.value)}
                      placeholder="e.g. 123456789 or @mychannel"
                    />
                  </label>
                  <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px', marginTop: '12px' }}>
                    <b style={{ fontSize: '12px', color: 'var(--text)', display: 'block', marginBottom: '6px' }}>📖 Two-Way Telegram Integration Guide</b>
                    <ol style={{ fontSize: '11px', color: 'var(--muted)', margin: '0 0 0 16px', padding: 0, lineHeight: '1.6' }}>
                      <li>Search <b>@BotFather</b> in Telegram, send <code>/newbot</code>, and copy your <b>Bot Token</b>.</li>
                      <li>Paste the token above and click <b>Create Connector</b>.</li>
                      <li><b>App ➔ Telegram (Outbound Alerts)</b>: Workflows automatically dispatch alerts to registered users or broadcast channels.</li>
                      <li><b>Telegram ➔ App (Inbound Commands)</b>: Users chat with your bot (send <code>/start</code>). Click <b>Connect Webhook ⚡</b> on your card to stream Telegram commands directly into IoTCloud Workflows!</li>
                    </ol>
                  </div>
                </>
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
                      placeholder="App Password (not your regular password)"
                    />
                  </label>
                  <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px', marginTop: '12px' }}>
                    <b style={{ fontSize: '12px', color: 'var(--text)', display: 'block', marginBottom: '6px' }}>📖 Gmail SMTP Setup Guide</b>
                    <ol style={{ fontSize: '11px', color: 'var(--muted)', margin: '0 0 0 16px', padding: 0, lineHeight: '1.8' }}>
                      <li>Go to <b>myaccount.google.com</b> → <b>Security</b> → enable <b>2-Step Verification</b>.</li>
                      <li>Search for <b>App Passwords</b> in your Google Account settings.</li>
                      <li>Generate a new App Password (select "Mail"), and copy the <b>16-character code</b>.</li>
                      <li>Use Host: <code>smtp.gmail.com</code>, Port: <code>587</code>, Username: your Gmail address, Password: the App Password.</li>
                    </ol>
                    <small style={{ display: 'block', marginTop: '8px', fontSize: '10px', color: 'var(--muted)' }}>
                      ⚠️ Use an <b>App Password</b>, not your regular Gmail password. Regular passwords won't work with SMTP.
                    </small>
                  </div>
                </>
              )}

              {kind === 'webhook' && (
                <>
                  <label>
                    Webhook Endpoint URL
                    <input
                      value={webhookUrl}
                      onChange={e => setWebhookUrl(e.target.value)}
                      placeholder="https://api.myplatform.com/v1/telemetry-receiver"
                    />
                  </label>
                  <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px', marginTop: '12px' }}>
                    <b style={{ fontSize: '12px', color: 'var(--text)', display: 'block', marginBottom: '6px' }}>📖 Webhook Setup Guide</b>
                    <ol style={{ fontSize: '11px', color: 'var(--muted)', margin: '0 0 0 16px', padding: 0, lineHeight: '1.8' }}>
                      <li>Enter the <b>full HTTPS URL</b> of your API endpoint that will receive event payloads.</li>
                      <li>The endpoint must accept <b>POST</b> requests with a JSON body.</li>
                      <li>IoTCloud will send <code>{"{"}"event":"...","data":{"{"}...{"}"}{"}"}</code> payloads when workflows trigger this action.</li>
                    </ol>
                    <small style={{ display: 'block', marginTop: '8px', fontSize: '10px', color: 'var(--muted)' }}>
                      💡 Use services like <b>Zapier</b>, <b>Make.com</b>, or <b>n8n</b> webhook URLs for no-code integrations.
                    </small>
                  </div>
                </>
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

            {x.kind === 'telegram' && (() => {
              const subs: any[] = x.secret?.subscribers || x.config?.subscribers || [];
              const hasWebhook = Boolean(x.secret?.webhookUrl || x.config?.webhookUrl);
              const isExpanded = expandedSubscribersId === x.id;
              return (
                <div style={{ marginTop: '12px', borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <button
                      className="outlineBtn"
                      style={{ fontSize: '11px', padding: '3px 8px', marginTop: 0 }}
                      onClick={() => setExpandedSubscribersId(isExpanded ? null : x.id)}
                    >
                      👥 {subs.length} Subscribers {isExpanded ? '▲' : '▼'}
                    </button>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button
                        className="outlineBtn"
                        style={{ fontSize: '11px', padding: '3px 8px', marginTop: 0, color: hasWebhook ? '#10b981' : undefined, borderColor: hasWebhook ? '#10b981' : undefined }}
                        onClick={() => {
                          if (hasWebhook) {
                            if (confirm('Disconnect Webhook and switch back to manual Sync mode?')) {
                              disconnectTelegramWebhook(x.id);
                            }
                          } else {
                            connectTelegramWebhook(x.id);
                          }
                        }}
                        title={hasWebhook ? "Webhook is Active! Click to disconnect" : "Connect two-way Telegram Webhook"}
                      >
                        {hasWebhook ? '⚡ Webhook (Active)' : '⚡ Connect Webhook'}
                      </button>
                      <button
                        className="primary"
                        style={{ fontSize: '11px', padding: '3px 8px', marginTop: 0 }}
                        disabled={syncingId === x.id}
                        onClick={() => syncTelegramSubscribers(x.id)}
                      >
                        {syncingId === x.id ? 'Syncing...' : '🔄 Sync Bot'}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div style={{ marginTop: '10px', background: 'var(--panel)', padding: '10px', borderRadius: '8px', border: '1px solid var(--border)' }}>
                      <b style={{ fontSize: '12px', display: 'block', marginBottom: '4px' }}>Registered Subscribers</b>
                      <p className="muted" style={{ fontSize: '10px', margin: '0 0 8px' }}>
                        Users can send <code>/start</code> to your bot, then click <b>Sync Bot</b> above to auto-register.
                      </p>
                      {subs.length === 0 ? (
                        <p className="muted" style={{ fontSize: '11px', margin: '4px 0' }}>
                          No subscribers registered yet.
                        </p>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '160px', overflowY: 'auto' }}>
                          {subs.map((s: any) => (
                            <div key={s.chatId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--border)' }}>
                              <div>
                                <b style={{ fontSize: '11px' }}>{s.firstName || 'User'} {s.username ? `(@${s.username})` : ''}</b>
                                <small style={{ display: 'block', color: 'var(--muted)', fontSize: '10px' }}>ID: {s.chatId}</small>
                              </div>
                              <button
                                className="outlineBtn"
                                style={{ color: 'var(--error)', borderColor: 'var(--error)', padding: '1px 6px', fontSize: '10px', marginTop: 0 }}
                                onClick={() => removeSubscriber(x.id, s.chatId)}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      <div style={{ marginTop: '10px', display: 'flex', gap: '4px' }}>
                        <input
                          style={{ flex: 1, fontSize: '11px', padding: '4px 6px' }}
                          value={manualChatId}
                          onChange={e => setManualChatId(e.target.value)}
                          placeholder="Chat ID"
                        />
                        <input
                          style={{ flex: 1, fontSize: '11px', padding: '4px 6px' }}
                          value={manualName}
                          onChange={e => setManualName(e.target.value)}
                          placeholder="Name / @username"
                        />
                        <button
                          className="outlineBtn"
                          style={{ fontSize: '11px', padding: '4px 8px', marginTop: 0 }}
                          onClick={() => addManualSubscriber(x.id)}
                        >
                          ＋ Add
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {x.kind === 'discord' && (() => {
              const inboundUrl = `${apiBase()}/v1/discord/webhook/${x.id}`;
              return (
                <div style={{ marginTop: '12px', borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
                  <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>
                    ⚡ <b>Inbound Discord Webhook (Discord ➔ IoTCloud)</b>
                  </div>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <code style={{ flex: 1, fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'var(--panel)', padding: '4px 6px', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      {inboundUrl}
                    </code>
                    <button
                      className="outlineBtn"
                      style={{ fontSize: '10px', padding: '2px 6px', marginTop: 0 }}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(inboundUrl);
                          alert('Copied Inbound Discord Webhook URL!');
                        } catch {}
                      }}
                    >
                      Copy 📋
                    </button>
                  </div>
                </div>
              );
            })()}

            <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
              <button
                className="outlineBtn"
                style={{ flex: 1 }}
                disabled={testingId === x.id}
                onClick={() => testCredential(x)}
              >
                {testingId === x.id ? 'Testing...' : 'Test Connection ⚡'}
              </button>
              <button
                className="outlineBtn"
                style={{ color: 'var(--error)', borderColor: 'var(--error)' }}
                onClick={async () => {
                  if (!confirm(`Are you sure you want to delete credential "${x.name}"?`)) return;
                  await api(`/api/projects/${project.id}/credentials/${x.id}`, { method: 'DELETE' });
                  setItems(prev => prev.filter(c => c.id !== x.id));
                }}
              >
                Delete
              </button>
            </div>
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
