import { useState, useRef, useEffect, useCallback } from "react";
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from "recharts";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "https://intelligent-analytics-assistant.onrender.com";

// ─── DESIGN TOKENS ────────────────────────────────────────────────────────────
const T = {
  bg: "#111318", surface: "#1A1D24", surfaceHover: "#1F222A",
  border: "#252830", borderLight: "#2E3240",
  amber: "#F5A623", amberDim: "#F5A62320", amberBorder: "#F5A62340",
  white: "#F7F6F3", slate: "#3D4451", muted: "#8B92A5", mutedDark: "#5A6072",
  green: "#2DD4BF", red: "#F87171", blue: "#60A5FA", purple: "#A78BFA",
};
const CHART_COLORS = [T.amber, T.green, T.blue, T.purple, "#F472B6", "#34D399"];

// ─── PROVIDERS ────────────────────────────────────────────────────────────────
const PROVIDERS = {
  claude: {
    name: "Claude (Anthropic)", logo: "◈", logoColor: T.amber,
    placeholder: "sk-ant-api03-...", hint: "console.anthropic.com",
    models: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    modelLabels: { "claude-sonnet-4-6": "Claude Sonnet 4.6 (best)", "claude-haiku-4-5-20251001": "Claude Haiku 4.5 (faster)" },
  },
  groq: {
    name: "Groq", logo: "⚡", logoColor: "#F97316",
    placeholder: "gsk_...", hint: "console.groq.com — free tier",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
    modelLabels: { "llama-3.3-70b-versatile": "Llama 3.3 70B (best)", "llama-3.1-8b-instant": "Llama 3.1 8B (fastest)", "mixtral-8x7b-32768": "Mixtral 8x7B" },
  },
  openai: {
    name: "OpenAI", logo: "◎", logoColor: "#10B981",
    placeholder: "sk-proj-...", hint: "platform.openai.com",
    models: ["gpt-4o", "gpt-4o-mini"],
    modelLabels: { "gpt-4o": "GPT-4o (best)", "gpt-4o-mini": "GPT-4o Mini (faster)" },
  },
};

// ─── SAMPLE SCHEMAS ───────────────────────────────────────────────────────────
const SAMPLE_SCHEMAS = {
  ecommerce: {
    label: "E-commerce store", icon: "🛍️",
    sql: `CREATE TABLE customers (
  customer_id INT PRIMARY KEY, name VARCHAR(100),
  email VARCHAR(100), country VARCHAR(50),
  signup_date DATE, tier VARCHAR(20)
);
CREATE TABLE orders (
  order_id INT PRIMARY KEY, customer_id INT,
  order_date DATE, status VARCHAR(20), total_amount DECIMAL(10,2)
);
CREATE TABLE order_items (
  item_id INT PRIMARY KEY, order_id INT,
  product_name VARCHAR(100), category VARCHAR(50),
  quantity INT, unit_price DECIMAL(10,2)
);`,
    questions: ["Which country brings in the most revenue?", "Top 5 product categories by sales?", "Show monthly order trends", "What percentage of orders are cancelled?"],
  },
  saas: {
    label: "SaaS / subscriptions", icon: "💻",
    sql: `CREATE TABLE users (
  user_id INT PRIMARY KEY, email VARCHAR(100),
  plan VARCHAR(20), signup_date DATE,
  country VARCHAR(50), churned BOOLEAN DEFAULT FALSE
);
CREATE TABLE subscriptions (
  sub_id INT PRIMARY KEY, user_id INT,
  plan VARCHAR(20), mrr DECIMAL(10,2),
  start_date DATE, end_date DATE
);`,
    questions: ["What is our monthly recurring revenue?", "What is our churn rate?", "Which plan converts best?", "User signups over 6 months"],
  },
  restaurant: {
    label: "Restaurant / F&B", icon: "🍽️",
    sql: `CREATE TABLE menu_items (
  item_id INT PRIMARY KEY, name VARCHAR(100),
  category VARCHAR(50), price DECIMAL(8,2), cost DECIMAL(8,2)
);
CREATE TABLE orders (
  order_id INT PRIMARY KEY, order_date DATETIME,
  table_number INT, server_name VARCHAR(50), total_amount DECIMAL(10,2)
);
CREATE TABLE order_lines (
  line_id INT PRIMARY KEY, order_id INT,
  item_id INT, quantity INT
);`,
    questions: ["Most ordered dishes?", "Best day of the week by revenue?", "Best and worst performing category?", "Revenue by hour of day"],
  },
};

// ─── GLOBAL STYLES ────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;0,700;0,900;1,400;1,700&family=DM+Sans:wght@400;500;600&display=swap');
  @keyframes slideIn { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
  @keyframes fadeIn  { from { opacity:0 } to { opacity:1 } }
  @keyframes float   { 0%,100% { transform:translateY(0) } 50% { transform:translateY(-6px) } }
  @keyframes pulse   { 0%,100% { opacity:0.3 } 50% { opacity:1 } }
  * { box-sizing:border-box; margin:0; padding:0; }
  textarea:focus, input:focus, select:focus { outline:none; }
  button { cursor:pointer; font-family:inherit; }
  ::-webkit-scrollbar { width:4px; height:4px; }
  ::-webkit-scrollbar-thumb { background:#334155; border-radius:2px; }
  a { color:inherit; text-decoration:none; }
`;

// ─── AUTH STORE (in-memory, no localStorage) ──────────────────────────────────
let _authToken = null;
let _authUser  = null;
const authListeners = new Set();

function setAuth(token, user) {
  _authToken = token;
  _authUser  = user;
  authListeners.forEach(fn => fn(user));
}

function clearAuth() { setAuth(null, null); }
function signOut() { clearAuth(); }

function useAuth() {
  const [user, setUser] = useState(_authUser);
  useEffect(() => {
    const fn = (u) => setUser(u);
    authListeners.add(fn);
    return () => authListeners.delete(fn);
  }, []);
  return user;
}

async function apiFetch(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (_authToken) headers["Authorization"] = `Bearer ${_authToken}`;
  const res = await fetch(`${BACKEND_URL}${path}`, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Error ${res.status}`);
  }
  return res.json();
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmtVal(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!isNaN(n) && String(v).trim() !== "") {
    if (Math.abs(n) >= 1_000_000) return `${(n/1e6).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000)     return `${(n/1e3).toFixed(1)}K`;
    if (String(v).includes("."))  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return n.toLocaleString();
  }
  return String(v);
}

// ─── VIZ ──────────────────────────────────────────────────────────────────────
function SmartViz({ data, vizType }) {
  if (!data?.length) return null;
  const keys = Object.keys(data[0]);
  const labelKey = keys[0];
  const valueKey = keys.find((k, i) => i > 0 && !isNaN(Number(data[0][k]))) || keys[1];
  const tt = { contentStyle: { background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", fontSize: "13px" } };

  if (vizType === "stat" || vizType === "stats") {
    return (
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        {Object.entries(data[0]).map(([k, v]) => (
          <div key={k} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px 24px" }}>
            <div style={{ fontSize: "28px", fontWeight: 700, color: T.amber, fontFamily: "'Fraunces',Georgia,serif" }}>{fmtVal(v)}</div>
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px", textTransform: "uppercase", letterSpacing: "0.07em" }}>{k.replace(/_/g," ")}</div>
          </div>
        ))}
      </div>
    );
  }

  if (vizType === "pie") return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie data={data} dataKey={valueKey} nameKey={labelKey} cx="50%" cy="50%" outerRadius={90} innerRadius={36} paddingAngle={3}>
          {data.map((_,i) => <Cell key={i} fill={CHART_COLORS[i%CHART_COLORS.length]} stroke="none"/>)}
        </Pie>
        <Tooltip {...tt} formatter={fmtVal}/>
        <Legend iconType="circle" iconSize={8} formatter={v => <span style={{color:T.muted,fontSize:"12px"}}>{v}</span>}/>
      </PieChart>
    </ResponsiveContainer>
  );

  if (vizType === "area") return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data} margin={{top:8,right:8,left:0,bottom:0}}>
        <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={T.amber} stopOpacity={0.25}/><stop offset="95%" stopColor={T.amber} stopOpacity={0}/></linearGradient></defs>
        <CartesianGrid strokeDasharray="3 3" stroke={T.border}/>
        <XAxis dataKey={labelKey} tick={{fill:T.muted,fontSize:11}} axisLine={false} tickLine={false}/>
        <YAxis tick={{fill:T.muted,fontSize:11}} axisLine={false} tickLine={false} tickFormatter={fmtVal}/>
        <Tooltip {...tt} formatter={fmtVal}/>
        <Area type="monotone" dataKey={valueKey} stroke={T.amber} strokeWidth={2.5} fill="url(#ag)" dot={false}/>
      </AreaChart>
    </ResponsiveContainer>
  );

  if (vizType === "bar") return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{top:8,right:8,left:0,bottom:0}} barSize={data.length>10?8:22}>
        <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false}/>
        <XAxis dataKey={labelKey} tick={{fill:T.muted,fontSize:11}} axisLine={false} tickLine={false}/>
        <YAxis tick={{fill:T.muted,fontSize:11}} axisLine={false} tickLine={false} tickFormatter={fmtVal}/>
        <Tooltip {...tt} formatter={fmtVal} cursor={{fill:T.amberDim}}/>
        <Bar dataKey={valueKey} fill={T.amber} radius={[4,4,0,0]}/>
      </BarChart>
    </ResponsiveContainer>
  );

  return (
    <div style={{overflowX:"auto",maxHeight:"280px",overflowY:"auto",borderRadius:"8px",border:`1px solid ${T.border}`}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:"13px"}}>
        <thead><tr style={{background:T.bg}}>
          {keys.map(k=><th key={k} style={{padding:"9px 14px",textAlign:"left",color:T.mutedDark,fontWeight:600,fontSize:"11px",textTransform:"uppercase",letterSpacing:"0.07em",borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>{k.replace(/_/g," ")}</th>)}
        </tr></thead>
        <tbody>
          {data.slice(0,50).map((row,i)=>(
            <tr key={i} style={{background:i%2===0?"transparent":`${T.surface}80`}}>
              {keys.map(k=><td key={k} style={{padding:"8px 14px",color:T.white,borderBottom:`1px solid ${T.border}20`,whiteSpace:"nowrap"}}>{fmtVal(row[k])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length>50&&<div style={{padding:"8px 14px",color:T.mutedDark,fontSize:"12px",borderTop:`1px solid ${T.border}`}}>Showing 50 of {data.length} rows</div>}
    </div>
  );
}

// ─── ANALYST MESSAGE ──────────────────────────────────────────────────────────
// ─── DASHBOARD MESSAGE ────────────────────────────────────────────────────────
function DashboardMessage({ msg }) {
  const [expanded, setExpanded] = useState(null); // panel id with expanded SQL

  if (!msg.panels) return null;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:"12px",animation:"slideIn 0.4s ease"}}>
      {/* Summary header */}
      <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:"16px",padding:"20px 24px"}}>
        <div style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"12px"}}>
          <div style={{width:"26px",height:"26px",background:T.amberDim,border:`1px solid ${T.amberBorder}`,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"11px"}}>◈</div>
          <span style={{fontSize:"11px",color:T.amber,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em"}}>Dashboard</span>
          <span style={{marginLeft:"auto",fontSize:"11px",color:T.mutedDark}}>{msg.panels.length} panels</span>
        </div>
        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"20px",fontWeight:700,color:T.white,marginBottom:"8px",letterSpacing:"-0.02em"}}>{msg.title}</div>
        <p style={{color:T.muted,fontSize:"14px",lineHeight:"1.7"}}>{msg.summary}</p>
      </div>

      {/* Panels grid */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:"12px"}}>
        {msg.panels.map(panel => (
          <div key={panel.id} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:"14px",overflow:"hidden"}}>
            <div style={{padding:"14px 18px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:"8px"}}>
              <span style={{fontSize:"11px",color:T.amber,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.07em",flex:1}}>{panel.title}</span>
              {panel.confidence && (
                <span style={{fontSize:"10px",color:panel.confidence==="high"?T.green:panel.confidence==="medium"?T.amber:T.muted,background:`${panel.confidence==="high"?T.green:T.amber}15`,padding:"2px 8px",borderRadius:"20px",whiteSpace:"nowrap"}}>
                  {panel.confidence==="high"?"✓ High":panel.confidence==="medium"?"⚠ Medium":"↓ Low"}
                </span>
              )}
            </div>
            <div style={{padding:"14px 18px",display:"flex",flexDirection:"column",gap:"12px"}}>
              {/* Key metrics row */}
              {panel.keyMetrics?.length>0 && (
                <div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
                  {panel.keyMetrics.map((m,i)=>(
                    <div key={i} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:"8px",padding:"8px 12px",minWidth:"80px"}}>
                      <div style={{fontSize:"18px",fontWeight:700,color:T.amber,fontFamily:"'Fraunces',Georgia,serif"}}>{m.value}</div>
                      <div style={{fontSize:"10px",color:T.muted,marginTop:"2px"}}>{m.label}</div>
                    </div>
                  ))}
                </div>
              )}
              {/* Headline */}
              <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"15px",fontWeight:700,color:T.white,lineHeight:1.35}}>{panel.headline}</div>
              {/* Chart */}
              {panel.data?.length>0 && <SmartViz data={panel.data} vizType={panel.vizType}/>}
              {/* Narrative */}
              <p style={{color:T.muted,fontSize:"13px",lineHeight:"1.65"}}>{panel.narrative}</p>
            </div>
            {/* SQL toggle */}
            {panel.sql && (
              <div style={{borderTop:`1px solid ${T.border}`}}>
                <button onClick={()=>setExpanded(expanded===panel.id?null:panel.id)}
                  style={{width:"100%",padding:"9px 18px",background:"none",border:"none",color:T.mutedDark,fontSize:"11px",textAlign:"left",display:"flex",alignItems:"center",gap:"6px"}}>
                  <span style={{color:T.blue,fontFamily:"monospace"}}>SQL</span>
                  {expanded===panel.id?"Hide":"Show"} query
                  <span style={{marginLeft:"auto"}}>{expanded===panel.id?"↑":"↓"}</span>
                </button>
                {expanded===panel.id && (
                  <div style={{padding:"0 18px 14px"}}>
                    <pre style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:"8px",padding:"10px 14px",fontFamily:"monospace",fontSize:"11.5px",color:"#7DD3FC",lineHeight:1.6,overflowX:"auto",whiteSpace:"pre-wrap",wordBreak:"break-all"}}>{panel.sql}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AnalystMessage({ msg }) {
  const [showSQL, setShowSQL] = useState(false);
  const [vis, setVis] = useState({h:false,n:false,v:false});

  useEffect(() => {
    if (msg.type !== "result") return;
    const t1 = setTimeout(()=>setVis(v=>({...v,h:true})),80);
    const t2 = setTimeout(()=>setVis(v=>({...v,n:true})),320);
    const t3 = setTimeout(()=>setVis(v=>({...v,v:true})),580);
    return ()=>[t1,t2,t3].forEach(clearTimeout);
  },[]);

  if (msg.type==="error") return (
    <div style={{background:"#1A0B0B",border:`1px solid ${T.red}30`,borderRadius:"16px",padding:"14px 18px",color:T.red,fontSize:"14px"}}>{msg.text}</div>
  );

  if (msg.type==="welcome") return (
    <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:"16px",padding:"20px 24px"}}>
      <div style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"12px"}}>
        <div style={{width:"30px",height:"30px",background:T.amberDim,border:`1px solid ${T.amberBorder}`,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"13px"}}>◈</div>
        <span style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"16px",fontWeight:600}}>Your analyst is ready</span>
        {msg.isPro && <span style={{marginLeft:"auto",fontSize:"11px",background:T.amberDim,border:`1px solid ${T.amberBorder}`,color:T.amber,padding:"3px 10px",borderRadius:"20px"}}>Pro</span>}
      </div>
      <p style={{color:T.muted,fontSize:"14px",lineHeight:"1.7",margin:"0 0 16px"}}>{msg.text}</p>
      {msg.questions?.length>0 && <>
        <div style={{fontSize:"11px",color:T.mutedDark,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:"10px"}}>Start with a question</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:"8px"}}>
          {msg.questions.map((q,i)=>(
            <button key={i} onClick={()=>msg.onAsk(q)} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:"20px",padding:"8px 16px",color:T.muted,fontSize:"13px",transition:"all 0.15s"}}
              onMouseEnter={e=>{e.currentTarget.style.borderColor=T.amberBorder;e.currentTarget.style.color=T.white;}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;e.currentTarget.style.color=T.muted;}}>
              {q}
            </button>
          ))}
        </div>
      </>}
    </div>
  );

  return (
    <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:"16px",overflow:"hidden"}}>
      <div style={{padding:"14px 20px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:"10px"}}>
        <div style={{width:"26px",height:"26px",background:T.amberDim,border:`1px solid ${T.amberBorder}`,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"11px"}}>◈</div>
        <span style={{fontSize:"11px",color:T.amber,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em"}}>Analysis</span>
        {msg.confidence && (
          <span style={{marginLeft:"auto",fontSize:"11px",color:msg.confidence==="high"?T.green:msg.confidence==="medium"?T.amber:T.muted,background:`${msg.confidence==="high"?T.green:T.amber}15`,padding:"3px 10px",borderRadius:"20px"}}>
            {msg.confidence==="high"?"High confidence":msg.confidence==="medium"?"Cross-check recommended":"Estimate only"}
          </span>
        )}
      </div>
      <div style={{padding:"20px 24px",display:"flex",flexDirection:"column",gap:"16px"}}>
        {vis.h && <div style={{animation:"slideIn 0.35s ease",fontFamily:"'Fraunces',Georgia,serif",fontSize:"21px",fontWeight:700,color:T.white,lineHeight:1.3,letterSpacing:"-0.02em"}}>{msg.headline}</div>}
        {vis.n && msg.keyMetrics?.length>0 && (
          <div style={{display:"flex",gap:"10px",flexWrap:"wrap",animation:"slideIn 0.35s ease"}}>
            {msg.keyMetrics.map((m,i)=>(
              <div key={i} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:"10px",padding:"10px 16px",minWidth:"90px"}}>
                <div style={{fontSize:"20px",fontWeight:700,color:T.amber,fontFamily:"'Fraunces',Georgia,serif"}}>{m.value}</div>
                <div style={{fontSize:"11px",color:T.muted,marginTop:"4px"}}>{m.label}</div>
              </div>
            ))}
          </div>
        )}
        {vis.n && <p style={{color:"#C8CDD8",fontSize:"15px",lineHeight:"1.75",animation:"slideIn 0.35s ease"}}>{msg.narrative}</p>}
        {vis.v && msg.data?.length>0 && <div style={{animation:"slideIn 0.35s ease"}}><SmartViz data={msg.data} vizType={msg.vizType}/></div>}
      </div>
      <div style={{borderTop:`1px solid ${T.border}`}}>
        <button onClick={()=>setShowSQL(s=>!s)} style={{width:"100%",padding:"11px 20px",background:"none",border:"none",color:T.mutedDark,fontSize:"12px",textAlign:"left",display:"flex",alignItems:"center",gap:"8px"}}>
          <span style={{color:T.blue,fontFamily:"monospace"}}>SQL</span>{showSQL?"Hide query":"Show generated query"}<span style={{marginLeft:"auto"}}>{showSQL?"↑":"↓"}</span>
        </button>
        {showSQL && (
          <div style={{padding:"0 20px 16px"}}>
            <pre style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:"8px",padding:"12px 16px",fontFamily:"monospace",fontSize:"12.5px",color:"#7DD3FC",lineHeight:1.65,overflowX:"auto",whiteSpace:"pre-wrap",wordBreak:"break-all"}}>{msg.sql}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── AUTH PAGE ────────────────────────────────────────────────────────────────
function AuthPage({ onAuth, onBack }) {
  const [mode, setMode]       = useState("login");  // "login" | "signup"
  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw]   = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");

  async function submit() {
    if (!email || !password) { setError("Email and password required"); return; }
    setLoading(true); setError("");
    try {
      const data = await apiFetch(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setAuth(data.token, { email: data.email, is_pro: data.is_pro });
      onAuth({ email: data.email, is_pro: data.is_pro });
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  return (
    <div style={{minHeight:"100vh",background:T.bg,color:T.white,fontFamily:"'DM Sans',system-ui,sans-serif",display:"flex",flexDirection:"column"}}>
      <style>{GLOBAL_CSS}</style>
      <div style={{padding:"20px 32px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:"12px"}}>
        <button onClick={onBack} style={{background:"none",border:"none",color:T.muted,fontSize:"14px"}}>← QueryMind</button>
        <span style={{color:T.border}}>·</span>
        <span style={{color:T.white,fontSize:"14px",fontWeight:500}}>{mode==="login"?"Sign in":"Create account"}</span>
      </div>
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",padding:"40px 24px"}}>
        <div style={{width:"100%",maxWidth:"400px",animation:"fadeIn 0.4s ease"}}>
          <h1 style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"32px",fontWeight:800,letterSpacing:"-0.03em",marginBottom:"8px"}}>
            {mode==="login"?"Welcome back":"Get started free"}
          </h1>
          <p style={{color:T.muted,fontSize:"14px",marginBottom:"32px"}}>
            {mode==="login"
              ? "Sign in to your QueryMind account"
              : "Create an account. No credit card needed to start."}
          </p>

          <div style={{display:"flex",gap:"4px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:"10px",padding:"4px",marginBottom:"24px",width:"fit-content"}}>
            {["login","signup"].map(m=>(
              <button key={m} onClick={()=>{setMode(m);setError("");}}
                style={{background:mode===m?T.border:"none",color:mode===m?T.white:T.muted,border:"none",borderRadius:"7px",padding:"8px 20px",fontSize:"13px",fontWeight:mode===m?600:400,transition:"all 0.15s"}}>
                {m==="login"?"Sign in":"Sign up"}
              </button>
            ))}
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:"14px"}}>
            <div>
              <label style={{display:"block",fontSize:"12px",fontWeight:600,color:T.mutedDark,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:"7px"}}>Email</label>
              <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&submit()}
                placeholder="you@company.com"
                style={{width:"100%",background:T.surface,border:`1px solid ${email?T.amberBorder:T.border}`,borderRadius:"10px",padding:"12px 16px",color:T.white,fontSize:"14px",transition:"border-color 0.2s"}}/>
            </div>
            <div>
              <label style={{display:"block",fontSize:"12px",fontWeight:600,color:T.mutedDark,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:"7px"}}>Password</label>
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} value={password} onChange={e=>setPassword(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&submit()}
                  placeholder={mode==="signup"?"At least 8 characters":""}
                  style={{width:"100%",background:T.surface,border:`1px solid ${password?T.amberBorder:T.border}`,borderRadius:"10px",padding:"12px 44px 12px 16px",color:T.white,fontSize:"14px",transition:"border-color 0.2s"}}/>
                <button onClick={()=>setShowPw(s=>!s)} style={{position:"absolute",right:"12px",top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:T.muted,fontSize:"14px"}}>{showPw?"🙈":"👁️"}</button>
              </div>
            </div>
          </div>

          {error && <div style={{marginTop:"12px",fontSize:"13px",color:T.red,display:"flex",alignItems:"center",gap:"6px"}}>✗ {error}</div>}

          <button onClick={submit} disabled={loading}
            style={{width:"100%",marginTop:"20px",padding:"14px",background:T.amber,border:"none",borderRadius:"12px",color:T.bg,fontSize:"15px",fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",letterSpacing:"-0.01em",opacity:loading?0.7:1,transition:"opacity 0.2s"}}>
            {loading?"Please wait…":mode==="login"?"Sign in →":"Create account →"}
          </button>

          <p style={{textAlign:"center",marginTop:"20px",fontSize:"13px",color:T.muted}}>
            {mode==="login"?"Don't have an account? ":"Already have an account? "}
            <button onClick={()=>{setMode(mode==="login"?"signup":"login");setError("");}} style={{background:"none",border:"none",color:T.amber,fontSize:"13px"}}>
              {mode==="login"?"Sign up free":"Sign in"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── LANDING PAGE ─────────────────────────────────────────────────────────────
function LandingPage({ onStart, onSignIn }) {
  const user = useAuth();
  return (
    <div style={{minHeight:"100vh",background:T.bg,color:T.white,fontFamily:"'DM Sans',system-ui,sans-serif",display:"flex",flexDirection:"column"}}>
      <style>{GLOBAL_CSS}</style>

      {/* Nav */}
      <nav style={{padding:"18px 48px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${T.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:"10px"}}>
          <div style={{width:"30px",height:"30px",background:T.amber,borderRadius:"8px",display:"flex",alignItems:"center",justifyContent:"center",color:T.bg,fontWeight:900,fontSize:"15px"}}>Q</div>
          <span style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"19px",fontWeight:700,letterSpacing:"-0.02em"}}>QueryMind</span>
        </div>
        <div style={{display:"flex",gap:"24px",alignItems:"center"}}>
          <button onClick={()=>document.getElementById("pricing")?.scrollIntoView({behavior:"smooth"})} style={{background:"none",border:"none",color:T.muted,fontSize:"14px"}}>Pricing</button>
          {user
            ? <button onClick={signOut} style={{background:"none",border:"none",color:T.muted,fontSize:"14px"}}>Sign out ({user.email.split("@")[0]})</button>
            : <button onClick={onSignIn} style={{background:"none",border:"none",color:T.white,fontSize:"14px",fontWeight:500}}>Sign in</button>
          }
          <button onClick={onStart} style={{background:T.amber,color:T.bg,border:"none",borderRadius:"8px",padding:"9px 20px",fontSize:"14px",fontWeight:600}}>
            {user?.is_pro ? "Open analyst →" : "Try free →"}
          </button>
        </div>
      </nav>

      {/* Hero */}
      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"72px 24px 48px",textAlign:"center",maxWidth:"800px",margin:"0 auto",animation:"fadeIn 0.6s ease"}}>
        <div style={{display:"inline-flex",alignItems:"center",gap:"8px",background:T.amberDim,border:`1px solid ${T.amberBorder}`,borderRadius:"20px",padding:"6px 16px",fontSize:"13px",color:T.amber,marginBottom:"28px"}}>
          <span style={{width:"6px",height:"6px",background:T.amber,borderRadius:"50%",display:"inline-block"}}/>
          Your senior data analyst, on demand
        </div>
        <h1 style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"clamp(38px,7vw,70px)",fontWeight:900,lineHeight:1.05,letterSpacing:"-0.04em",marginBottom:"22px"}}>
          Ask your database<br/><em style={{color:T.amber,fontStyle:"italic"}}>anything.</em>
        </h1>
        <p style={{fontSize:"17px",color:T.muted,lineHeight:"1.7",maxWidth:"540px",marginBottom:"40px"}}>
          Drop in your SQL schema. Ask in plain English. Get honest, detailed answers — the same quality you'd expect from a senior analyst, without hiring one.
        </p>
        <div style={{display:"flex",gap:"12px",flexWrap:"wrap",justifyContent:"center",marginBottom:"16px"}}>
          <button onClick={onStart} style={{background:T.amber,color:T.bg,border:"none",borderRadius:"12px",padding:"15px 34px",fontSize:"15px",fontWeight:700,fontFamily:"'Fraunces',Georgia,serif"}}>Connect your database</button>
          <button onClick={()=>document.getElementById("how")?.scrollIntoView({behavior:"smooth"})} style={{background:"transparent",color:T.white,border:`1px solid ${T.border}`,borderRadius:"12px",padding:"15px 26px",fontSize:"14px"}}>See how it works</button>
        </div>
        <p style={{fontSize:"12px",color:T.mutedDark}}>MySQL · PostgreSQL · SQLite · any SQL database</p>
      </div>

      {/* Mock preview */}
      <div style={{padding:"0 24px 72px",maxWidth:"720px",margin:"0 auto",width:"100%",animation:"float 4s ease-in-out infinite"}}>
        <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:"20px",overflow:"hidden",boxShadow:"0 32px 80px #00000060"}}>
          <div style={{padding:"12px 16px",borderBottom:`1px solid ${T.border}`,display:"flex",gap:"6px"}}>
            {["#F87171","#FBBF24","#34D399"].map(c=><div key={c} style={{width:"10px",height:"10px",borderRadius:"50%",background:c}}/>)}
          </div>
          <div style={{padding:"20px"}}>
            <div style={{display:"flex",justifyContent:"flex-end",marginBottom:"14px"}}>
              <div style={{background:T.amber,color:T.bg,borderRadius:"14px 14px 4px 14px",padding:"11px 16px",fontSize:"13px",fontWeight:500,maxWidth:"75%"}}>
                Which product category makes me the most money, and is it actually profitable?
              </div>
            </div>
            <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:"14px 14px 14px 4px",padding:"16px 18px"}}>
              <div style={{fontSize:"10px",color:T.amber,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:"7px"}}>Analysis</div>
              <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"16px",fontWeight:700,marginBottom:"9px"}}>Electronics leads revenue but Apparel has the better margins</div>
              <p style={{color:T.muted,fontSize:"13px",lineHeight:1.7}}>Electronics brings in 42% of your revenue but returns eat into margins — you're running at 34% gross. Apparel, your second-largest category, runs at 61% margin. If you want to grow revenue, double down on Electronics. If you want to improve profitability, Apparel is where to invest.</p>
            </div>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div id="how" style={{background:T.surface,borderTop:`1px solid ${T.border}`,padding:"72px 24px"}}>
        <div style={{maxWidth:"880px",margin:"0 auto"}}>
          <div style={{textAlign:"center",marginBottom:"52px"}}>
            <h2 style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"38px",fontWeight:800,letterSpacing:"-0.03em",marginBottom:"10px"}}>No SQL. No analyst. No waiting.</h2>
            <p style={{color:T.muted,fontSize:"15px"}}>Three steps from zero to insight.</p>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:"20px"}}>
            {[
              {n:"01",title:"Connect your schema",body:"Paste your CREATE TABLE statements, upload a .sql file, or pick a template. No data leaves your system."},
              {n:"02",title:"Ask your question",body:"Type what you'd ask a data analyst. Revenue trends, best customers, product margins, churn rates — anything."},
              {n:"03",title:"Get a real answer",body:"QueryMind writes the SQL, interprets the results, and tells you what it means for your business in plain English."},
            ].map(({n,title,body})=>(
              <div key={n} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:"16px",padding:"26px"}}>
                <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"44px",fontWeight:900,color:T.amberDim,lineHeight:1,marginBottom:"14px"}}>{n}</div>
                <h3 style={{fontSize:"17px",fontWeight:600,marginBottom:"9px"}}>{title}</h3>
                <p style={{color:T.muted,fontSize:"14px",lineHeight:"1.7"}}>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Pricing */}
      <div id="pricing" style={{padding:"72px 24px",maxWidth:"760px",margin:"0 auto",width:"100%"}}>
        <div style={{textAlign:"center",marginBottom:"48px"}}>
          <h2 style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"38px",fontWeight:800,letterSpacing:"-0.03em",marginBottom:"10px"}}>Simple pricing</h2>
          <p style={{color:T.muted,fontSize:"15px"}}>Start free. Upgrade when you want zero setup.</p>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:"20px"}}>
          {/* Free */}
          <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:"20px",padding:"32px"}}>
            <div style={{fontSize:"13px",color:T.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:"12px"}}>Free</div>
            <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"44px",fontWeight:900,marginBottom:"6px"}}>$0</div>
            <p style={{color:T.muted,fontSize:"14px",marginBottom:"24px"}}>Bring your own API key from Claude, Groq, or OpenAI.</p>
            <div style={{display:"flex",flexDirection:"column",gap:"10px",marginBottom:"28px"}}>
              {["All 3 LLM providers","All schema templates","File upload (.sql)","Full analyst chat","Open source — self-host it"].map(f=>(
                <div key={f} style={{display:"flex",gap:"10px",alignItems:"center",fontSize:"14px",color:T.muted}}>
                  <span style={{color:T.green,fontSize:"16px"}}>✓</span>{f}
                </div>
              ))}
            </div>
            <button onClick={onStart} style={{width:"100%",padding:"13px",background:"none",border:`1px solid ${T.border}`,borderRadius:"10px",color:T.white,fontSize:"14px",fontWeight:600}}>Get started free</button>
          </div>
          {/* Pro */}
          <div style={{background:T.amberDim,border:`1px solid ${T.amber}`,borderRadius:"20px",padding:"32px",position:"relative"}}>
            <div style={{position:"absolute",top:"20px",right:"20px",background:T.amber,color:T.bg,fontSize:"11px",fontWeight:700,padding:"4px 10px",borderRadius:"20px",textTransform:"uppercase",letterSpacing:"0.06em"}}>Popular</div>
            <div style={{fontSize:"13px",color:T.amber,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:"12px"}}>Pro</div>
            <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"44px",fontWeight:900,marginBottom:"6px"}}>$19<span style={{fontSize:"18px",fontWeight:400,color:T.muted}}>/mo</span></div>
            <p style={{color:T.muted,fontSize:"14px",marginBottom:"24px"}}>No API key needed. QueryMind handles everything.</p>
            <div style={{display:"flex",flexDirection:"column",gap:"10px",marginBottom:"28px"}}>
              {["Everything in Free","No API key required","QueryMind's key, your data","Priority model (best available)","Cancel anytime"].map(f=>(
                <div key={f} style={{display:"flex",gap:"10px",alignItems:"center",fontSize:"14px",color:T.white}}>
                  <span style={{color:T.amber,fontSize:"16px"}}>✓</span>{f}
                </div>
              ))}
            </div>
            <button onClick={onSignIn} style={{width:"100%",padding:"13px",background:T.amber,border:"none",borderRadius:"10px",color:T.bg,fontSize:"14px",fontWeight:700,fontFamily:"'Fraunces',Georgia,serif"}}>Sign up for Pro →</button>
          </div>
        </div>
      </div>

      <footer style={{padding:"22px 48px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"16px",fontWeight:700}}>QueryMind</span>
        <span style={{color:T.mutedDark,fontSize:"13px"}}>Built by <a href="https://linkedin.com/in/kinghenrymorgan" target="_blank" rel="noreferrer" style={{color:T.muted}}>Henry Dibie</a> · MIT License</span>
      </footer>
    </div>
  );
}

// ─── API KEY PAGE (free tier only) ────────────────────────────────────────────
function APIKeyPage({ onSaved, onBack }) {
  const [provider, setProvider] = useState("claude");
  const [model, setModel]       = useState(PROVIDERS.claude.models[0]);
  const [apiKey, setApiKey]     = useState("");
  const [showKey, setShowKey]   = useState(false);
  const [testing, setTesting]   = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testMsg, setTestMsg]   = useState("");
  const p = PROVIDERS[provider];

  function switchProvider(key) { setProvider(key); setModel(PROVIDERS[key].models[0]); setApiKey(""); setTestResult(null); }

  async function testKey() {
    if (!apiKey.trim()) return;
    setTesting(true); setTestResult(null);
    try {
      await apiFetch("/query/schema", {
        method: "POST",
        body: JSON.stringify({ question:"How many tables?", schema_ddl:"CREATE TABLE test(id INT);", provider, api_key:apiKey.trim(), model }),
      });
      setTestResult("ok"); setTestMsg("Connection successful — your key works.");
    } catch (e) {
      setTestResult("error"); setTestMsg(e.message || "Key test failed.");
    }
    setTesting(false);
  }

  const ready = apiKey.trim().length > 10;

  return (
    <div style={{minHeight:"100vh",background:T.bg,color:T.white,fontFamily:"'DM Sans',system-ui,sans-serif"}}>
      <style>{GLOBAL_CSS}</style>
      <div style={{padding:"20px 32px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:"12px"}}>
        <button onClick={onBack} style={{background:"none",border:"none",color:T.muted,fontSize:"14px"}}>← QueryMind</button>
        <span style={{color:T.border}}>·</span>
        <span style={{color:T.white,fontSize:"14px",fontWeight:500}}>Choose your AI provider</span>
      </div>
      <div style={{maxWidth:"580px",margin:"0 auto",padding:"48px 24px",animation:"fadeIn 0.4s ease"}}>
        <h1 style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"32px",fontWeight:800,letterSpacing:"-0.03em",marginBottom:"8px"}}>Which AI powers your analyst?</h1>
        <p style={{color:T.muted,fontSize:"14px",marginBottom:"8px"}}>Your key stays in your browser session — never stored, never logged.</p>
        <button onClick={onBack} style={{background:"none",border:"none",color:T.amber,fontSize:"13px",padding:"0 0 24px",display:"block"}}>
          Or upgrade to Pro and skip this entirely →
        </button>

        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"10px",marginBottom:"24px"}}>
          {Object.entries(PROVIDERS).map(([key,prov])=>(
            <button key={key} onClick={()=>switchProvider(key)}
              style={{background:provider===key?T.amberDim:T.surface,border:`1px solid ${provider===key?T.amber:T.border}`,borderRadius:"12px",padding:"16px 12px",textAlign:"center",transition:"all 0.15s"}}>
              <div style={{fontSize:"20px",color:prov.logoColor,marginBottom:"6px",fontFamily:"'Fraunces',Georgia,serif",fontWeight:700}}>{prov.logo}</div>
              <div style={{fontSize:"12px",fontWeight:provider===key?600:400,color:provider===key?T.white:T.muted,lineHeight:1.3}}>{prov.name}</div>
            </button>
          ))}
        </div>

        <div style={{marginBottom:"18px"}}>
          <label style={{display:"block",fontSize:"12px",fontWeight:600,color:T.mutedDark,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:"7px"}}>Model</label>
          <select value={model} onChange={e=>setModel(e.target.value)}
            style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:"10px",padding:"12px 16px",color:T.white,fontSize:"14px",appearance:"none"}}>
            {p.models.map(m=><option key={m} value={m}>{p.modelLabels[m]}</option>)}
          </select>
        </div>

        <div style={{marginBottom:"16px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"7px"}}>
            <label style={{fontSize:"12px",fontWeight:600,color:T.mutedDark,textTransform:"uppercase",letterSpacing:"0.07em"}}>API Key</label>
            <a href={`https://${p.hint.split(" ")[0]}`} target="_blank" rel="noreferrer" style={{fontSize:"12px",color:T.amber}}>{p.hint}</a>
          </div>
          <div style={{position:"relative"}}>
            <input type={showKey?"text":"password"} value={apiKey} onChange={e=>{setApiKey(e.target.value);setTestResult(null);}} placeholder={p.placeholder}
              style={{width:"100%",background:T.surface,border:`1px solid ${testResult==="ok"?T.green:testResult==="error"?T.red:apiKey.length>5?T.amberBorder:T.border}`,borderRadius:"10px",padding:"12px 46px 12px 16px",color:T.white,fontSize:"14px",fontFamily:"monospace",transition:"border-color 0.2s"}}/>
            <button onClick={()=>setShowKey(s=>!s)} style={{position:"absolute",right:"12px",top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:T.muted,fontSize:"14px"}}>{showKey?"🙈":"👁️"}</button>
          </div>
          {testResult && <div style={{marginTop:"7px",fontSize:"13px",color:testResult==="ok"?T.green:T.red}}>{testResult==="ok"?"✓":"✗"} {testMsg}</div>}
        </div>

        <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:"10px",padding:"12px 16px",marginBottom:"22px",display:"flex",gap:"10px",alignItems:"flex-start"}}>
          <span style={{fontSize:"15px",flexShrink:0}}>🔒</span>
          <p style={{color:T.muted,fontSize:"13px",lineHeight:"1.6",margin:0}}>Stored only in browser session memory. Sent directly from your browser to {p.name}. Closing this tab clears it.</p>
        </div>

        <div style={{display:"flex",gap:"10px"}}>
          <button onClick={testKey} disabled={!ready||testing}
            style={{flex:"0 0 auto",padding:"13px 18px",background:"none",border:`1px solid ${T.border}`,borderRadius:"12px",color:ready?T.muted:T.mutedDark,fontSize:"14px",transition:"all 0.15s"}}>
            {testing?"Testing…":"Test key"}
          </button>
          <button onClick={()=>onSaved({provider,model,apiKey:apiKey.trim()})} disabled={!ready}
            style={{flex:1,padding:"13px",background:ready?T.amber:T.surface,border:"none",borderRadius:"12px",color:ready?T.bg:T.mutedDark,fontSize:"15px",fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",transition:"all 0.2s"}}>
            Continue →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── CONNECT PAGE ─────────────────────────────────────────────────────────────
function ConnectPage({ onConnected, onBack }) {
  const [mode, setMode]   = useState("template");
  const [schema, setSchema] = useState("");
  const [dbName, setDbName] = useState("");
  const [selected, setSelected] = useState(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);

  function handleFile(file) {
    const r = new FileReader();
    r.onload = e => { setSchema(e.target.result); setDbName(file.name.replace(/\.[^.]+$/,"")); setMode("paste"); };
    r.readAsText(file);
  }

  function pickTemplate(key) {
    setSchema(SAMPLE_SCHEMAS[key].sql); setDbName(SAMPLE_SCHEMAS[key].label);
    setSelected(key); setMode("paste");
  }

  const ready = schema.trim().length>30 && dbName.trim().length>0;

  return (
    <div style={{minHeight:"100vh",background:T.bg,color:T.white,fontFamily:"'DM Sans',system-ui,sans-serif"}}>
      <style>{GLOBAL_CSS}</style>
      <div style={{padding:"20px 32px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:"12px"}}>
        <button onClick={onBack} style={{background:"none",border:"none",color:T.muted,fontSize:"14px"}}>← Back</button>
        <span style={{color:T.border}}>·</span>
        <span style={{color:T.white,fontSize:"14px",fontWeight:500}}>Connect your database</span>
      </div>
      <div style={{maxWidth:"680px",margin:"0 auto",padding:"48px 24px",animation:"fadeIn 0.4s ease"}}>
        <h1 style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:"34px",fontWeight:800,letterSpacing:"-0.03em",marginBottom:"8px"}}>What database are we working with?</h1>
        <p style={{color:T.muted,fontSize:"14px",marginBottom:"32px"}}>QueryMind only reads your table structure — no data leaves your system.</p>

        <div style={{display:"flex",gap:"4px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:"10px",padding:"4px",marginBottom:"24px",width:"fit-content"}}>
          {[{k:"template",l:"Templates"},{k:"paste",l:"Paste SQL"},{k:"string",l:"Connection string"}].map(({k,l})=>(
            <button key={k} onClick={()=>setMode(k)} style={{background:mode===k?T.border:"none",color:mode===k?T.white:T.muted,border:"none",borderRadius:"7px",padding:"8px 16px",fontSize:"13px",fontWeight:mode===k?600:400,transition:"all 0.15s"}}>{l}</button>
          ))}
        </div>

        {mode==="template" && (
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(190px,1fr))",gap:"12px",animation:"slideIn 0.3s ease"}}>
            {Object.entries(SAMPLE_SCHEMAS).map(([key,t])=>(
              <button key={key} onClick={()=>pickTemplate(key)}
                style={{background:T.surface,border:`1px solid ${selected===key?T.amber:T.border}`,borderRadius:"12px",padding:"20px",textAlign:"left",transition:"all 0.15s"}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=T.amberBorder}
                onMouseLeave={e=>e.currentTarget.style.borderColor=selected===key?T.amber:T.border}>
                <div style={{fontSize:"26px",marginBottom:"10px"}}>{t.icon}</div>
                <div style={{fontSize:"14px",fontWeight:600,color:T.white,marginBottom:"4px"}}>{t.label}</div>
                <div style={{fontSize:"12px",color:T.muted}}>Sample schema included</div>
              </button>
            ))}
            <button onClick={()=>fileRef.current?.click()}
              onDragOver={e=>{e.preventDefault();setDragging(true);}}
              onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);e.dataTransfer.files[0]&&handleFile(e.dataTransfer.files[0]);}}
              style={{background:dragging?T.amberDim:T.surface,border:`2px dashed ${dragging?T.amber:T.borderLight}`,borderRadius:"12px",padding:"20px",textAlign:"left",transition:"all 0.15s"}}>
              <div style={{fontSize:"26px",marginBottom:"10px"}}>📂</div>
              <div style={{fontSize:"14px",fontWeight:600,color:T.white,marginBottom:"4px"}}>Upload .sql file</div>
              <div style={{fontSize:"12px",color:T.muted}}>Drag & drop or click</div>
            </button>
            <input ref={fileRef} type="file" accept=".sql,.txt" style={{display:"none"}} onChange={e=>e.target.files[0]&&handleFile(e.target.files[0])}/>
          </div>
        )}

        {mode==="paste" && (
          <div style={{animation:"slideIn 0.3s ease"}}>
            <div style={{marginBottom:"14px"}}>
              <label style={{display:"block",fontSize:"12px",fontWeight:600,color:T.mutedDark,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:"7px"}}>Database name</label>
              <input value={dbName} onChange={e=>setDbName(e.target.value)} placeholder="e.g. My Shopify Store"
                style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:"10px",padding:"12px 16px",color:T.white,fontSize:"14px"}}/>
            </div>
            <div style={{marginBottom:"18px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"7px"}}>
                <label style={{fontSize:"12px",fontWeight:600,color:T.mutedDark,textTransform:"uppercase",letterSpacing:"0.07em"}}>Schema (CREATE TABLE statements)</label>
                <button onClick={()=>fileRef.current?.click()} style={{background:"none",border:"none",color:T.amber,fontSize:"12px"}}>Upload file</button>
                <input ref={fileRef} type="file" accept=".sql,.txt" style={{display:"none"}} onChange={e=>e.target.files[0]&&handleFile(e.target.files[0])}/>
              </div>
              <textarea value={schema} onChange={e=>setSchema(e.target.value)} rows={12}
                placeholder={"CREATE TABLE customers (\n  id INT PRIMARY KEY,\n  ...\n);"}
                style={{width:"100%",background:T.surface,border:`1px solid ${schema.length>30?T.amberBorder:T.border}`,borderRadius:"10px",padding:"14px 16px",color:"#94A3B8",fontSize:"12.5px",fontFamily:"monospace",lineHeight:"1.7",resize:"vertical",transition:"border-color 0.2s"}}/>
              <div style={{fontSize:"12px",color:T.mutedDark,marginTop:"5px"}}>{schema.length>30?"✓ Schema detected":"Paste your DDL above"}</div>
            </div>
          </div>
        )}

        {mode==="string" && (
          <div style={{animation:"slideIn 0.3s ease",background:T.surface,border:`1px solid ${T.amberBorder}`,borderRadius:"12px",padding:"22px"}}>
            <div style={{color:T.amber,fontWeight:600,fontSize:"14px",marginBottom:"8px"}}>Live connection — coming soon</div>
            <p style={{color:T.muted,fontSize:"14px",lineHeight:"1.6",marginBottom:"14px"}}>Direct database connections with real query execution are on the roadmap. For now, paste your CREATE TABLE statements — everything else works the same.</p>
            <button onClick={()=>setMode("paste")} style={{background:T.amberDim,border:`1px solid ${T.amberBorder}`,color:T.amber,borderRadius:"8px",padding:"8px 16px",fontSize:"13px"}}>Paste schema instead →</button>
          </div>
        )}

        {ready && (
          <button onClick={()=>onConnected({schema,dbName,questions:selected?SAMPLE_SCHEMAS[selected].questions:[]})}
            style={{width:"100%",padding:"15px",background:T.amber,border:"none",borderRadius:"12px",color:T.bg,fontSize:"15px",fontWeight:700,fontFamily:"'Fraunces',Georgia,serif",marginTop:"8px",animation:"slideIn 0.3s ease"}}>
            Start analysing → {dbName}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── ANALYST PAGE ─────────────────────────────────────────────────────────────
function AnalystPage({ db, llmConfig, user, onBack }) {
  const isPro = user?.is_pro && !llmConfig;
  const [messages, setMessages] = useState([{
    id: 0, role: "assistant", type: "welcome",
    isPro,
    text: `I've read ${db.dbName}. Ask me anything about your business, or tap "Generate Dashboard" for a complete overview.`,
    questions: db.questions,
    onAsk: () => {},
  }]);
  const [input, setInput]         = useState("");
  const [loading, setLoading]     = useState(false);
  const [loadingText, setLoadingText] = useState("");
  const [dashLoading, setDashLoading] = useState(false);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);
  const idRef     = useRef(1);

  useEffect(() => { bottomRef.current?.scrollIntoView({behavior:"smooth"}); }, [messages, loading, dashLoading]);

  const generateDashboard = useCallback(async () => {
    if (loading || dashLoading) return;
    setDashLoading(true);
    setMessages(prev => [...prev, {id:idRef.current++, role:"user", text:"Generate a complete business dashboard for this database."}]);

    const phases = ["Analysing your schema…","Planning dashboard panels…","Building charts…","Writing insights…"];
    let pi = 0; setLoadingText(phases[0]);
    const iv = setInterval(() => { pi=(pi+1)%phases.length; setLoadingText(phases[pi]); }, 2000);

    try {
      const body = {
        schema_ddl: db.schema,
        ...(llmConfig ? { provider: llmConfig.provider, api_key: llmConfig.apiKey, model: llmConfig.model } : {}),
      };
      const result = await apiFetch("/dashboard", { method:"POST", body: JSON.stringify(body) });
      setMessages(prev => [...prev, { id:idRef.current++, role:"assistant", type:"dashboard", ...result }]);
    } catch (err) {
      setMessages(prev => [...prev, { id:idRef.current++, role:"assistant", type:"error", text: err.message || "Dashboard generation failed." }]);
    }

    clearInterval(iv); setDashLoading(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [loading, dashLoading, db.schema, llmConfig]);

  const ask = useCallback(async (question) => {
    if (!question.trim() || loading) return;
    setInput(""); setLoading(true);
    setMessages(prev => [...prev, {id:idRef.current++,role:"user",text:question}]);

    const phases = ["Reading your schema…","Writing the query…","Interpreting results…","Drafting your answer…"];
    let pi = 0; setLoadingText(phases[0]);
    const iv = setInterval(() => { pi=(pi+1)%phases.length; setLoadingText(phases[pi]); }, 1800);

    try {
      const body = {
        question,
        schema_ddl: db.schema,
        // Pro users: no api_key sent — backend uses QueryMind's key
        ...(llmConfig ? { provider: llmConfig.provider, api_key: llmConfig.apiKey, model: llmConfig.model } : {}),
      };
      const result = await apiFetch("/query/schema", { method:"POST", body: JSON.stringify(body) });
      setMessages(prev => [...prev, { id:idRef.current++, role:"assistant", type:"result", ...result }]);
    } catch (err) {
      setMessages(prev => [...prev, { id:idRef.current++, role:"assistant", type:"error", text: err.message || "Something went wrong. Try rephrasing your question." }]);
    }

    clearInterval(iv); setLoading(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [loading, db.schema, llmConfig]);

  useEffect(() => {
    setMessages(prev => prev.map(m => m.type==="welcome" ? {...m, onAsk: ask} : m));
  }, [ask]);

  return (
    <div style={{minHeight:"100vh",background:T.bg,color:T.white,fontFamily:"'DM Sans',system-ui,sans-serif",display:"flex",flexDirection:"column"}}>
      <style>{GLOBAL_CSS}</style>
      {/* Top bar */}
      <div style={{padding:"13px 22px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:"12px",position:"sticky",top:0,background:T.bg,zIndex:10}}>
        <button onClick={onBack} style={{background:"none",border:"none",color:T.muted,fontSize:"13px"}}>← Back</button>
        <div style={{width:"1px",height:"18px",background:T.border}}/>
        <div style={{width:"26px",height:"26px",background:T.amber,borderRadius:"7px",display:"flex",alignItems:"center",justifyContent:"center",color:T.bg,fontWeight:900,fontSize:"12px",flexShrink:0}}>Q</div>
        <div>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontWeight:700,fontSize:"14px",letterSpacing:"-0.02em"}}>{db.dbName}</div>
          <div style={{fontSize:"11px",color:T.mutedDark}}>QueryMind Analyst</div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:"10px"}}>
          {isPro
            ? <span style={{fontSize:"12px",background:T.amberDim,border:`1px solid ${T.amberBorder}`,color:T.amber,padding:"4px 12px",borderRadius:"20px"}}>◈ Pro</span>
            : llmConfig && <span style={{fontSize:"12px",background:T.surface,border:`1px solid ${T.border}`,color:T.muted,padding:"4px 12px",borderRadius:"20px"}}>{PROVIDERS[llmConfig.provider].logo} {PROVIDERS[llmConfig.provider].name.split(" ")[0]}</span>
          }
          {user && (
            <button onClick={() => { signOut(); onBack(); }}
              style={{background:"none",border:"none",color:T.mutedDark,fontSize:"12px",cursor:"pointer"}}
              title={`Signed in as ${user.email} — click to sign out`}>
              {user.email.split("@")[0]} ↗
            </button>
          )}
          <div style={{display:"flex",alignItems:"center",gap:"5px"}}>
            <div style={{width:"6px",height:"6px",borderRadius:"50%",background:T.green}}/>
            <span style={{fontSize:"12px",color:T.mutedDark}}>Ready</span>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div style={{flex:1,overflowY:"auto",padding:"22px 18px",display:"flex",flexDirection:"column",gap:"18px",maxWidth:"840px",width:"100%",margin:"0 auto"}}>
        {messages.map(msg=>(
          <div key={msg.id} style={{animation:"slideIn 0.35s ease"}}>
            {msg.role==="user"
              ? <div style={{display:"flex",justifyContent:"flex-end"}}><div style={{background:T.amber,color:T.bg,borderRadius:"16px 16px 4px 16px",padding:"12px 18px",maxWidth:"78%",fontSize:"14px",fontWeight:500,lineHeight:"1.5"}}>{msg.text}</div></div>
              : msg.type==="dashboard"
                ? <DashboardMessage msg={msg}/>
                : <AnalystMessage msg={msg}/>}
          </div>
        ))}
        {(loading || dashLoading) && (
          <div style={{animation:"slideIn 0.3s ease"}}>
            <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:"16px",padding:"18px 22px",display:"flex",alignItems:"center",gap:"12px"}}>
              <div style={{display:"flex",gap:"5px"}}>
                {[0,1,2].map(i=><div key={i} style={{width:"6px",height:"6px",borderRadius:"50%",background:T.amber,animation:`pulse 1.4s ${i*0.2}s ease-in-out infinite`}}/>)}
              </div>
              <span style={{fontSize:"13px",color:T.muted}}>{loadingText}</span>
            </div>
          </div>
        )}
        <div ref={bottomRef}/>
      </div>

      {/* Input */}
      <div style={{padding:"14px 18px 18px",borderTop:`1px solid ${T.border}`,background:T.bg,position:"sticky",bottom:0}}>
        <div style={{maxWidth:"840px",margin:"0 auto"}}>
          {/* Dashboard button row */}
          <div style={{display:"flex",justifyContent:"flex-end",marginBottom:"8px"}}>
            <button onClick={generateDashboard} disabled={loading||dashLoading}
              style={{display:"flex",alignItems:"center",gap:"6px",background:loading||dashLoading?T.surface:T.amberDim,border:`1px solid ${loading||dashLoading?T.border:T.amberBorder}`,borderRadius:"20px",padding:"7px 16px",color:loading||dashLoading?T.mutedDark:T.amber,fontSize:"12px",fontWeight:600,transition:"all 0.15s"}}>
              {dashLoading ? "⏳ Building dashboard…" : "⊞ Generate Dashboard"}
            </button>
          </div>
          <div style={{display:"flex",gap:"10px",alignItems:"flex-end",background:T.surface,border:`1px solid ${input.length>0?T.amberBorder:T.border}`,borderRadius:"14px",padding:"11px 13px",transition:"border-color 0.2s"}}>
            <textarea ref={inputRef} value={input} rows={1}
              onChange={e=>{setInput(e.target.value);e.target.style.height="auto";e.target.style.height=Math.min(e.target.scrollHeight,120)+"px";}}
              onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();ask(input);}}}
              placeholder="Ask anything about your business data…"
              style={{flex:1,background:"none",border:"none",color:T.white,fontSize:"15px",fontFamily:"inherit",resize:"none",lineHeight:"1.5",maxHeight:"120px",overflow:"auto"}}/>
            <button onClick={()=>ask(input)} disabled={!input.trim()||loading}
              style={{width:"36px",height:"36px",borderRadius:"10px",background:input.trim()&&!loading?T.amber:T.border,border:"none",color:input.trim()&&!loading?T.bg:T.mutedDark,fontSize:"16px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.15s",fontWeight:700}}>↑</button>
          </div>
          <div style={{textAlign:"center",fontSize:"11px",color:T.mutedDark,marginTop:"7px"}}>
            Only SELECT queries run — QueryMind never modifies your data
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ROOT ──────────────────────────────────────────────────────────────────────
export default function QueryMind() {
  const user      = useAuth();
  const [page, setPage]           = useState("landing");
  const [db, setDb]               = useState(null);
  const [llmConfig, setLlmConfig] = useState(null);

  // Pro users skip the API key screen — backend uses QueryMind's key
  function handleStartFree() {
    if (user?.is_pro) { setPage("connect"); return; }
    setPage("apikey");
  }

  function handleAuth(u) {
    if (u.is_pro) { setLlmConfig(null); setPage("connect"); }
    else           { setPage("apikey"); }
  }

  if (page==="landing")  return <LandingPage onStart={handleStartFree} onSignIn={()=>setPage("auth")}/>;
  if (page==="auth")     return <AuthPage onAuth={handleAuth} onBack={()=>setPage("landing")}/>;
  if (page==="apikey")   return <APIKeyPage onSaved={cfg=>{setLlmConfig(cfg);setPage("connect");}} onBack={()=>setPage("landing")}/>;
  if (page==="connect")  return <ConnectPage onConnected={data=>{if(!data){setPage(user?.is_pro?"landing":"apikey");return;}setDb(data);setPage("analyst");}} onBack={()=>setPage(user?.is_pro?"landing":"apikey")}/>;
  if (page==="analyst")  return <AnalystPage db={db} llmConfig={llmConfig} user={user} onBack={()=>setPage("connect")}/>;
  return null;
}
