import { useEffect, useRef, useState } from "react";
import axios from "axios";

// ── types ─────────────────────────────────────────────────────────────────────

type HistoryItem = {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
  headerRows: HeaderRow[];
  status: number;
  time: number;
};

// Compare history stores a PAIR of requests (A + B), saved only when both have been sent
type CompareHistoryItem = {
  id: string;
  a: HistoryItem;
  b: HistoryItem;
  timestamp: number;
};

type ResponseData = {
  ok: boolean;
  status: number;
  data: any;
  time: number;
} | null;

type HeaderRow = { key: string; value: string; enabled: boolean };
type DiffMap = Record<string, "changed" | "added" | "removed" | "same">;

// ── dedup helpers ─────────────────────────────────────────────────────────────

function isSameRequest(a: HistoryItem, b: HistoryItem): boolean {
  return (
    a.method === b.method &&
    a.url === b.url &&
    (a.body ?? "{}") === (b.body ?? "{}") &&
    JSON.stringify(a.headers) === JSON.stringify(b.headers)
  );
}

function isSameComparePair(a: CompareHistoryItem, b: CompareHistoryItem): boolean {
  return isSameRequest(a.a, b.a) && isSameRequest(a.b, b.b);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function parseData(raw: any): any {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

function methodColor(m: string) {
  const map: Record<string, string> = {
    GET: "#38bdf8", POST: "#4ade80", PUT: "#fb923c",
    DELETE: "#f87171", PATCH: "#c084fc",
  };
  return map[m] ?? "#94a3b8";
}

function flattenJson(obj: any, prefix = ""): Record<string, any> {
  const result: Record<string, any> = {};
  if (typeof obj !== "object" || obj === null) {
    result[prefix] = obj;
    return result;
  }
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const val = obj[key];
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      Object.assign(result, flattenJson(val, fullKey));
    } else {
      result[fullKey] = val;
    }
  }
  return result;
}

function buildDiffMaps(left: any, right: any): { leftMap: DiffMap; rightMap: DiffMap } {
  const flatLeft = flattenJson(left ?? {});
  const flatRight = flattenJson(right ?? {});
  const allKeys = new Set([...Object.keys(flatLeft), ...Object.keys(flatRight)]);
  const leftMap: DiffMap = {};
  const rightMap: DiffMap = {};

  for (const key of allKeys) {
    const inL = key in flatLeft;
    const inR = key in flatRight;
    if (inL && inR) {
      const status = JSON.stringify(flatLeft[key]) === JSON.stringify(flatRight[key]) ? "same" : "changed";
      leftMap[key] = status;
      rightMap[key] = status;
    } else if (inL) {
      leftMap[key] = "removed";
    } else {
      rightMap[key] = "added";
    }
  }
  return { leftMap, rightMap };
}

function syntaxHighlight(text: string) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+\.?\d*([eE][+-]?\d+)?)/g,
      (match) => {
        if (/^"/.test(match)) {
          if (/:$/.test(match)) return `<span style="color:#38bdf8">${match}</span>`;
          return `<span style="color:#4ade80">${match}</span>`;
        }
        if (/true|false/.test(match)) return `<span style="color:#f472b6">${match}</span>`;
        if (/null/.test(match)) return `<span style="color:#94a3b8">${match}</span>`;
        return `<span style="color:#fb923c">${match}</span>`;
      }
    );
}

// ── InlineDiffViewer ──────────────────────────────────────────────────────────

function InlineDiffViewer({ data, diffMap, dark, otherHasData }: {
  data: any; diffMap: DiffMap; dark: boolean; otherHasData: boolean;
}) {
  const [copied, setCopied] = useState(false);
  let parsed = data;
  if (typeof data === "string") { try { parsed = JSON.parse(data); } catch {} }

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(parsed, null, 2));
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  const diffStyle: Record<string, { bg: string; border: string; glyph: string; glyphColor: string }> = {
    changed: { bg: dark ? "rgba(234,179,8,0.15)" : "rgba(234,179,8,0.12)", border: "#eab308", glyph: "~", glyphColor: "#fbbf24" },
    removed: { bg: dark ? "rgba(239,68,68,0.18)" : "rgba(239,68,68,0.10)", border: "#ef4444", glyph: "−", glyphColor: "#f87171" },
    added:   { bg: dark ? "rgba(34,197,94,0.18)"  : "rgba(34,197,94,0.10)",  border: "#22c55e", glyph: "+", glyphColor: "#4ade80" },
  };

  const jsonText = JSON.stringify(parsed, null, 2);
  const lines = jsonText.split("\n");
  const pathStack: string[] = [];
  const lineMetadata: Array<{ diffType: string | null }> = [];

  for (const line of lines) {
    const keyMatch = line.match(/^(\s*)"([^"]+)":\s*(.*)/);
    if (keyMatch) {
      const indent = keyMatch[1]; const key = keyMatch[2]; const rest = keyMatch[3].trim();
      const depth = Math.floor(indent.length / 2);
      pathStack.splice(depth); pathStack[depth] = key;
      const flatKey = pathStack.slice(0, depth + 1).join(".").replace(/^\./, "");
      const isContainer = rest === "{" || rest === "[" || rest === "{," || rest === "[,";
      if (!isContainer && diffMap[flatKey] && diffMap[flatKey] !== "same") {
        lineMetadata.push({ diffType: diffMap[flatKey] });
      } else { lineMetadata.push({ diffType: null }); }
    } else { lineMetadata.push({ diffType: null }); }
  }

  const diffCount = Object.values(diffMap).filter(v => v !== "same").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, height: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 10 }}>
          {otherHasData
            ? diffCount === 0
              ? <span style={{ color: "#4ade80" }}>✓ Identical</span>
              : <span style={{ color: "#fbbf24" }}>{diffCount} difference{diffCount !== 1 ? "s" : ""}</span>
            : <span style={{ color: "#475569" }}>—</span>}
        </span>
        <button onClick={handleCopy} style={{
          padding: "3px 10px", borderRadius: 6,
          border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
          background: dark ? "#1e293b" : "#f8fafc",
          color: copied ? "#4ade80" : dark ? "#94a3b8" : "#475569",
          fontSize: 11, cursor: "pointer", fontFamily: "monospace",
        }}>{copied ? "✓ Copied!" : "Copy JSON"}</button>
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        <pre style={{
          margin: 0, fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: 12, lineHeight: 1.8, color: dark ? "#e2e8f0" : "#1e293b",
          whiteSpace: "pre", textAlign: "left",
        }}>
          {lines.map((line, i) => {
            const meta = lineMetadata[i];
            const ds = meta.diffType ? diffStyle[meta.diffType] : null;
            return (
              <div key={i} style={{
                display: "flex", alignItems: "flex-start",
                background: ds ? ds.bg : "transparent",
                borderLeft: ds ? `3px solid ${ds.border}` : "3px solid transparent",
                borderRadius: 3,
              }}>
                <span style={{
                  display: "inline-block", width: 16, flexShrink: 0,
                  fontSize: 10, lineHeight: "1.8em",
                  color: ds ? ds.glyphColor : "transparent",
                  fontWeight: 700, userSelect: "none", textAlign: "center",
                }}>{ds ? ds.glyph : " "}</span>
                <span dangerouslySetInnerHTML={{ __html: syntaxHighlight(line) }} />
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

// ── JsonViewer ────────────────────────────────────────────────────────────────

function JsonViewer({ data, dark }: { data: any; dark: boolean }) {
  const [copied, setCopied] = useState(false);
  let parsed = data;
  if (typeof data === "string") { try { parsed = JSON.parse(data); } catch {} }

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(parsed, null, 2));
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, height: "100%" }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={handleCopy} style={{
          padding: "3px 10px", borderRadius: 6,
          border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
          background: dark ? "#1e293b" : "#f8fafc",
          color: copied ? "#4ade80" : dark ? "#94a3b8" : "#475569",
          fontSize: 11, cursor: "pointer", fontFamily: "monospace",
        }}>{copied ? "✓ Copied!" : "Copy JSON"}</button>
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        <pre style={{
          margin: 0, fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: 12, lineHeight: 1.7, color: dark ? "#e2e8f0" : "#1e293b",
          whiteSpace: "pre", textAlign: "left",
        }} dangerouslySetInnerHTML={{ __html: syntaxHighlight(JSON.stringify(parsed, null, 2)) }} />
      </div>
    </div>
  );
}

// ── HeadersEditor ─────────────────────────────────────────────────────────────

function HeadersEditor({ headers, onChange, dark }: {
  headers: HeaderRow[]; onChange: (h: HeaderRow[]) => void; dark: boolean;
}) {
  const addRow = () => onChange([...headers, { key: "", value: "", enabled: true }]);
  const updateRow = (i: number, patch: Partial<HeaderRow>) =>
    onChange(headers.map((h, idx) => idx === i ? { ...h, ...patch } : h));
  const removeRow = (i: number) => onChange(headers.filter((_, idx) => idx !== i));

  const inputStyle = {
    flex: 1, padding: "4px 8px", borderRadius: 6, fontSize: 11,
    border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
    background: dark ? "#0f172a" : "#f8fafc",
    color: dark ? "#e2e8f0" : "#0f172a",
    fontFamily: "monospace", outline: "none",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {headers.map((h, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={h.enabled}
            onChange={e => updateRow(i, { enabled: e.target.checked })}
            style={{ accentColor: "#38bdf8", cursor: "pointer" }} />
          <input value={h.key} onChange={e => updateRow(i, { key: e.target.value })}
            placeholder="Key" style={{ ...inputStyle, opacity: h.enabled ? 1 : 0.4 }} />
          <input value={h.value} onChange={e => updateRow(i, { value: e.target.value })}
            placeholder="Value" style={{ ...inputStyle, opacity: h.enabled ? 1 : 0.4 }} />
          <button onClick={() => removeRow(i)} style={{
            padding: "3px 7px", borderRadius: 6, border: "none",
            background: "#ef444420", color: "#f87171", fontSize: 13, cursor: "pointer",
          }}>×</button>
        </div>
      ))}
      <button onClick={addRow} style={{
        alignSelf: "flex-start", marginTop: 2, padding: "3px 10px", borderRadius: 6,
        border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
        background: "transparent", color: "#38bdf8", fontSize: 11, cursor: "pointer",
      }}>+ Add Header</button>
    </div>
  );
}

// ── RequestPanel (Compare mode) ───────────────────────────────────────────────

type RequestPanelRef = {
  populate: (item: HistoryItem) => void;
  getLastSent: () => HistoryItem | null;
};

const RequestPanel = ({ dark, label, onResponse, diffMap, otherHasData }: {
  dark: boolean;
  label: string;
  onResponse: (r: ResponseData, item: HistoryItem) => void;
  diffMap: DiffMap;
  otherHasData: boolean;
}, ref: React.Ref<RequestPanelRef>) => {
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [body, setBody] = useState("{}");
  const [loading, setLoading] = useState(false);
  const [headers, setHeaders] = useState<HeaderRow[]>([
    { key: "Content-Type", value: "application/json", enabled: true },
  ]);
  const [showHeaders, setShowHeaders] = useState(false);
  const [response, setResponse] = useState<ResponseData>(null);

  // Expose populate method via ref
  (ref as any).current = {
    populate: (item: HistoryItem) => {
      setMethod(item.method);
      setUrl(item.url);
      setBody(item.body || "{}");
      if (item.headerRows && item.headerRows.length > 0) setHeaders(item.headerRows);
    },
    getLastSent: () => null,
  };

  const enabledHeaders = headers
    .filter(h => h.enabled && h.key.trim())
    .reduce((acc, h) => ({ ...acc, [h.key.trim()]: h.value }), {} as Record<string, string>);

  const sendRequest = async () => {
    if (!url) return;
    setLoading(true);
    const start = performance.now();
    try {
      const res = await axios({ method, url, headers: enabledHeaders, data: method !== "GET" ? JSON.parse(body || "{}") : undefined });
      const time = Math.round(performance.now() - start);
      const data = parseData(res.data);
      const r: ResponseData = { ok: true, status: res.status, data, time };
      const item: HistoryItem = { method, url, body, headers: enabledHeaders, headerRows: headers, status: res.status, time };
      setResponse(r);
      onResponse(r, item);
    } catch (err: any) {
      const time = Math.round(performance.now() - start);
      const r: ResponseData = { ok: false, status: err.response?.status ?? 500, data: parseData(err.response?.data ?? err.message), time };
      const item: HistoryItem = { method, url, body, headers: enabledHeaders, headerRows: headers, status: r.status, time };
      setResponse(r);
      onResponse(r, item);
    } finally { setLoading(false); }
  };

  const isEmpty = !response?.data ||
    (typeof response.data === "object" && !Array.isArray(response.data) && Object.keys(response.data).length === 0);
  const activeHeaders = headers.filter(h => h.enabled && h.key.trim()).length;
  const labelColor = label.includes("A") ? "#38bdf8" : "#c084fc";
  const hasDiff = Object.keys(diffMap).length > 0;

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column", gap: 8,
      padding: 12, minWidth: 0, borderRadius: 10,
      border: `1px solid ${dark ? "#1e293b" : "#e2e8f0"}`,
      background: dark ? "#0f1929" : "#f8fafc",
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: labelColor, letterSpacing: "0.1em", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <select value={method} onChange={e => setMethod(e.target.value)} style={{
          padding: "5px 8px", borderRadius: 7,
          border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
          background: dark ? "#1e293b" : "white",
          color: methodColor(method), fontWeight: 700, fontSize: 11, cursor: "pointer", outline: "none",
        }}>
          <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
        </select>
        <input value={url} onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.ctrlKey && e.key === "Enter" && sendRequest()}
          placeholder="https://api.example.com"
          style={{
            flex: 1, padding: "5px 8px", borderRadius: 7,
            border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
            background: dark ? "#1e293b" : "white",
            color: "inherit", fontSize: 11, outline: "none", fontFamily: "monospace",
          }}
        />
        <button onClick={sendRequest} disabled={loading || !url} style={{
          padding: "5px 12px", borderRadius: 7,
          background: loading ? "#166534" : "#22c55e",
          border: "none", color: "white", fontWeight: 600, fontSize: 11,
          cursor: (!url || loading) ? "not-allowed" : "pointer", opacity: !url ? 0.5 : 1,
        }}>{loading ? "…" : "Send"}</button>
      </div>

      <div>
        <button onClick={() => setShowHeaders(!showHeaders)} style={{
          padding: "2px 8px", borderRadius: 5, fontSize: 10,
          border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
          background: showHeaders ? "#38bdf81a" : "transparent",
          color: showHeaders ? "#38bdf8" : "#64748b", cursor: "pointer",
        }}>
          Headers {activeHeaders > 0 && `(${activeHeaders})`} {showHeaders ? "▲" : "▼"}
        </button>
        {showHeaders && <div style={{ marginTop: 6 }}><HeadersEditor headers={headers} onChange={setHeaders} dark={dark} /></div>}
      </div>

      {method !== "GET" && (
        <div>
          <label style={{ fontSize: 10, color: "#64748b", display: "block", marginBottom: 3 }}>Body (JSON)</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} spellCheck={false} style={{
            width: "100%", height: 60, borderRadius: 7, padding: "6px 8px",
            border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
            background: dark ? "#1e293b" : "white", color: "inherit",
            fontFamily: "monospace", fontSize: 11, resize: "vertical", outline: "none", boxSizing: "border-box",
          }} />
        </div>
      )}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {response ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 6,
                background: response.ok ? "#22c55e1a" : "#ef44441a",
                border: `1px solid ${response.ok ? "#22c55e40" : "#ef444440"}`,
              }}>
                <span style={{ color: response.ok ? "#22c55e" : "#ef4444", fontSize: 12 }}>{response.ok ? "✓" : "✕"}</span>
                <span style={{ color: response.ok ? "#22c55e" : "#ef4444", fontWeight: 600, fontSize: 12 }}>{response.status}</span>
              </div>
              <span style={{ color: "#64748b", fontSize: 11 }}>{response.time}ms</span>
            </div>
            <div style={{
              flex: 1,
              background: dark ? "#020617" : "#ffffff",
              borderRadius: 8,
              border: `1px solid ${hasDiff && otherHasData ? labelColor + "55" : dark ? "#1e293b" : "#e2e8f0"}`,
              padding: 10, overflow: "auto", minHeight: 80,
            }}>
              {isEmpty
                ? <div style={{ color: "#475569", fontSize: 11 }}>No response body</div>
                : otherHasData
                  ? <InlineDiffViewer data={response.data} diffMap={diffMap} dark={dark} otherHasData={otherHasData} />
                  : <JsonViewer data={response.data} dark={dark} />
              }
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#334155", fontSize: 11, minHeight: 60 }}>
            Send a request to see response
          </div>
        )}
      </div>
    </div>
  );
};

const RequestPanelWithRef = React.forwardRef(RequestPanel as any) as any;

// Need React import for forwardRef
import React from "react";

// ── main app ──────────────────────────────────────────────────────────────────

export default function App() {
  const [singleHistory, setSingleHistory] = useState<HistoryItem[]>([]);
  const [compareHistory, setCompareHistory] = useState<CompareHistoryItem[]>([]);
  const [dark, setDark] = useState(true);
  const [mode, setMode] = useState<"single" | "compare">("single");

  // Active history selection tracking
  const [activeSingleIndex, setActiveSingleIndex] = useState<number | null>(null);
  const [activeCompareId, setActiveCompareId] = useState<string | null>(null);

  // Single mode state
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [body, setBody] = useState("{}");
  const [headers, setHeaders] = useState<HeaderRow[]>([
    { key: "Content-Type", value: "application/json", enabled: true },
  ]);
  const [showHeaders, setShowHeaders] = useState(false);
  const [response, setResponse] = useState<ResponseData>(null);
  const [loading, setLoading] = useState(false);

  // Compare mode state
  const [leftResponse, setLeftResponse] = useState<ResponseData>(null);
  const [rightResponse, setRightResponse] = useState<ResponseData>(null);
  // Buffer: track the last sent items from each panel to save as a pair
  const leftLastSent = useRef<HistoryItem | null>(null);
  const rightLastSent = useRef<HistoryItem | null>(null);

  // Refs to imperative populate panels
  const leftPanelRef = useRef<RequestPanelRef | null>(null);
  const rightPanelRef = useRef<RequestPanelRef | null>(null);

  useEffect(() => {
    try {
      const sh = localStorage.getItem("singleHistory");
      if (sh) setSingleHistory(JSON.parse(sh));

      const ch = localStorage.getItem("compareHistory");
      if (ch) {
        const parsed = JSON.parse(ch);
        // Migrate: filter out old-format items (HistoryItem[]) that don't have .a and .b
        // Old format had { method, url, ... }, new format has { id, a, b, timestamp }
        const migrated = Array.isArray(parsed)
          ? parsed.filter((item: any) => item && item.a && item.b && item.a.method && item.b.method)
          : [];
        setCompareHistory(migrated);
        // If we filtered out stale data, clean up localStorage
        if (migrated.length !== parsed.length) {
          try { localStorage.setItem("compareHistory", JSON.stringify(migrated)); } catch {}
        }
      }
    } catch {
      // Corrupt data — clear both
      try { localStorage.removeItem("compareHistory"); } catch {}
    }
  }, []);

  // Single history helpers
  const saveSingleHistory = (item: HistoryItem) => {
    // Dedup: if identical request already exists, skip insert
    if (singleHistory.some(h => isSameRequest(h, item))) return;
    const next = [item, ...singleHistory].slice(0, 50);
    setSingleHistory(next);
    setActiveSingleIndex(0); // newly saved = top of list = active
    try { localStorage.setItem("singleHistory", JSON.stringify(next)); } catch {}
  };

  const deleteSingleHistory = (index: number) => {
    const next = singleHistory.filter((_, i) => i !== index);
    setSingleHistory(next);
    try { localStorage.setItem("singleHistory", JSON.stringify(next)); } catch {}
  };

  const clearSingleHistory = () => {
    setSingleHistory([]);
    try { localStorage.removeItem("singleHistory"); } catch {}
  };

  // Compare history helpers — saves a PAIR (both A+B must have been sent)
  const tryCommitCompareHistory = (
    newLeft: HistoryItem | null,
    newRight: HistoryItem | null
  ) => {
    const a = newLeft ?? leftLastSent.current;
    const b = newRight ?? rightLastSent.current;
    if (!a || !b) return; // not both sides sent yet

    const entry: CompareHistoryItem = {
      id: Date.now().toString(),
      a,
      b,
      timestamp: Date.now(),
    };
    setCompareHistory(prev => {
      // Dedup: if identical pair already exists, skip insert
      if (prev.some(p => isSameComparePair(p, entry))) return prev;
      const next = [entry, ...prev].slice(0, 30);
      try { localStorage.setItem("compareHistory", JSON.stringify(next)); } catch {}
      setActiveCompareId(entry.id); // newly saved = active
      return next;
    });
  };

  const deleteCompareHistory = (id: string) => {
    setCompareHistory(prev => {
      const next = prev.filter(h => h.id !== id);
      try { localStorage.setItem("compareHistory", JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const clearCompareHistory = () => {
    setCompareHistory([]);
    try { localStorage.removeItem("compareHistory"); } catch {}
  };

  // Callbacks from each compare panel
  const handleLeftResponse = (r: ResponseData, sent: HistoryItem) => {
    setLeftResponse(r);
    leftLastSent.current = sent;
    tryCommitCompareHistory(sent, null);
  };

  const handleRightResponse = (r: ResponseData, sent: HistoryItem) => {
    setRightResponse(r);
    rightLastSent.current = sent;
    tryCommitCompareHistory(null, sent);
  };

  // Single mode send
  const enabledHeaders = headers
    .filter(h => h.enabled && h.key.trim())
    .reduce((acc, h) => ({ ...acc, [h.key.trim()]: h.value }), {} as Record<string, string>);

  const sendRequest = async () => {
    if (!url) return;
    setLoading(true);
    const start = performance.now();
    try {
      const res = await axios({ method, url, headers: enabledHeaders, data: method !== "GET" ? JSON.parse(body || "{}") : undefined });
      const time = Math.round(performance.now() - start);
      const data = parseData(res.data);
      setResponse({ ok: true, status: res.status, data, time });
      saveSingleHistory({ method, url, body, headers: enabledHeaders, headerRows: headers, status: res.status, time });
    } catch (err: any) {
      const time = Math.round(performance.now() - start);
      setResponse({ ok: false, status: err.response?.status ?? 500, data: parseData(err.response?.data ?? err.message), time });
    } finally { setLoading(false); }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.ctrlKey && e.key === "Enter" && mode === "single") sendRequest(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const loadSingleHistory = (item: HistoryItem, index: number) => {
    setMethod(item.method);
    setUrl(item.url);
    setBody(item.body || "{}");
    if (item.headerRows && item.headerRows.length > 0) setHeaders(item.headerRows);
    setActiveSingleIndex(index);
  };

  // Load a compare pair into both panels
  const loadCompareHistory = (item: CompareHistoryItem) => {
    leftPanelRef.current?.populate(item.a);
    rightPanelRef.current?.populate(item.b);
    setActiveCompareId(item.id);
  };

  const isEmpty = !response?.data ||
    (typeof response.data === "object" && !Array.isArray(response.data) && Object.keys(response.data).length === 0);
  const activeHeaders = headers.filter(h => h.enabled && h.key.trim()).length;

  const { leftMap, rightMap } = (leftResponse && rightResponse)
    ? buildDiffMaps(leftResponse.data, rightResponse.data)
    : { leftMap: {} as DiffMap, rightMap: {} as DiffMap };

  const tabBtn = (active: boolean) => ({
    padding: "6px 16px", borderRadius: 8, fontSize: 13, cursor: "pointer",
    border: `1px solid ${active ? "#38bdf8" : dark ? "#334155" : "#e2e8f0"}`,
    background: active ? "#38bdf81a" : "transparent",
    color: active ? "#38bdf8" : "#64748b",
    fontWeight: active ? 600 : 400, transition: "all 0.15s",
  });

  // ── History Panel ────────────────────────────────────────────────────────────

  const singleHistoryPanel = (
    <div style={{
      width: 220, borderRight: `1px solid ${dark ? "#1e293b" : "#e2e8f0"}`,
      display: "flex", flexDirection: "column", flexShrink: 0,
    }}>
      <div style={{ padding: "14px 14px 6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#64748b" }}>
          Single History
        </span>
        {singleHistory.length > 0 && (
          <button onClick={clearSingleHistory} style={{
            padding: "2px 7px", borderRadius: 5, fontSize: 10,
            border: "1px solid #ef444430", background: "#ef444415",
            color: "#f87171", cursor: "pointer",
          }}>Clear</button>
        )}
      </div>
      <div style={{ padding: "0 8px 14px", flex: 1, overflowY: "auto" }}>
        {singleHistory.length === 0 && (
          <div style={{ color: "#475569", fontSize: 11, padding: "6px 4px" }}>No requests yet</div>
        )}
        {singleHistory.map((h, i) => {
          const isActive = activeSingleIndex === i;
          return (
          <div key={i} style={{ position: "relative", marginBottom: 5 }}>
            <div onClick={() => loadSingleHistory(h, i)} style={{
              padding: "8px 28px 8px 10px",
              background: isActive
                ? (dark ? "#1e3a5f" : "#e0f0ff")
                : (dark ? "#1e293b" : "white"),
              borderRadius: 7, cursor: "pointer", fontSize: 11,
              border: `1px solid ${isActive ? "#38bdf8" : (dark ? "#334155" : "#e2e8f0")}`,
              boxShadow: isActive ? "0 0 0 1px #38bdf830" : "none",
              transition: "all 0.12s",
            }}>
              {isActive && (
                <div style={{
                  position: "absolute", left: 0, top: 0, bottom: 0,
                  width: 3, borderRadius: "7px 0 0 7px",
                  background: "#38bdf8",
                }} />
              )}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                <span style={{ fontWeight: 700, fontSize: 10, color: methodColor(h.method) }}>{h.method}</span>
                <span style={{ color: h.status >= 400 ? "#f87171" : "#4ade80", fontSize: 10 }}>{h.status}</span>
              </div>
              <div style={{ color: dark ? "#94a3b8" : "#475569", wordBreak: "break-all", lineHeight: 1.4, marginBottom: 3, fontSize: 10 }}>{h.url}</div>
              <div style={{ color: "#64748b", fontSize: 10 }}>{h.time}ms</div>
            </div>
            {/* Delete single history item */}
            <button
              onClick={e => { e.stopPropagation(); deleteSingleHistory(i); if (activeSingleIndex === i) setActiveSingleIndex(null); }}
              title="Delete this entry"
              style={{
                position: "absolute", top: 6, right: 6,
                width: 18, height: 18,
                borderRadius: 4, border: "none",
                background: "transparent",
                color: "#64748b", fontSize: 12, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                lineHeight: 1,
              }}
              onMouseEnter={e => (e.currentTarget.style.color = "#f87171")}
              onMouseLeave={e => (e.currentTarget.style.color = "#64748b")}
            >×</button>
          </div>
          );
        })}
      </div>
    </div>
  );

  const compareHistoryPanel = (
    <div style={{
      width: 220, borderRight: `1px solid ${dark ? "#1e293b" : "#e2e8f0"}`,
      display: "flex", flexDirection: "column", flexShrink: 0,
    }}>
      <div style={{ padding: "14px 14px 6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#64748b" }}>
          Compare History
        </span>
        {compareHistory.length > 0 && (
          <button onClick={clearCompareHistory} style={{
            padding: "2px 7px", borderRadius: 5, fontSize: 10,
            border: "1px solid #ef444430", background: "#ef444415",
            color: "#f87171", cursor: "pointer",
          }}>Clear</button>
        )}
      </div>
      <div style={{ padding: "0 8px 14px", flex: 1, overflowY: "auto" }}>
        {compareHistory.length === 0 && (
          <div style={{ color: "#475569", fontSize: 11, padding: "6px 4px" }}>
            Send both A & B to save a pair
          </div>
        )}
        {compareHistory.filter(pair => pair?.a?.method && pair?.b?.method).map((pair) => {
          const isActive = activeCompareId === pair.id;
          return (
          <div key={pair.id} style={{ position: "relative", marginBottom: 5 }}>
            <div onClick={() => loadCompareHistory(pair)} style={{
              padding: "8px 28px 8px 10px",
              background: isActive
                ? (dark ? "#2d1f4e" : "#f3eeff")
                : (dark ? "#1e293b" : "white"),
              borderRadius: 7, cursor: "pointer", fontSize: 11,
              border: `1px solid ${isActive ? "#c084fc" : (dark ? "#334155" : "#e2e8f0")}`,
              boxShadow: isActive ? "0 0 0 1px #c084fc30" : "none",
              transition: "all 0.12s",
              position: "relative",
            }}>
              {isActive && (
                <div style={{
                  position: "absolute", left: 0, top: 0, bottom: 0,
                  width: 3, borderRadius: "7px 0 0 7px",
                  background: "linear-gradient(to bottom, #38bdf8, #c084fc)",
                }} />
              )}
              {/* Request A row */}
              <div style={{ marginBottom: 5, paddingBottom: 5, borderBottom: `1px solid ${dark ? "#334155" : "#e2e8f0"}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                  <span style={{ fontSize: 9, color: "#38bdf8", fontWeight: 700, letterSpacing: "0.05em" }}>A</span>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <span style={{ fontWeight: 700, fontSize: 9, color: methodColor(pair.a.method) }}>{pair.a.method}</span>
                    <span style={{ color: pair.a.status >= 400 ? "#f87171" : "#4ade80", fontSize: 9 }}>{pair.a.status}</span>
                  </div>
                </div>
                <div style={{ color: dark ? "#94a3b8" : "#475569", wordBreak: "break-all", fontSize: 9, lineHeight: 1.3 }}>{pair.a.url}</div>
              </div>
              {/* Request B row */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                  <span style={{ fontSize: 9, color: "#c084fc", fontWeight: 700, letterSpacing: "0.05em" }}>B</span>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <span style={{ fontWeight: 700, fontSize: 9, color: methodColor(pair.b.method) }}>{pair.b.method}</span>
                    <span style={{ color: pair.b.status >= 400 ? "#f87171" : "#4ade80", fontSize: 9 }}>{pair.b.status}</span>
                  </div>
                </div>
                <div style={{ color: dark ? "#94a3b8" : "#475569", wordBreak: "break-all", fontSize: 9, lineHeight: 1.3 }}>{pair.b.url}</div>
              </div>
              <div style={{ color: "#64748b", fontSize: 9, marginTop: 4 }}>
                {pair.a.time}ms / {pair.b.time}ms
              </div>
            </div>
            {/* Delete compare pair */}
            <button
              onClick={e => { e.stopPropagation(); deleteCompareHistory(pair.id); if (activeCompareId === pair.id) setActiveCompareId(null); }}
              title="Delete this pair"
              style={{
                position: "absolute", top: 6, right: 6,
                width: 18, height: 18,
                borderRadius: 4, border: "none",
                background: "transparent",
                color: "#64748b", fontSize: 12, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                lineHeight: 1,
              }}
              onMouseEnter={e => (e.currentTarget.style.color = "#f87171")}
              onMouseLeave={e => (e.currentTarget.style.color = "#64748b")}
            >×</button>
          </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div style={{
      display: "flex", height: "100vh",
      background: dark ? "#0f172a" : "#f1f5f9",
      color: dark ? "#e2e8f0" : "#0f172a",
      fontFamily: "Inter, ui-sans-serif",
    }}>
      {/* Sidebar: show appropriate history panel based on mode */}
      {mode === "single" ? singleHistoryPanel : compareHistoryPanel}

      {/* Main */}
      <div style={{ flex: 1, padding: 18, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* Top bar */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setMode("single")} style={tabBtn(mode === "single")}>Single</button>
            <button onClick={() => setMode("compare")} style={tabBtn(mode === "compare")}>⇄ Compare</button>
          </div>
          <button onClick={() => setDark(!dark)} style={{
            padding: "6px 14px", borderRadius: 8,
            background: dark ? "#1e293b" : "white",
            border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
            color: "inherit", fontSize: 13, cursor: "pointer",
          }}>
            {dark ? "☀ Light" : "☾ Dark"}
          </button>
        </div>

        {/* Single mode */}
        <div style={{ display: mode === "single" ? "flex" : "none", flex: 1, flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <select value={method} onChange={e => setMethod(e.target.value)} style={{
              padding: "8px 12px", borderRadius: 8,
              border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
              background: dark ? "#1e293b" : "white",
              color: methodColor(method), fontWeight: 700, fontSize: 13, cursor: "pointer", outline: "none",
            }}>
              <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
            </select>
            <input value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://api.example.com/endpoint"
              style={{
                flex: 1, padding: "8px 12px", borderRadius: 8,
                border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
                background: dark ? "#1e293b" : "white",
                color: "inherit", fontSize: 13, outline: "none", fontFamily: "monospace",
              }}
            />
            <button onClick={sendRequest} disabled={loading || !url} style={{
              padding: "8px 20px", borderRadius: 8,
              background: loading ? "#166534" : "#22c55e",
              border: "none", color: "white", fontWeight: 600, fontSize: 13,
              cursor: (loading || !url) ? "not-allowed" : "pointer", opacity: !url ? 0.5 : 1,
            }}>{loading ? "Sending…" : "Send"}</button>
          </div>

          <div style={{ marginBottom: 10 }}>
            <button onClick={() => setShowHeaders(!showHeaders)} style={{
              padding: "4px 12px", borderRadius: 6, fontSize: 12,
              border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
              background: showHeaders ? "#38bdf81a" : "transparent",
              color: showHeaders ? "#38bdf8" : "#64748b", cursor: "pointer",
            }}>
              Headers {activeHeaders > 0 && `(${activeHeaders})`} {showHeaders ? "▲" : "▼"}
            </button>
            {showHeaders && <div style={{ marginTop: 8 }}><HeadersEditor headers={headers} onChange={setHeaders} dark={dark} /></div>}
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#64748b", display: "block", marginBottom: 6 }}>
              Body (JSON)
            </label>
            <textarea value={body} onChange={e => setBody(e.target.value)} spellCheck={false} style={{
              width: "100%", height: 100, borderRadius: 8, padding: "10px 12px",
              border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
              background: dark ? "#1e293b" : "white", color: "inherit",
              fontFamily: "monospace", fontSize: 13,
              resize: "vertical", outline: "none", boxSizing: "border-box",
            }} />
          </div>

          {response ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "5px 14px", borderRadius: 8,
                  background: response.ok ? "#22c55e1a" : "#ef44441a",
                  border: `1px solid ${response.ok ? "#22c55e40" : "#ef444440"}`,
                }}>
                  <span style={{ color: response.ok ? "#22c55e" : "#ef4444", fontSize: 15 }}>{response.ok ? "✓" : "✕"}</span>
                  <span style={{ color: response.ok ? "#22c55e" : "#ef4444", fontWeight: 600, fontSize: 15 }}>{response.status}</span>
                </div>
                <span style={{ color: "#64748b", fontSize: 13 }}>{response.time}ms</span>
              </div>
              <div style={{
                flex: 1, background: dark ? "#020617" : "#ffffff",
                borderRadius: 10, border: `1px solid ${dark ? "#1e293b" : "#e2e8f0"}`,
                padding: 16, overflow: "auto", minHeight: 0,
              }}>
                {isEmpty
                  ? <div style={{ color: "#475569", fontSize: 13 }}>No response body</div>
                  : <JsonViewer data={response.data} dark={dark} />
                }
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#334155", fontSize: 13, flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 32, opacity: 0.3 }}>⌁</div>
              <div>Send a request to see the response</div>
              <div style={{ fontSize: 11, color: "#475569" }}>Ctrl + Enter to send</div>
            </div>
          )}
        </div>

        {/* Compare mode — always mounted */}
        <div style={{ display: mode === "compare" ? "flex" : "none", flex: 1, gap: 12, overflow: "hidden", minHeight: 0 }}>
          <RequestPanelWithRef
            ref={leftPanelRef}
            dark={dark}
            label="Request A"
            onResponse={handleLeftResponse}
            diffMap={leftMap}
            otherHasData={!!rightResponse}
          />
          <RequestPanelWithRef
            ref={rightPanelRef}
            dark={dark}
            label="Request B"
            onResponse={handleRightResponse}
            diffMap={rightMap}
            otherHasData={!!leftResponse}
          />
        </div>
      </div>
    </div>
  );
}