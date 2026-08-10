import { useState, useMemo, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
} from "recharts";

// ─────────────────────────────────────────────────────────────────────────────
// PARSING UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();
}

const EMPTY_RE = /^(n\/a|na|none|ninguno|ninguna|no\s+info|no\s+information|sin\s+info|sin\s+información|desconocido|unknown|—|–|-|\.+|,+|x+|0+|no\s+aplica|not\s+applicable|not\s+available|nd|s\/i|s\.i\.|vacío|empty)$/i;
function isEmpty(v) {
  if (!v) return true;
  const s = v.trim().replace(/\s+/g," ");
  return !s || EMPTY_RE.test(s) || /^[\s\W_]+$/.test(s);
}
function norm(val) {
  if (!val) return "";
  const v = val.trim().replace(/\s+/g," ");
  if (isEmpty(v)) return "";
  return v.charAt(0).toUpperCase() + v.slice(1);
}
function normTicket(val) {
  if (!val || isEmpty(val)) return "unknown";
  const v = val.trim().toLowerCase();
  if (/^(yes|si|sí|y|true|1|oui)/.test(v)) return "yes";
  if (/^(no|n|false|0)/.test(v)) return "no";
  return "unknown";
}

// Minimum chars for a field to be meaningful (filters "-", "N", stray chars)
const MIN_FIELD_LEN = 3;
function normField(val) {
  const v = norm(val);
  if (!v || v.length < MIN_FIELD_LEN) return "";
  return v;
}
// App-specific normaliser: also strips " note: ..." suffix some agents append
// e.g. "Accounting note: Customer had an issue..." → "Accounting"
function normAppField(val) {
  if (!val) return "";
  const stripped = val.replace(/\s+note\s*:.*$/i, "").trim();
  return normField(stripped);
}

// Canonical app alias map — normalises variants to a standard English name.
// Applied before fuzzy clustering so Conta / Contabilidad / Accounting all merge.
const APP_ALIASES = [
  { canonical: "Accounting",    variants: /^(conta(bilidad|bilitat|b)?|contab|accounting|accountant|cuentas?|finanzas?|financ(e|ial)?)$/i },
  { canonical: "Invoicing",     variants: /^(invoic(ing|es?)?|facturaci[oó]n|facturas?)$/i },
  { canonical: "Inventory",     variants: /^(inventor(y|io)|inventario|almac[eé]n|warehouse|stock)$/i },
  { canonical: "Sales",         variants: /^(sales?|ventas?|crm|pedidos?)$/i },
  { canonical: "Purchase",      variants: /^(purchas(e|ing)?|compras?|proveedores?)$/i },
  { canonical: "Payroll",       variants: /^(payroll|n[oó]minas?|nomina)$/i },
  { canonical: "Manufacturing", variants: /^(manufactur(ing|a)?|producci[oó]n|mrp)$/i },
  { canonical: "HR",            variants: /^(hr|human\s+resources?|recursos\s+humanos?|empleados?)$/i },
  { canonical: "Website",       variants: /^(web(site)?|sitio\s+web|ecommerce|e-commerce|tienda)$/i },
  { canonical: "Helpdesk",      variants: /^(helpdesk|help\s+desk|soporte|tickets?)$/i },
  // Added after comparing against a real Odoo Live Chat export — these appeared
  // frequently as raw app values but had no canonical entry, so they were only
  // being merged by fuzzy clustering instead of deterministically.
  { canonical: "Admin",         variants: /^(admin|administraci[oó]n|administrator(s)?|administrative)$/i },
  { canonical: "POS",           variants: /^(pos|point\s+of\s+sale|tpv|punto\s+de\s+venta)$/i },
  { canonical: "Subscription",  variants: /^(subscriptions?|suscripci[oó]n(es)?)$/i },
  { canonical: "Sign",          variants: /^(sign|e-?sign|firma(s)?|firma\s+electr[oó]nica)$/i },
  { canonical: "Studio",        variants: /^studio$/i },
  { canonical: "Knowledge",     variants: /^(knowledge|conocimiento)$/i },
  { canonical: "Appointments",  variants: /^(appointments?|citas?)$/i },
  { canonical: "Marketing",     variants: /^(mail(ing)?|marketing|email\s+marketing|newsletter|correos?)$/i },
  { canonical: "Bank Sync",     variants: /^(bank\s*sync(hronization)?|sincronizaci[oó]n\s+bancaria|conciliaci[oó]n\s+bancaria)$/i },
  { canonical: "Product Flow",  variants: /^(product\s*flow|flujo\s+de\s+producto)$/i },
  { canonical: "Presales",      variants: /^(pre-?sales|preventas?|pre-?venta)$/i },
  { canonical: "API",           variants: /^(api|integraci[oó]n(es)?|integrations?|webhooks?|rpc)$/i },
];
function canonicalApp(raw) {
  if (!raw) return raw;
  const t = raw.trim();
  for (const { canonical, variants } of APP_ALIASES) {
    if (variants.test(t)) return canonical;
  }
  return t;
}

// Every field label the parser recognizes, across all note formats/dialects.
// Used as a shared "stop here" boundary in every capture in parseNote below.
// Without a SHARED boundary, a capture whose own expected next label doesn't
// appear (e.g. a note using bare "Ticket:" where "ticket_needed:" was
// expected, or one using "Action taken:" which no single format anticipates)
// swallows all remaining text — including the next field's label itself.
// stripHtml turns "<br>" into a space rather than a newline, so within a
// single note there are no real line breaks left to bound matches naturally.
const FIELD_LABEL = "(?:apps?|issues?|ticket[_\\s]needed|ticket|m[oó]dulo|problema|module|problem|action\\s*taken|resolved|se\\s*solucion[oó])\\s*[:：]";
const fieldBoundary = `(?=\\s*${FIELD_LABEL}|$)`;

function parseNote(raw, meta) {
  if (!raw || !raw.trim()) return null;
  const text = stripHtml(raw);

  // Hybrid: some agents mix "module:"/"módulo:" (the app label from the old
  // ES/EN formats) with "issue:" (the new-format label) instead of
  // "problem:"/"problema:" — found in a real Odoo Live Chat export. Must run
  // BEFORE the "new" format check below: that check's issue-only fallback
  // would otherwise match on "issue:" alone and silently drop the module
  // value entirely, since it has no "app:"/"apps:" label to look for.
  // Gated on problema/problem being ABSENT so well-formed old_es/old_en notes
  // are left untouched and handled by their own checks further down.
  const hasProblemLabel = /\bproblema\s*[:：]|\bproblem\s*[:：]/i.test(text);
  const hybridMod   = text.match(new RegExp(`\\b(?:m[oó]dulo|module)\\s*[:：]\\s*([^\\n|]*?)${fieldBoundary}`, "i"));
  const hybridIssue = !hasProblemLabel
    ? text.match(new RegExp(`\\bissues?\\s*[:：]\\s*([^\\n|]*?)${fieldBoundary}`, "i"))
    : null;
  const hybridTkt    = text.match(/\bticket(?:[_\s]needed)?\s*[:：]\s*([^\n|]*)/i);
  const hybridModVal   = normAppField(hybridMod?.[1]);
  const hybridIssueVal = normField(hybridIssue?.[1]);
  if (hybridMod && hybridIssue && (hybridModVal || hybridIssueVal))
    return { format:"hybrid", app:hybridModVal, issue:hybridIssueVal, ticket_needed:normTicket(hybridTkt?.[1]), raw_note:text, ...meta };

  // New format: app/apps + issue/issues + ticket_needed
  // apps? and issues? accept both singular and plural variants
  // \b word boundaries stop "UnablePrintTicket" from matching
  const appM   = text.match(new RegExp(`\\bapps?\\s*[:：]\\s*([^\\n|]*?)${fieldBoundary}`, "i"));
  const issueM = text.match(new RegExp(`\\bissues?\\s*[:：]\\s*([^\\n|]*?)${fieldBoundary}`, "i"));
  const tktM   = text.match(/\bticket[_\s]needed\s*[:：]\s*([^\n|]*)/i);
  const appVal   = normAppField(appM?.[1]);
  const issueVal = normField(issueM?.[1]);
  if ((appM || issueM) && (appVal || issueVal))
    return { format:"new", app:appVal, issue:issueVal, ticket_needed:normTicket(tktM?.[1]), raw_note:text, ...meta };

  // Old Spanish: Módulo / Problema / Ticket
  const modM  = text.match(new RegExp(`\\b[Mm][oó]dulo\\s*[:：]\\s*([^\\n]*?)${fieldBoundary}`, "i"));
  const probM = text.match(new RegExp(`\\b[Pp]roblema\\s*[:：]\\s*([^\\n]*?)${fieldBoundary}`, "i"));
  const tktSp = text.match(/\b[Tt]icket\s*[:：]\s*([^\n]*)/i);
  const modVal  = normAppField(modM?.[1]);
  const probVal = normField(probM?.[1]);
  if ((modM || probM) && (modVal || probVal))
    return { format:"old_es", app:modVal, issue:probVal, ticket_needed:normTicket(tktSp?.[1]), raw_note:text, ...meta };

  // Old English: Module / Problem / Ticket
  const modEn  = text.match(new RegExp(`\\b[Mm]odule\\s*[:：]\\s*([^\\n]*?)${fieldBoundary}`, "i"));
  const probEn = text.match(new RegExp(`\\b[Pp]roblem\\s*[:：]\\s*([^\\n]*?)${fieldBoundary}`, "i"));
  const tktEn  = text.match(/\b[Tt]icket\s*[:：]\s*([^\n]*)/i);
  const modEnVal  = normAppField(modEn?.[1]);
  const probEnVal = normField(probEn?.[1]);
  if ((modEn || probEn) && (modEnVal || probEnVal))
    return { format:"old_en", app:modEnVal, issue:probEnVal, ticket_needed:normTicket(tktEn?.[1]), raw_note:text, ...meta };

  return { format:"unstructured", app:null, issue:null, ticket_needed:null, raw_note:text, ...meta };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUZZY CLUSTERING
// ─────────────────────────────────────────────────────────────────────────────
function jaroWinkler(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const dist = Math.max(Math.floor(Math.max(la,lb)/2)-1, 0);
  const am = new Array(la).fill(false), bm = new Array(lb).fill(false);
  let matches = 0, trans = 0;
  for (let i=0;i<la;i++){const lo=Math.max(0,i-dist),hi=Math.min(i+dist+1,lb);for(let j=lo;j<hi;j++){if(bm[j]||a[i]!==b[j])continue;am[i]=bm[j]=true;matches++;break;}}
  if (!matches) return 0;
  let k=0;
  for (let i=0;i<la;i++){if(!am[i])continue;while(!bm[k])k++;if(a[i]!==b[k])trans++;k++;}
  const jaro=(matches/la+matches/lb+(matches-trans/2)/matches)/3;
  let pfx=0;for(let i=0;i<Math.min(4,la,lb);i++){if(a[i]!==b[i])break;pfx++;}
  return jaro+pfx*0.1*(1-jaro);
}
const STOPS = new Set(["the","a","an","in","on","of","to","is","was","are","were","be","been","have","has","had","do","does","did","will","would","could","should","may","might","el","la","los","las","un","una","de","en","con","por","para","que","se","no","al","del","le","su","sus","como","pero","si","este","esta","y","o","e","customer","user","usuario","client","cliente"]);
function normCmp(s) {
  return s.toLowerCase().replace(/[^a-z0-9\sáéíóúüñ]/g," ").split(/\s+/).filter(w=>w.length>1&&!STOPS.has(w)).join(" ").trim();
}
function tokenSetSim(a,b) {
  const ta=new Set(normCmp(a).split(" ").filter(Boolean));
  const tb=new Set(normCmp(b).split(" ").filter(Boolean));
  if(!ta.size||!tb.size)return 0;
  const aStr=[...ta].sort().join(" ");
  const bStr=[...tb].sort().join(" ");
  // Short strings (acronyms like "IoT", "CRM", "OCR") must match exactly —
  // Jaro-Winkler produces too many false positives on strings < 6 chars.
  if(aStr.length<6||bStr.length<6) return aStr===bStr?1:0;
  const inter=[...ta].filter(w=>tb.has(w)).length;
  const union=new Set([...ta,...tb]).size;
  return Math.max(inter/union, jaroWinkler(aStr,bStr));
}
const SIM_THRESHOLD = 0.72;

function clusterStrings(strings) {
  // 1. Count frequencies to prioritize the most common phrases as our cluster "centroids"
  const counts = {};
  strings.forEach(s => { if (s) counts[s] = (counts[s] || 0) + 1; });
  const unique = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

  const clusters = [];
  const labelMap = {};

  // 2. Greedy clustering: compare against centroids to avoid the "chaining effect"
  unique.forEach(s => {
    let bestMatch = null;
    let bestSim = 0;

    for (const cluster of clusters) {
      const sim = tokenSetSim(cluster.centroid, s);
      if (sim >= SIM_THRESHOLD && sim > bestSim) {
        bestSim = sim;
        bestMatch = cluster;
      }
    }

    if (bestMatch) {
      bestMatch.members.push(s);
    } else {
      // No close match found, create a new cluster centroid
      clusters.push({ centroid: s, members: [s] });
    }
  });

  // 3. Assign the shortest string in each cluster as the representative clean label
  clusters.forEach(cluster => {
    const label = cluster.members.reduce((a, b) => a.length <= b.length ? a : b);
    cluster.members.forEach(s => {
      labelMap[s] = label;
    });
  });

  return labelMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function parseCSVText(text) {
  const rows=[];let row=[],field="",inQ=false;
  for(let i=0;i<text.length;i++){const ch=text[i];if(inQ){if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}else if(ch==='"')inQ=false;else field+=ch;}else if(ch==='"')inQ=true;else if(ch===","){row.push(field);field="";}else if(ch==="\n"||(ch==="\r"&&text[i+1]==="\n")){if(ch==="\r")i++;row.push(field);field="";rows.push(row);row=[];}else field+=ch;}
  if(field||row.length){row.push(field);rows.push(row);}
  if(rows.length<2)return[];
  const headers=rows[0].map(h=>h.trim());
  return rows.slice(1).filter(r=>r.some(c=>c.trim())).map(r=>{const obj={};headers.forEach((h,i)=>{obj[h]=(r[i]||"").trim();});return obj;});
}
function toCSV(headers,rows){
  const esc=v=>{const s=v==null?"":String(v);return(s.includes(",")||s.includes('"')||s.includes("\n"))?`"${s.replace(/"/g,'""')}"`:`${s}`;};
  return[headers,...rows.map(r=>headers.map(h=>esc(r[h])))].map(r=>r.join(",")).join("\r\n");
}
function dlCSV(filename,csv){
  const blob=new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob);const a=document.createElement("a");
  a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function buildSummary(structured) {
  const m={};
  structured.forEach(n=>{
    const app=n.app_grouped||n.app||(n.app===""?"(no app)":"(no app)");
    const issue=n.issue_grouped||n.issue||(n.issue===""?"(no issue)":"(no issue)");
    const key=`${app}|||${issue}`;
    if(!m[key])m[key]={app,issue,total:0,ticket_yes:0,ticket_no:0,ticket_unknown:0};
    m[key].total++;
    if(n.ticket_needed==="yes")m[key].ticket_yes++;
    else if(n.ticket_needed==="no")m[key].ticket_no++;
    else m[key].ticket_unknown++;
  });
  return Object.values(m).sort((a,b)=>b.total-a.total);
}

// ─────────────────────────────────────────────────────────────────────────────
// INSIGHTS GENERATOR
// ─────────────────────────────────────────────────────────────────────────────
function generateInsights(structured, summary, rawParsed) {
  if (!structured.length) return [];
  const insights = [];

  // Top app
  const appCounts = {};
  structured.forEach(n => { const a = n.app_grouped||n.app; if(a) appCounts[a]=(appCounts[a]||0)+1; });
  const topApp = Object.entries(appCounts).sort((a,b)=>b[1]-a[1])[0];
  if (topApp) insights.push({
    type: "top",
    icon: "ti-trophy",
    title: "Most consulted app",
    body: `"${topApp[0]}" accounts for ${topApp[1]} conversations (${Math.round(topApp[1]/structured.length*100)}% of structured notes). Consider prioritizing training material for this module.`,
    color: "#BA7517",
  });

  // Top issue
  const issueCounts = {};
  structured.forEach(n => { const i = n.issue_grouped||n.issue; if(i) issueCounts[i]=(issueCounts[i]||0)+1; });
  const topIssue = Object.entries(issueCounts).sort((a,b)=>b[1]-a[1])[0];
  if (topIssue) insights.push({
    type: "top",
    icon: "ti-alert-triangle",
    title: "Most recurring issue",
    body: `"${topIssue[0]}" appeared ${topIssue[1]} time${topIssue[1]>1?"s":""}. This is the single highest-frequency pain point across all apps — a strong training candidate.`,
    color: "#D85A30",
  });

  // Most escalated app×issue combo
  const highEsc = summary.filter(s=>s.ticket_yes>0).sort((a,b)=>(b.ticket_yes/b.total)-(a.ticket_yes/a.total))[0];
  if (highEsc && highEsc.total >= 2) insights.push({
    type: "escalation",
    icon: "ti-ticket",
    title: "Highest escalation rate",
    body: `${highEsc.app} → "${highEsc.issue}" escalates to a ticket ${Math.round(highEsc.ticket_yes/highEsc.total*100)}% of the time (${highEsc.ticket_yes}/${highEsc.total}). This issue may need documentation or a resolution playbook.`,
    color: "#D4537E",
  });

  // Overall escalation rate
  const totalYes = structured.filter(n=>n.ticket_needed==="yes").length;
  const escRate = Math.round(totalYes/structured.length*100);
  insights.push({
    type: "stat",
    icon: "ti-chart-bar",
    title: "Overall escalation rate",
    body: `${escRate}% of structured conversations (${totalYes} of ${structured.length}) required a support ticket. ${escRate > 40 ? "This is relatively high — consider whether common issues can be resolved with better self-service resources." : escRate < 15 ? "This is low, suggesting agents are resolving most issues in chat." : "This is within a typical range."}`,
    color: "#378ADD",
  });

  // Note format coverage
  const fmtCounts = rawParsed.reduce((a,n)=>{a[n.format]=(a[n.format]||0)+1;return a;},{});
  const newFmt = fmtCounts.new || 0;
  const total = rawParsed.length;
  const coverage = Math.round(newFmt/total*100);
  if (coverage < 70) insights.push({
    type: "quality",
    icon: "ti-pencil",
    title: "Note format adoption",
    body: `Only ${coverage}% of notes use the new structured format (app / issue / ticket_needed). The remaining ${100-coverage}% use older formats or free text, which reduces data quality. Consider a brief team reminder on the standard format.`,
    color: "#7F77DD",
  });

  // Clustering impact
  const rawIssues = new Set(structured.map(n=>n.issue).filter(Boolean)).size;
  const grpIssues = new Set(structured.map(n=>n.issue_grouped||n.issue).filter(Boolean)).size;
  if (rawIssues > grpIssues) insights.push({
    type: "cluster",
    icon: "ti-arrows-join",
    title: "Issue grouping impact",
    body: `Fuzzy matching grouped ${rawIssues} unique issue descriptions into ${grpIssues} canonical clusters — a ${Math.round((1-grpIssues/rawIssues)*100)}% reduction in noise. The summary CSV reflects these merged groups.`,
    color: "#1D9E75",
  });

  // Apps with zero issues logged
  const appsNoIssue = structured.filter(n=>(n.app_grouped||n.app) && !(n.issue_grouped||n.issue));
  if (appsNoIssue.length > 0) {
    const counts = {};
    appsNoIssue.forEach(n=>{const a=n.app_grouped||n.app;counts[a]=(counts[a]||0)+1;});
    const worst = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    insights.push({
      type: "quality",
      icon: "ti-file-unknown",
      title: "App logged without issue description",
      body: `${appsNoIssue.length} note${appsNoIssue.length>1?"s":""} recorded an app but left the issue field blank — "${worst[0]}" is the most common (${worst[1]} time${worst[1]>1?"s":""}). Encourage agents to always describe the issue for better training data.`,
      color: "#888780",
    });
  }

  return insights;
}

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────────────────
const PALETTE = ["#378ADD","#1D9E75","#BA7517","#D85A30","#7F77DD","#D4537E","#639922","#888780","#185FA5","#0F6E56"];
const FMT = {
  new:          { label:"new format", bg:"#E6F1FB", color:"#185FA5" },
  old_es:       { label:"old ES",     bg:"#EAF3DE", color:"#3B6D11" },
  old_en:       { label:"old EN",     bg:"#FAEEDA", color:"#854F0B" },
  hybrid:       { label:"hybrid",     bg:"#F3E8FA", color:"#7A3B99" },
  unstructured: { label:"free text",  bg:"#F1EFE8", color:"#5F5E5A" },
};

// ─────────────────────────────────────────────────────────────────────────────
// SHARED UI COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function Badge({ label, bg, color }) {
  return <span style={{ fontSize:10, padding:"2px 8px", borderRadius:20, background:bg, color, fontWeight:500, whiteSpace:"nowrap" }}>{label}</span>;
}

function Stat({ label, value, sub }) {
  return (
    <div style={{ background:"var(--color-background-secondary)", borderRadius:8, padding:"12px 14px", display:"flex", flexDirection:"column", gap:2 }}>
      <p style={{ fontSize:11, color:"var(--color-text-tertiary)", margin:0 }}>{label}</p>
      <p style={{ fontSize:22, fontWeight:500, margin:0, color:"var(--color-text-primary)" }}>{value}</p>
      {sub && <p style={{ fontSize:11, color:"var(--color-text-secondary)", margin:0 }}>{sub}</p>}
    </div>
  );
}

function SectionTitle({ children }) {
  return <p style={{ fontSize:12, fontWeight:500, color:"var(--color-text-secondary)", margin:"0 0 12px" }}>{children}</p>;
}

function Card({ children, style }) {
  return (
    <div style={{ border:"0.5px solid var(--color-border-tertiary)", borderRadius:8, padding:"14px 16px", ...style }}>
      {children}
    </div>
  );
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display:"flex", gap:0, borderBottom:"0.5px solid var(--color-border-tertiary)", marginBottom:20 }}>
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)} style={{
          background:"none", border:"none", cursor:"pointer", padding:"9px 16px",
          fontSize:13, fontWeight: active===t.key ? 500 : 400,
          color: active===t.key ? "var(--color-text-primary)" : "var(--color-text-secondary)",
          borderBottom: active===t.key ? "2px solid var(--color-text-primary)" : "2px solid transparent",
          marginBottom:-1, display:"flex", alignItems:"center", gap:6,
        }}>
          <i className={`ti ${t.icon}`} aria-hidden="true" style={{ fontSize:14 }} />
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM TOOLTIP FOR RECHARTS
// ─────────────────────────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:8, padding:"8px 12px", fontSize:12 }}>
      <p style={{ margin:"0 0 4px", fontWeight:500, color:"var(--color-text-primary)" }}>{label}</p>
      {payload.map((p,i) => (
        <p key={i} style={{ margin:0, color:"var(--color-text-secondary)" }}>{p.name}: <strong style={{ color:"var(--color-text-primary)" }}>{p.value}</strong></p>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHARTS TAB
// ─────────────────────────────────────────────────────────────────────────────
function ChartsTab({ structured, summary }) {
  const [topN, setTopN] = useState(10);

  const appData = useMemo(() => {
    const c={};structured.forEach(n=>{const a=n.app_grouped||n.app;if(a)c[a]=(c[a]||0)+1;});
    return Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,topN).map(([name,count])=>({name,count}));
  }, [structured, topN]);

  const issueData = useMemo(() => {
    const c={};structured.forEach(n=>{const i=n.issue_grouped||n.issue;if(i)c[i]=(c[i]||0)+1;});
    return Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,topN).map(([name,count])=>({name,count}));
  }, [structured, topN]);

  const ticketData = useMemo(() => {
    const yes=structured.filter(n=>n.ticket_needed==="yes").length;
    const no=structured.filter(n=>n.ticket_needed==="no").length;
    const unk=structured.filter(n=>n.ticket_needed==="unknown"||!n.ticket_needed).length;
    return [
      { name:"Ticket created", value:yes,  fill:"#639922" },
      { name:"Resolved in chat", value:no, fill:"#378ADD" },
      { name:"Not specified",  value:unk,  fill:"#888780" },
    ].filter(d=>d.value>0);
  }, [structured]);

  // App × Issue heatmap data (top 8 apps × top issues per app)
  const heatmap = useMemo(() => {
    const topApps = [...new Set(structured.map(n=>n.app_grouped||n.app).filter(Boolean))];
    const matrix = {};
    structured.forEach(n => {
      const a=n.app_grouped||n.app, iss=n.issue_grouped||n.issue;
      if(!a||!iss) return;
      if(!matrix[a]) matrix[a]={};
      matrix[a][iss]=(matrix[a][iss]||0)+1;
    });
    // Rank apps by total
    const appTotals = topApps.map(a=>({ a, t:Object.values(matrix[a]||{}).reduce((s,v)=>s+v,0) }))
      .sort((x,y)=>y.t-x.t).slice(0,6).map(x=>x.a);
    // Top issues across those apps
    const issueSet = {};
    appTotals.forEach(a => { Object.entries(matrix[a]||{}).forEach(([iss,cnt])=>{issueSet[iss]=(issueSet[iss]||0)+cnt;}); });
    const topIssues = Object.entries(issueSet).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([i])=>i);
    return { appTotals, topIssues, matrix };
  }, [structured]);

  const fmtData = useMemo(() => {
    const c={};structured.forEach(n=>{c[n.format]=(c[n.format]||0)+1;});
    return Object.entries(c).map(([fmt,value])=>({ name:(FMT[fmt]||FMT.unstructured).label, value, fill: fmt==="new"?"#378ADD":fmt==="old_es"?"#639922":fmt==="old_en"?"#BA7517":"#888780" }));
  }, [structured]);

  const axisStyle = { fontSize:11, fill:"var(--color-text-tertiary)", fontFamily:"inherit" };
  const barH = (n) => Math.max(160, n * 36 + 40);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

      {/* Top N slider */}
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        <label style={{ fontSize:12, color:"var(--color-text-secondary)" }}>Show top</label>
        <input type="range" min={3} max={Math.min(20, Math.max(appData.length+5, issueData.length+5, 10))} value={topN}
          onChange={e=>setTopN(Number(e.target.value))} style={{ width:100 }} />
        <span style={{ fontSize:12, fontWeight:500, color:"var(--color-text-primary)", minWidth:16 }}>{topN}</span>
      </div>

      {/* Apps + Issues side by side */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
        <Card>
          <SectionTitle>Top apps by frequency</SectionTitle>
          <div style={{ height:barH(appData.length) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={appData} layout="vertical" margin={{ left:4, right:32, top:4, bottom:4 }}>
                <XAxis type="number" tick={axisStyle} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="name" width={130} tick={axisStyle} tickLine={false} axisLine={false} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill:"var(--color-background-secondary)" }} />
                <Bar dataKey="count" name="Conversations" radius={[0,4,4,0]}>
                  {appData.map((_,i)=><Cell key={i} fill={PALETTE[i%PALETTE.length]} fillOpacity={0.85} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <SectionTitle>Top issues by frequency (grouped)</SectionTitle>
          <div style={{ height:barH(issueData.length) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={issueData} layout="vertical" margin={{ left:4, right:32, top:4, bottom:4 }}>
                <XAxis type="number" tick={axisStyle} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="name" width={150} tick={axisStyle} tickLine={false} axisLine={false} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill:"var(--color-background-secondary)" }} />
                <Bar dataKey="count" name="Conversations" radius={[0,4,4,0]}>
                  {issueData.map((_,i)=><Cell key={i} fill={PALETTE[(i+3)%PALETTE.length]} fillOpacity={0.85} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Ticket escalation + Format breakdown */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
        <Card>
          <SectionTitle>Ticket escalation breakdown</SectionTitle>
          <div style={{ height:200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={ticketData} cx="50%" cy="50%" innerRadius={50} outerRadius={80}
                  dataKey="value" nameKey="name" paddingAngle={2}>
                  {ticketData.map((d,i)=><Cell key={i} fill={d.fill} />)}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
                <Legend iconType="circle" iconSize={8}
                  wrapperStyle={{ fontSize:12, color:"var(--color-text-secondary)" }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <SectionTitle>Note format breakdown</SectionTitle>
          <div style={{ height:200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={fmtData} cx="50%" cy="50%" innerRadius={50} outerRadius={80}
                  dataKey="value" nameKey="name" paddingAngle={2}>
                  {fmtData.map((d,i)=><Cell key={i} fill={d.fill} />)}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
                <Legend iconType="circle" iconSize={8}
                  wrapperStyle={{ fontSize:12, color:"var(--color-text-secondary)" }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* App × Issue heatmap */}
      {heatmap.appTotals.length > 0 && heatmap.topIssues.length > 0 && (
        <Card>
          <SectionTitle>App × Issue frequency matrix (top 6 × 6)</SectionTitle>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
              <thead>
                <tr>
                  <th style={{ padding:"6px 10px", textAlign:"left", color:"var(--color-text-tertiary)", fontWeight:400, whiteSpace:"nowrap", minWidth:90 }}>App ↓ / Issue →</th>
                  {heatmap.topIssues.map(iss=>(
                    <th key={iss} style={{ padding:"6px 8px", textAlign:"center", color:"var(--color-text-secondary)", fontWeight:400, whiteSpace:"nowrap", maxWidth:110, overflow:"hidden", textOverflow:"ellipsis" }}>
                      {iss.length>18?iss.slice(0,18)+"…":iss}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {heatmap.appTotals.map(app=>{
                  const rowMax = Math.max(...heatmap.topIssues.map(iss=>heatmap.matrix[app]?.[iss]||0));
                  return (
                    <tr key={app}>
                      <td style={{ padding:"5px 10px", color:"var(--color-text-primary)", fontWeight:500, whiteSpace:"nowrap" }}>{app}</td>
                      {heatmap.topIssues.map(iss=>{
                        const val = heatmap.matrix[app]?.[iss]||0;
                        const intensity = rowMax>0 ? val/rowMax : 0;
                        return (
                          <td key={iss} style={{ padding:"5px 8px", textAlign:"center",
                            background: val>0 ? `rgba(55,138,221,${0.1+intensity*0.75})` : "transparent",
                            borderRadius:4, color: val>0 ? (intensity>0.5?"#fff":"var(--color-text-primary)") : "var(--color-text-tertiary)",
                            fontWeight: val>0 ? 500 : 400,
                          }}>
                            {val>0?val:"·"}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize:10, color:"var(--color-text-tertiary)", margin:"10px 0 0", lineHeight:1.5 }}>
            Cell intensity is relative to each row's maximum. Darker = more frequent for that app.
          </p>
        </Card>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INSIGHTS TAB
// ─────────────────────────────────────────────────────────────────────────────
function InsightsTab({ insights }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      {insights.length === 0 && (
        <p style={{ fontSize:13, color:"var(--color-text-secondary)" }}>Not enough structured data to generate insights.</p>
      )}
      {insights.map((ins, i) => (
        <div key={i} style={{ display:"flex", gap:14, padding:"14px 16px",
          background:"var(--color-background-secondary)", borderRadius:8,
          borderLeft:`3px solid ${ins.color}` }}>
          <i className={`ti ${ins.icon}`} aria-hidden="true"
            style={{ fontSize:18, color:ins.color, marginTop:1, flexShrink:0 }} />
          <div>
            <p style={{ fontSize:13, fontWeight:500, margin:"0 0 4px", color:"var(--color-text-primary)" }}>{ins.title}</p>
            <p style={{ fontSize:12, color:"var(--color-text-secondary)", margin:0, lineHeight:1.6 }}>{ins.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT TAB
// ─────────────────────────────────────────────────────────────────────────────
function ExportCard({ icon, title, subtitle, description, onClick }) {
  return (
    <div style={{ display:"flex", alignItems:"flex-start", gap:14, padding:"14px 16px",
      background:"var(--color-background-secondary)", borderRadius:8 }}>
      <i className={`ti ti-${icon}`} aria-hidden="true"
        style={{ fontSize:20, color:"var(--color-text-tertiary)", marginTop:1, flexShrink:0 }} />
      <div style={{ flex:1 }}>
        <p style={{ fontSize:13, fontWeight:500, margin:"0 0 2px", color:"var(--color-text-primary)" }}>
          {title} <span style={{ fontWeight:400, color:"var(--color-text-tertiary)", fontSize:11 }}>{subtitle}</span>
        </p>
        <p style={{ fontSize:11, color:"var(--color-text-secondary)", margin:"0 0 10px", lineHeight:1.6 }}>{description}</p>
        <button onClick={onClick} style={{ display:"inline-flex", alignItems:"center", gap:6, fontSize:12, padding:"6px 14px", cursor:"pointer" }}>
          <i className="ti ti-download" aria-hidden="true" /> Download
        </button>
      </div>
    </div>
  );
}

function Preview({ notes, label }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const PER=10, pages=Math.ceil(notes.length/PER), slice=notes.slice(page*PER,(page+1)*PER);
  return (
    <div style={{ border:"0.5px solid var(--color-border-tertiary)", borderRadius:8, overflow:"hidden" }}>
      <button onClick={()=>setOpen(o=>!o)} style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 14px", background:"var(--color-background-secondary)", border:"none", cursor:"pointer", fontSize:13, fontWeight:500, color:"var(--color-text-primary)" }}>
        <span>{label} <span style={{ fontWeight:400, color:"var(--color-text-secondary)" }}>({notes.length})</span></span>
        <i className={`ti ti-chevron-${open?"up":"down"}`} aria-hidden="true" style={{ fontSize:14 }} />
      </button>
      {open && (
        <div style={{ padding:"12px 14px", display:"flex", flexDirection:"column", gap:8 }}>
          {slice.map((n,i)=>(
            <div key={i} style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:6, padding:"8px 12px" }}>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center", marginBottom:4 }}>
                {(n.app_grouped||n.app)&&<span style={{ fontSize:12, fontWeight:500, color:"var(--color-text-primary)" }}>{n.app_grouped||n.app}{n.app_grouped&&n.app&&n.app_grouped!==n.app&&<span style={{ fontWeight:400, color:"var(--color-text-tertiary)", fontSize:10, marginLeft:4 }}>(raw: {n.app})</span>}</span>}
                {(n.issue_grouped||n.issue)&&<span style={{ fontSize:12, color:"var(--color-text-secondary)" }}>· {n.issue_grouped||n.issue}{n.issue_grouped&&n.issue&&n.issue_grouped!==n.issue&&<span style={{ color:"var(--color-text-tertiary)", fontSize:10, marginLeft:4 }}>(raw: {n.issue})</span>}</span>}
                <Badge {...(FMT[n.format]||FMT.unstructured)} />
                {n.ticket_needed&&<Badge label={`ticket: ${n.ticket_needed}`} bg={n.ticket_needed==="yes"?"#EAF3DE":n.ticket_needed==="no"?"#E6F1FB":"#F1EFE8"} color={n.ticket_needed==="yes"?"#3B6D11":n.ticket_needed==="no"?"#185FA5":"#5F5E5A"} />}
              </div>
              <p style={{ fontSize:11, color:"var(--color-text-tertiary)", margin:0, lineHeight:1.5 }}>{n.raw_note}</p>
            </div>
          ))}
          {pages>1&&(
            <div style={{ display:"flex", gap:8, alignItems:"center", justifyContent:"center", marginTop:4 }}>
              <button onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0} style={{ fontSize:12 }}><i className="ti ti-arrow-left" aria-hidden="true" /></button>
              <span style={{ fontSize:11, color:"var(--color-text-secondary)" }}>{page+1} / {pages}</span>
              <button onClick={()=>setPage(p=>Math.min(pages-1,p+1))} disabled={page===pages-1} style={{ fontSize:12 }}><i className="ti ti-arrow-right" aria-hidden="true" /></button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExportTab({ structured, unstructured, summary, baseName }) {
  const pct=(n,d)=>d?Math.round(n/d*100):0;
  const fmtCounts=structured.reduce((a,n)=>{a[n.format]=(a[n.format]||0)+1;return a;},{});

  function exportDetail() {
    dlCSV(`${baseName}_detail.csv`, toCSV(
      ["created_on","language","format","app","app_grouped","original_app","issue","issue_grouped","ticket_needed","raw_note"],
      structured.map(n=>({ created_on:n.created_on||"", language:n.language||"", format:n.format, app:n.app||"", app_grouped:n.app_grouped||"", original_app:n._original_app||"", issue:n.issue||"", issue_grouped:n.issue_grouped||"", ticket_needed:n.ticket_needed||"", raw_note:n.raw_note||"" }))));
  }
  function exportSummary() {
    dlCSV(`${baseName}_summary.csv`, toCSV(
      ["app","issue","total_conversations","ticket_yes","ticket_no","ticket_unknown","pct_escalated"],
      summary.map(s=>({ app:s.app, issue:s.issue, total_conversations:s.total, ticket_yes:s.ticket_yes, ticket_no:s.ticket_no, ticket_unknown:s.ticket_unknown, pct_escalated:s.total>0?Math.round(s.ticket_yes/s.total*100)+"%":"0%" }))));
  }
  function exportUnstructured() {
    dlCSV(`${baseName}_unstructured.csv`, toCSV(
      ["created_on","language","raw_note"],
      unstructured.map(n=>({ created_on:n.created_on||"", language:n.language||"", raw_note:n.raw_note||"" }))));
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <Card>
        <SectionTitle>Note format breakdown</SectionTitle>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {Object.entries(fmtCounts).map(([fmt,count])=>{
            const s=FMT[fmt]||FMT.unstructured;
            const barColor=fmt==="new"?"#378ADD":fmt==="old_es"?"#639922":fmt==="old_en"?"#BA7517":"#888780";
            return (
              <div key={fmt} style={{ display:"flex", alignItems:"center", gap:10 }}>
                <Badge label={s.label} bg={s.bg} color={s.color} />
                <div style={{ flex:1, height:6, borderRadius:3, background:"var(--color-background-secondary)", overflow:"hidden" }}>
                  <div style={{ height:"100%", borderRadius:3, background:barColor, width:`${pct(count,structured.length)}%` }} />
                </div>
                <span style={{ fontSize:12, color:"var(--color-text-secondary)", minWidth:60, textAlign:"right" }}>{count} ({pct(count,structured.length)}%)</span>
              </div>
            );
          })}
        </div>
      </Card>

      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        <p style={{ fontSize:11, color:"var(--color-text-tertiary)", margin:0 }}>UTF-8 with BOM — opens correctly in Excel and Google Sheets.</p>
        <ExportCard icon="table" title="Detail file" subtitle={`· ${baseName}_detail.csv · ${structured.length} rows`}
          description={<>One row per structured conversation. Includes raw and grouped <code>app</code> / <code>issue</code> columns.</>}
          onClick={exportDetail} />
        <ExportCard icon="chart-bar" title="Summary file" subtitle={`· ${baseName}_summary.csv · ${summary.length} rows`}
          description={<>One row per app × issue group, sorted by frequency. Ideal for training prioritization.</>}
          onClick={exportSummary} />
        <ExportCard icon="notes" title="Unstructured notes" subtitle={`· ${baseName}_unstructured.csv · ${unstructured.length} rows`}
          description={<>Free-text notes. Feed into BERTopic for topic modeling.</>}
          onClick={exportUnstructured} />
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        <SectionTitle>Preview</SectionTitle>
        <Preview notes={structured}   label="Structured notes" />
        <Preview notes={unstructured} label="Unstructured notes" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [baseName, setBaseName] = useState("");
  const [tab, setTab]           = useState("charts");

  const handleFile = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true); setError(null); setData(null);
    setBaseName(file.name.replace(/\.csv$/i,""));
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const rows = parseCSVText(ev.target.result);
        const noteCol = Object.keys(rows[0]||{}).find(k=>/live.?chat.?note/i.test(k)||/nota.?de.?chat/i.test(k)||/^note$/i.test(k));
        if (!noteCol) throw new Error("Cannot find a 'Live Chat Note' column in this file.");
        const dateCol = Object.keys(rows[0]||{}).find(k=>/created/i.test(k)||/creado/i.test(k));
        const langCol = Object.keys(rows[0]||{}).find(k=>/language|idioma/i.test(k));
        const convRows = dateCol ? rows.filter(r=>r[dateCol]?.trim()) : rows.filter(r=>r[noteCol]?.trim());
        const parsed = convRows.map(r=>parseNote(r[noteCol],{ created_on:dateCol?r[dateCol]:"", language:langCol?r[langCol]:"" })).filter(Boolean);
        // Step 1: Apply canonical aliases (Conta→Accounting etc.)
        const aliased = parsed.map(n=>({ ...n, app: n.app ? canonicalApp(n.app) : n.app }));

        // Step 2: Expand multi-value app fields ("Website, Mailing" → 2 rows)
        // Agents sometimes log multiple modules; split so each is counted individually
        const expanded = [];
        aliased.forEach(n => {
          if (!n.app) { expanded.push(n); return; }
          const parts = n.app.split(/\s*[,/+&]\s*/)
            .map(a => canonicalApp(a.trim()))
            .filter(a => a && a.length >= MIN_FIELD_LEN);
          if (parts.length <= 1) { expanded.push({ ...n, app: parts[0] || n.app }); return; }
          parts.forEach(a => expanded.push({ ...n, app: a, _original_app: n.app }));
        });

        // Step 3: Cluster on expanded single-value apps and issues
        const appMap   = clusterStrings(expanded.map(n=>n.app).filter(Boolean));
        const issueMap = clusterStrings(expanded.map(n=>n.issue).filter(Boolean));
        const annotated = expanded.map(n=>({ ...n, app_grouped:n.app?(appMap[n.app]||n.app):"", issue_grouped:n.issue?(issueMap[n.issue]||n.issue):"" }));
        setData({ parsed:annotated, total_rows:rows.length, total_convs:convRows.length });
        setLoading(false);
      } catch(err) { setError(err.message); setLoading(false); }
    };
    reader.onerror = () => { setError("Could not read file."); setLoading(false); };
    reader.readAsText(file,"UTF-8");
  }, []);

  const { structured, unstructured, summary, insights } = useMemo(() => {
    if (!data) return { structured:[], unstructured:[], summary:[], insights:[] };
    const structured   = data.parsed.filter(n=>n.format!=="unstructured");
    const unstructured = data.parsed.filter(n=>n.format==="unstructured");
    const summary      = buildSummary(structured);
    const insights     = generateInsights(structured, summary, data.parsed);
    return { structured, unstructured, summary, insights };
  }, [data]);

  // ── Upload screen ────────────────────────────────────────────────────────
  if (!data) {
    return (
      <div style={{ padding:"2rem 0", textAlign:"center" }}>
        <i className="ti ti-table-export" aria-hidden="true"
          style={{ fontSize:36, color:"var(--color-text-tertiary)", display:"block", marginBottom:14 }} />
        <p style={{ fontSize:15, fontWeight:500, margin:"0 0 6px", color:"var(--color-text-primary)" }}>Live Support Notes Analyzer</p>
        <p style={{ fontSize:13, color:"var(--color-text-secondary)", maxWidth:420, margin:"0 auto 24px", lineHeight:1.6 }}>
          Upload your Odoo Live Chat CSV export. Parses <code>app</code>, <code>issue</code>, and <code>ticket_needed</code>
          across all note formats, groups similar issues, visualizes trends, and highlights key insights.
        </p>
        <label style={{ display:"inline-flex", alignItems:"center", gap:8, cursor:"pointer", padding:"8px 20px",
          border:"0.5px solid var(--color-border-secondary)", borderRadius:8, fontSize:13, color:"var(--color-text-primary)" }}>
          <i className="ti ti-upload" aria-hidden="true" /> Choose CSV file
          <input type="file" accept=".csv" onChange={handleFile} style={{ display:"none" }} />
        </label>
        {loading && <p style={{ marginTop:14, fontSize:13, color:"var(--color-text-secondary)" }}>Parsing…</p>}
        {error   && <p style={{ marginTop:14, fontSize:13, color:"#A32D2D" }}>{error}</p>}
      </div>
    );
  }

  const pct=(n,d)=>d?Math.round(n/d*100):0;
  const rawIssues = new Set(structured.map(n=>n.issue).filter(Boolean)).size;
  const grpIssues = new Set(structured.map(n=>n.issue_grouped||n.issue).filter(Boolean)).size;

  return (
    <div style={{ padding:"1.5rem 0", display:"flex", flexDirection:"column", gap:20 }}>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
        <div>
          <p style={{ fontSize:15, fontWeight:500, margin:0, color:"var(--color-text-primary)" }}>{baseName||"Live Support Notes"}</p>
          <p style={{ fontSize:12, color:"var(--color-text-tertiary)", margin:0 }}>
            {data.total_rows.toLocaleString()} rows · {data.total_convs} conversations · {data.parsed.length} with notes
          </p>
        </div>
        <label style={{ display:"inline-flex", alignItems:"center", gap:6, cursor:"pointer", fontSize:12, color:"var(--color-text-secondary)", padding:"6px 12px", border:"0.5px solid var(--color-border-tertiary)", borderRadius:8 }}>
          <i className="ti ti-refresh" aria-hidden="true" /> Load new file
          <input type="file" accept=".csv" onChange={(e)=>{setData(null);setTimeout(()=>handleFile(e),50);}} style={{ display:"none" }} />
        </label>
      </div>

      {/* KPIs */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(120px, 1fr))", gap:10 }}>
        <Stat label="Notes parsed"    value={data.parsed.length} />
        <Stat label="Structured"      value={structured.length} sub={`${pct(structured.length,data.parsed.length)}% of notes`} />
        <Stat label="Unstructured"    value={unstructured.length} />
        <Stat label="Unique apps"     value={[...new Set(structured.map(n=>n.app_grouped||n.app).filter(Boolean))].length} />
        <Stat label="Issue groups"    value={grpIssues} sub={`from ${rawIssues} raw`} />
        <Stat label="Tickets created" value={structured.filter(n=>n.ticket_needed==="yes").length} sub={`${pct(structured.filter(n=>n.ticket_needed==="yes").length,structured.length)}% escalation rate`} />
      </div>

      {/* Grouping banner */}
      {rawIssues > grpIssues && (
        <div style={{ background:"var(--color-background-info)", border:"0.5px solid var(--color-border-info)", borderRadius:8, padding:"10px 14px", display:"flex", alignItems:"center", gap:10 }}>
          <i className="ti ti-arrows-join" aria-hidden="true" style={{ color:"#185FA5", fontSize:16, flexShrink:0 }} />
          <p style={{ fontSize:12, color:"#185FA5", margin:0, lineHeight:1.5 }}>
            Fuzzy matching merged <strong>{rawIssues} raw issues</strong> into <strong>{grpIssues} groups</strong> ({Math.round((1-grpIssues/rawIssues)*100)}% noise reduction).
          </p>
        </div>
      )}

      {/* Tabs */}
      <TabBar
        tabs={[
          { key:"charts",  label:"Charts",   icon:"ti-chart-bar" },
          { key:"insights",label:"Insights", icon:"ti-bulb" },
          { key:"export",  label:"Export",   icon:"ti-download" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "charts"   && <ChartsTab structured={structured} summary={summary} />}
      {tab === "insights" && <InsightsTab insights={insights} />}
      {tab === "export"   && <ExportTab structured={structured} unstructured={unstructured} summary={summary} baseName={baseName} />}

    </div>
  );
}
