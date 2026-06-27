import { useState, useRef, useEffect } from "react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

// ─── Design tokens ───────────────────────────────────────────────────────────
// Palette: deep navy (#0D1117), electric indigo (#4F46E5), soft white (#F8FAFC),
// slate (#334155), muted (#94A3B8), success-green (#10B981), amber (#F59E0B)
// Type: "Space Grotesk" display, "Inter" body
// Signature: the "translation beam" — a subtle animated gradient line that fires
// between the question and the answer, making the AI act feel physical.

const COLORS = ["#4F46E5", "#10B981", "#F59E0B", "#EC4899", "#06B6D4", "#8B5CF6"];

const SAMPLE_SCHEMA = `-- E-commerce sample schema
CREATE TABLE customers (
  customer_id INT PRIMARY KEY,
  name VARCHAR(100),
  email VARCHAR(100),
  country VARCHAR(50),
  signup_date DATE,
  tier VARCHAR(20) -- 'bronze', 'silver', 'gold'
);

CREATE TABLE orders (
  order_id INT PRIMARY KEY,
  customer_id INT,
  order_date DATE,
  status VARCHAR(20), -- 'pending', 'shipped', 'delivered', 'cancelled'
  total_amount DECIMAL(10,2),
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE order_items (
  item_id INT PRIMARY KEY,
  order_id INT,
  product_name VARCHAR(100),
  category VARCHAR(50),
  quantity INT,
  unit_price DECIMAL(10,2),
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);`;

const SAMPLE_QUESTIONS = [
  "Which country has the most customers?",
  "What are the top 5 product categories by revenue?",
  "Show me monthly order trends for this year",
  "What percentage of orders are cancelled vs delivered?",
  "Who are the top 10 customers by total spend?",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function detectChartType(data, sql) {
  if (!data || data.length === 0) return null;
  const keys = Object.keys(data[0]);
  const sqlLower = sql.toLowerCase();
  if (data.length === 1 && keys.length === 1) return "stat";
  if (sqlLower.includes("group by") && keys.length >= 2) {
    const hasDate = keys.some(k => k.toLowerCase().includes("date") || k.toLowerCase().includes("month") || k.toLowerCase().includes("year"));
    if (hasDate) return "line";
    if (data.length <= 8) return "pie";
    return "bar";
  }
  return "table";
}

function SmartChart({ data, chartType }) {
  if (!data || data.length === 0) return null;
  const keys = Object.keys(data[0]);
  const labelKey = keys[0];
  const valueKey = keys[1];

  if (chartType === "stat") {
    const val = Object.values(data[0])[0];
    const label = keys[0].replace(/_/g, " ");
    return (
      <div style={{ textAlign: "center", padding: "32px" }}>
        <div style={{ fontSize: "56px", fontWeight: 700, color: "#4F46E5", fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1 }}>
          {typeof val === "number" ? val.toLocaleString() : val}
        </div>
        <div style={{ color: "#94A3B8", marginTop: "8px", fontSize: "14px", textTransform: "uppercase", letterSpacing: "0.1em" }}>{label}</div>
      </div>
    );
  }

  if (chartType === "pie" && data.length <= 8) {
    return (
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie data={data} dataKey={valueKey} nameKey={labelKey} cx="50%" cy="50%" outerRadius={90} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false} fontSize={11}>
            {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
          </Pie>
          <Tooltip formatter={(v) => typeof v === "number" ? v.toLocaleString() : v} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "line") {
    return (
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
          <XAxis dataKey={labelKey} tick={{ fill: "#94A3B8", fontSize: 11 }} />
          <YAxis tick={{ fill: "#94A3B8", fontSize: 11 }} />
          <Tooltip contentStyle={{ background: "#1E293B", border: "1px solid #334155", borderRadius: "8px" }} labelStyle={{ color: "#F8FAFC" }} />
          <Line type="monotone" dataKey={valueKey} stroke="#4F46E5" strokeWidth={2.5} dot={{ fill: "#4F46E5", r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "bar") {
    return (
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
          <XAxis dataKey={labelKey} tick={{ fill: "#94A3B8", fontSize: 11 }} />
          <YAxis tick={{ fill: "#94A3B8", fontSize: 11 }} />
          <Tooltip contentStyle={{ background: "#1E293B", border: "1px solid #334155", borderRadius: "8px" }} labelStyle={{ color: "#F8FAFC" }} />
          <Bar dataKey={valueKey} fill="#4F46E5" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  // Table fallback
  return (
    <div style={{ overflowX: "auto", maxHeight: "280px", overflowY: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
        <thead>
          <tr>
            {keys.map(k => (
              <th key={k} style={{ padding: "8px 12px", textAlign: "left", color: "#94A3B8", borderBottom: "1px solid #1E293B", fontWeight: 600, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", position: "sticky", top: 0, background: "#0F172A" }}>
                {k.replace(/_/g, " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 50).map((row, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "#0D1117" }}>
              {keys.map(k => (
                <td key={k} style={{ padding: "8px 12px", color: "#F8FAFC", borderBottom: "1px solid #1E293B20" }}>
                  {row[k] !== null && row[k] !== undefined ? String(row[k]) : <span style={{ color: "#475569" }}>null</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length > 50 && <div style={{ textAlign: "center", padding: "8px", color: "#64748B", fontSize: "12px" }}>Showing 50 of {data.length} rows</div>}
    </div>
  );
}

function TranslationBeam({ active }) {
  return (
    <div style={{
      height: "2px",
      background: active ? "linear-gradient(90deg, transparent, #4F46E5, #10B981, transparent)" : "transparent",
      backgroundSize: "200% 100%",
      transition: "all 0.3s",
      animation: active ? "beam 1.2s linear infinite" : "none",
      margin: "4px 0",
      borderRadius: "1px",
    }} />
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function DataSpeak() {
  const [schema, setSchema] = useState(SAMPLE_SCHEMA);
  const [schemaConfirmed, setSchemaConfirmed] = useState(false);
  const [schemaName, setSchemaName] = useState("My Database");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState("setup"); // "setup" | "chat"
  const [parsedSchema, setParsedSchema] = useState(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function parseSchemaForDisplay(ddl) {
    const tableMatches = [...ddl.matchAll(/CREATE TABLE\s+(\w+)\s*\(([^;]+)\)/gi)];
    return tableMatches.map(m => {
      const name = m[1];
      const cols = m[2].split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("--") && !l.startsWith("FOREIGN") && !l.startsWith("PRIMARY") && !l.startsWith(")"));
      return { name, cols: cols.slice(0, 6) };
    });
  }

  function confirmSchema() {
    const tables = parseSchemaForDisplay(schema);
    setParsedSchema(tables);
    setSchemaConfirmed(true);
    setView("chat");
    setMessages([{
      role: "assistant",
      type: "welcome",
      text: `I've read your schema — ${tables.length} table${tables.length !== 1 ? "s" : ""} detected: ${tables.map(t => `**${t.name}**`).join(", ")}. Ask me anything about your data in plain English.`,
    }]);
  }

  async function ask(question) {
    if (!question.trim() || loading) return;
    setInput("");
    setLoading(true);

    const userMsg = { role: "user", text: question };
    setMessages(prev => [...prev, userMsg]);

    try {
      const systemPrompt = `You are DataSpeak, an expert SQL analyst and data interpreter. 
The user has provided this database schema:

${schema}

Your job for every question:
1. Generate the correct SQL query (use standard SQL compatible with MySQL/PostgreSQL)
2. Generate realistic mock data that the query WOULD return (as a JSON array of objects, max 20 rows)
3. Write a clear, insightful English narrative interpreting the results — 2-4 sentences that tell the business story, not just repeat the numbers

Respond ONLY with valid JSON in this exact format:
{
  "sql": "SELECT ...",
  "data": [...],
  "narrative": "Plain English interpretation...",
  "headline": "Short 5-8 word insight headline"
}

Rules:
- data must be a valid JSON array matching the SQL output columns
- Use realistic mock values that make business sense
- narrative should highlight the most interesting/actionable insight
- If the question can't be answered with the schema, explain why in the narrative and set data to []`;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system: systemPrompt,
          messages: [{ role: "user", content: question }],
        }),
      });

      const raw = await response.json();
      const text = raw.content?.map(b => b.text || "").join("") || "";
      const clean = text.replace(/```json|```/g, "").trim();

      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch {
        // Try to extract JSON from the text
        const match = clean.match(/\{[\s\S]*\}/);
        parsed = match ? JSON.parse(match[0]) : null;
      }

      if (!parsed) throw new Error("Could not parse response");

      const chartType = detectChartType(parsed.data, parsed.sql || "");
      setMessages(prev => [...prev, {
        role: "assistant",
        type: "result",
        question,
        headline: parsed.headline,
        narrative: parsed.narrative,
        sql: parsed.sql,
        data: parsed.data,
        chartType,
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: "assistant",
        type: "error",
        text: "Something went wrong interpreting your question. Please try again.",
      }]);
    }

    setLoading(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  }

  // ── Setup screen ─────────────────────────────────────────────────────────
  if (view === "setup") {
    return (
      <div style={{ minHeight: "100vh", background: "#0D1117", color: "#F8FAFC", fontFamily: "'Inter', system-ui, sans-serif", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px" }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');
          @keyframes beam { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
          @keyframes fadeUp { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: translateY(0) } }
          * { box-sizing: border-box; }
          ::-webkit-scrollbar { width: 4px; height: 4px; }
          ::-webkit-scrollbar-track { background: #0D1117; }
          ::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
          textarea:focus, input:focus { outline: none; }
          .chip:hover { background: #1E293B !important; cursor: pointer; }
        `}</style>

        <div style={{ maxWidth: "680px", width: "100%", animation: "fadeUp 0.5s ease" }}>
          {/* Logo */}
          <div style={{ marginBottom: "40px", textAlign: "center" }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
              <div style={{ width: "36px", height: "36px", background: "linear-gradient(135deg, #4F46E5, #06B6D4)", borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px" }}>◈</div>
              <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "22px", fontWeight: 700, letterSpacing: "-0.03em" }}>DataSpeak</span>
            </div>
            <div style={{ marginTop: "12px", color: "#94A3B8", fontSize: "15px" }}>Connect your database. Ask questions in English. Get answers in English.</div>
          </div>

          {/* Schema name */}
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>Database name</label>
            <input
              value={schemaName}
              onChange={e => setSchemaName(e.target.value)}
              placeholder="e.g. Laetiva Marketplace DB"
              style={{ width: "100%", background: "#0F172A", border: "1px solid #1E293B", borderRadius: "10px", padding: "12px 16px", color: "#F8FAFC", fontSize: "14px", fontFamily: "inherit" }}
            />
          </div>

          {/* Schema input */}
          <div style={{ marginBottom: "20px" }}>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>
              Paste your schema (CREATE TABLE statements)
            </label>
            <textarea
              value={schema}
              onChange={e => setSchema(e.target.value)}
              rows={14}
              style={{ width: "100%", background: "#0F172A", border: "1px solid #1E293B", borderRadius: "10px", padding: "16px", color: "#94A3B8", fontSize: "12.5px", fontFamily: "monospace", lineHeight: "1.7", resize: "vertical", borderColor: schema.length > 10 ? "#4F46E530" : "#1E293B", transition: "border-color 0.2s" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px" }}>
              <span style={{ fontSize: "12px", color: "#475569" }}>{schema.length > 10 ? "✓ Schema loaded" : "Paste your DDL above"}</span>
              <button onClick={() => setSchema(SAMPLE_SCHEMA)} style={{ fontSize: "12px", color: "#4F46E5", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Load sample schema</button>
            </div>
          </div>

          <button
            onClick={confirmSchema}
            disabled={schema.length < 20}
            style={{ width: "100%", padding: "14px", background: schema.length >= 20 ? "linear-gradient(135deg, #4F46E5, #06B6D4)" : "#1E293B", border: "none", borderRadius: "12px", color: schema.length >= 20 ? "#fff" : "#475569", fontSize: "15px", fontWeight: 600, cursor: schema.length >= 20 ? "pointer" : "not-allowed", fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "-0.01em", transition: "all 0.2s" }}>
            Analyse My Database →
          </button>
        </div>
      </div>
    );
  }

  // ── Chat screen ───────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#0D1117", color: "#F8FAFC", fontFamily: "'Inter', system-ui, sans-serif", display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');
        @keyframes beam { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes pulse { 0%,100% { opacity: 0.4 } 50% { opacity: 1 } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
        textarea:focus { outline: none; }
        .suggest-chip:hover { background: #1E293B !important; cursor: pointer; }
        .sql-block { background: #0F172A; border: 1px solid #1E293B; border-radius: 8px; padding: 12px 16px; font-family: monospace; font-size: 12px; color: #7DD3FC; line-height: 1.6; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
        .back-btn:hover { color: #F8FAFC !important; }
      `}</style>

      {/* Top bar */}
      <div style={{ padding: "12px 20px", borderBottom: "1px solid #1E293B", display: "flex", alignItems: "center", gap: "12px", background: "#0D1117", position: "sticky", top: 0, zIndex: 10 }}>
        <button className="back-btn" onClick={() => setView("setup")} style={{ background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: "14px", padding: "4px 8px", borderRadius: "6px", transition: "color 0.15s" }}>← Back</button>
        <div style={{ width: "1px", height: "20px", background: "#1E293B" }} />
        <div style={{ width: "28px", height: "28px", background: "linear-gradient(135deg, #4F46E5, #06B6D4)", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", flexShrink: 0 }}>◈</div>
        <div>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: "14px", letterSpacing: "-0.02em" }}>DataSpeak</div>
          <div style={{ fontSize: "11px", color: "#64748B" }}>{schemaName} · {parsedSchema?.length} table{parsedSchema?.length !== 1 ? "s" : ""}</div>
        </div>
        {/* Schema pills */}
        <div style={{ marginLeft: "auto", display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {parsedSchema?.map(t => (
            <span key={t.name} style={{ fontSize: "11px", background: "#0F172A", border: "1px solid #1E293B", borderRadius: "20px", padding: "3px 10px", color: "#94A3B8" }}>{t.name}</span>
          ))}
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: "20px", maxWidth: "820px", width: "100%", margin: "0 auto" }}>

        {messages.map((msg, i) => {
          if (msg.role === "user") {
            return (
              <div key={i} style={{ display: "flex", justifyContent: "flex-end", animation: "fadeUp 0.3s ease" }}>
                <div style={{ background: "#4F46E5", borderRadius: "16px 16px 4px 16px", padding: "12px 18px", maxWidth: "75%", fontSize: "14px", lineHeight: "1.5", fontWeight: 500 }}>
                  {msg.text}
                </div>
              </div>
            );
          }

          if (msg.type === "welcome") {
            return (
              <div key={i} style={{ animation: "fadeUp 0.4s ease" }}>
                <div style={{ background: "#0F172A", border: "1px solid #1E293B", borderRadius: "16px 16px 16px 4px", padding: "16px 20px", fontSize: "14px", lineHeight: "1.6", color: "#CBD5E1" }}
                  dangerouslySetInnerHTML={{ __html: msg.text.replace(/\*\*(\w+)\*\*/g, '<strong style="color:#F8FAFC">$1</strong>') }} />

                {/* Suggestion chips */}
                <div style={{ marginTop: "16px" }}>
                  <div style={{ fontSize: "11px", color: "#475569", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Try asking</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {SAMPLE_QUESTIONS.slice(0, 4).map((q, qi) => (
                      <button key={qi} className="suggest-chip" onClick={() => ask(q)}
                        style={{ background: "#0F172A", border: "1px solid #1E293B", borderRadius: "20px", padding: "7px 14px", color: "#94A3B8", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", transition: "background 0.15s" }}>
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          }

          if (msg.type === "result") {
            return (
              <div key={i} style={{ animation: "fadeUp 0.4s ease" }}>
                <div style={{ background: "#0F172A", border: "1px solid #1E293B", borderRadius: "16px 16px 16px 4px", overflow: "hidden" }}>
                  {/* Headline */}
                  <div style={{ padding: "16px 20px 0" }}>
                    <div style={{ fontSize: "11px", color: "#4F46E5", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>Insight</div>
                    <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "18px", fontWeight: 700, color: "#F8FAFC", letterSpacing: "-0.02em", lineHeight: 1.3, marginBottom: "12px" }}>{msg.headline}</div>
                    {/* Narrative */}
                    <p style={{ fontSize: "14px", color: "#94A3B8", lineHeight: "1.7", margin: "0 0 16px" }}>{msg.narrative}</p>
                  </div>

                  {/* Chart/table */}
                  {msg.data && msg.data.length > 0 && (
                    <div style={{ padding: "0 20px 16px" }}>
                      <SmartChart data={msg.data} chartType={msg.chartType} />
                    </div>
                  )}

                  {/* SQL toggle */}
                  <details style={{ borderTop: "1px solid #1E293B" }}>
                    <summary style={{ padding: "10px 20px", fontSize: "12px", color: "#475569", cursor: "pointer", userSelect: "none", listStyle: "none", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span style={{ color: "#4F46E5" }}>{ }</span> View generated SQL
                    </summary>
                    <div style={{ padding: "0 20px 16px" }}>
                      <div className="sql-block">{msg.sql}</div>
                    </div>
                  </details>
                </div>
              </div>
            );
          }

          if (msg.type === "error") {
            return (
              <div key={i} style={{ animation: "fadeUp 0.3s ease" }}>
                <div style={{ background: "#1A0A0A", border: "1px solid #7F1D1D40", borderRadius: "12px", padding: "14px 18px", color: "#FCA5A5", fontSize: "14px" }}>{msg.text}</div>
              </div>
            );
          }

          return null;
        })}

        {/* Loading state */}
        {loading && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <div style={{ background: "#0F172A", border: "1px solid #1E293B", borderRadius: "16px 16px 16px 4px", padding: "16px 20px" }}>
              <TranslationBeam active={true} />
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "10px" }}>
                {[0, 1, 2].map(d => (
                  <div key={d} style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#4F46E5", animation: `pulse 1.2s ${d * 0.2}s infinite` }} />
                ))}
                <span style={{ fontSize: "13px", color: "#64748B" }}>Translating your question to SQL and interpreting results…</span>
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div style={{ padding: "16px 20px", borderTop: "1px solid #1E293B", background: "#0D1117", position: "sticky", bottom: 0 }}>
        <div style={{ maxWidth: "820px", margin: "0 auto", display: "flex", gap: "10px", alignItems: "flex-end" }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input); } }}
            placeholder="Ask anything about your data in plain English…"
            rows={1}
            style={{ flex: 1, background: "#0F172A", border: "1px solid #1E293B", borderRadius: "12px", padding: "13px 16px", color: "#F8FAFC", fontSize: "14px", fontFamily: "inherit", resize: "none", lineHeight: "1.5", maxHeight: "120px", overflow: "auto", borderColor: input.length > 0 ? "#4F46E540" : "#1E293B", transition: "border-color 0.2s" }}
          />
          <button
            onClick={() => ask(input)}
            disabled={!input.trim() || loading}
            style={{ width: "44px", height: "44px", borderRadius: "12px", background: input.trim() && !loading ? "linear-gradient(135deg, #4F46E5, #06B6D4)" : "#1E293B", border: "none", color: input.trim() && !loading ? "#fff" : "#475569", cursor: input.trim() && !loading ? "pointer" : "not-allowed", fontSize: "18px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.2s" }}>
            ↑
          </button>
        </div>
        <div style={{ maxWidth: "820px", margin: "8px auto 0", textAlign: "center", fontSize: "11px", color: "#334155" }}>
          DataSpeak generates SQL and interprets results — always verify against your actual database
        </div>
      </div>
    </div>
  );
}
