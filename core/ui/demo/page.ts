/**
 * ui/demo/page.ts — static page assembly for the M8 acceptance demo.
 *
 * Wraps foldkit's server-rendered body markup in a full HTML document with
 * the demo stylesheet and the scripted-scenario record on top. The page is
 * static (no JS) — nothing can log a console error.
 */
const CSS = `
:root { color-scheme: dark; }
body { background: #0d1117; color: #e6edf3; font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; line-height: 1.5; }
.demo-shell { max-width: 1100px; margin: 0 auto; }
.demo-header h1 { font-size: 1.6rem; margin: 0 0 4px; }
.demo-header p { color: #8b949e; margin: 0 0 12px; }
.demo-tabs { display: flex; gap: 8px; margin-bottom: 20px; }
.demo-tab { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 4px 12px; font-size: 0.85rem; color: #8b949e; }
.demo-panels > section { background: #0d1117; border: 1px solid #21262d; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; }
h2 { font-size: 1.2rem; margin: 0 0 4px; }
.timeline-sub, .jobs-sub, .banners-sub, .asc-meta { color: #8b949e; font-size: 0.9rem; }
.timeline-budgets ul { list-style: none; padding: 0; }
.budget-row { display: flex; gap: 10px; align-items: center; margin: 4px 0; }
.budget-store { width: 110px; font-family: monospace; }
.budget-meter { flex: 1; height: 8px; background: #21262d; border-radius: 4px; overflow: hidden; }
.budget-fill { display: block; height: 100%; background: #1f6feb; }
.budget-count { font-family: monospace; color: #8b949e; }
.timeline-filters { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0; font-size: 0.9rem; }
.timeline-nodes, .jobs-list, .banners-list, .job-runs { list-style: none; padding: 0; }
.timeline-node { border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; margin: 8px 0; }
.timeline-node.archived { opacity: 0.55; }
.node-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.node-type { font-weight: 600; }
.node-subject { font-family: monospace; color: #79c0ff; }
.node-id { font-family: monospace; color: #8b949e; font-size: 0.8rem; }
.badge { font-size: 0.75rem; border-radius: 10px; padding: 1px 8px; }
.badge-verified { background: #1a3a2a; color: #3fb950; }
.badge-unverified { background: #3a2f1a; color: #d29922; }
.badge-rejected { background: #3a1a1a; color: #f85149; }
.node-provenance { font-size: 0.85rem; display: grid; grid-template-columns: 130px 1fr; gap: 2px 10px; margin-top: 8px; }
.node-provenance dt { color: #8b949e; }
.node-provenance dd { margin: 0; font-family: monospace; word-break: break-all; }
.node-provenance pre { background: #161b22; padding: 8px; border-radius: 6px; overflow: auto; max-height: 220px; }
button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 0.85rem; }
button:hover { background: #30363d; }
input, select { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 3px 8px; }
.jobs-section { margin: 14px 0; }
.jobs-section h3 { font-size: 1rem; margin: 0 0 6px; color: #8b949e; }
.job-row { border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; margin: 8px 0; }
.job-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.job-name { font-weight: 600; }
.job-id, .job-tier { font-family: monospace; color: #8b949e; font-size: 0.85rem; }
.job-status { font-size: 0.75rem; border-radius: 10px; padding: 1px 8px; background: #21262d; }
.job-status-enabled { background: #1a3a2a; color: #3fb950; }
.job-provenance { display: flex; gap: 14px; flex-wrap: wrap; font-size: 0.85rem; color: #8b949e; margin: 6px 0; }
.job-controls { display: flex; gap: 8px; flex-wrap: wrap; }
.run-row { font-size: 0.85rem; display: flex; gap: 10px; flex-wrap: wrap; padding: 3px 0; font-family: monospace; }
.run-status { font-weight: 600; }
.run-succeeded .run-status { color: #3fb950; }
.run-failed .run-status, .run-parked .run-status { color: #f85149; }
.banner { border: 1px solid #30363d; border-left-width: 4px; border-radius: 6px; padding: 10px 12px; margin: 8px 0; }
.banner-critical { border-left-color: #f85149; }
.banner-warning { border-left-color: #d29922; }
.banner-info { border-left-color: #1f6feb; }
.banner-success { border-left-color: #3fb950; }
.banner-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.banner-severity { font-weight: 700; text-transform: uppercase; font-size: 0.75rem; }
.banner-source { font-family: monospace; color: #8b949e; font-size: 0.8rem; }
.banner-title { font-weight: 600; }
.banner-body { margin: 6px 0; }
.banner-meta { display: flex; gap: 12px; font-size: 0.8rem; color: #8b949e; font-family: monospace; }
.banner-controls { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
.banners-mutes, .banners-quiet { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0; font-size: 0.9rem; }
button.muted { opacity: 0.55; text-decoration: line-through; }
.quiet-active { color: #d29922; font-weight: 600; }
.error { color: #f85149; }
.asc-dials { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin: 10px 0; }
.asc-dial { background: #161b22; border-radius: 6px; padding: 8px 12px; }
.asc-dial .dial-name { font-size: 0.8rem; color: #8b949e; text-transform: capitalize; }
.asc-dial .dial-value { font-size: 1.3rem; font-weight: 700; font-family: monospace; }
.demo-scenario { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; }
.demo-scenario h2 { margin-top: 0; }
.demo-scenario ol { margin: 8px 0; padding-left: 20px; }
.demo-scenario li { margin: 4px 0; font-size: 0.92rem; }
.demo-scenario code { font-family: monospace; color: #79c0ff; }
`

/**
 * `renderToString` returns the app's body markup (a fragment). Wrap it in a
 * full document with the demo stylesheet and the scenario record on top.
 */
export const renderPage = (bodyHtml: string, scenarioLog: ReadonlyArray<string>): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AImy — M8 acceptance demo</title>
<style>${CSS}</style>
</head>
<body>
<div class="demo-scenario">
<h2>scripted scenario — M8 acceptance demo</h2>
<ol>
<li><strong>turn → dials:</strong> a real turn through <code>AscSelfMonitor.preTurn/postTurn</code> (agent-loop path) → the L2 pipeline computes dials → <code>recordEvidence(taskOutcome)</code> feeds L1 → the ASC panel shows the dials (read-only).</li>
<li><strong>banner fires:</strong> a real <code>JobRunner</code> job completes → its alert lands on the real <code>CommsBanner</code> channel → banner queue shows it, priority-ordered.</li>
<li><strong>timeline events land:</strong> memory learned, skill created (unverified → verified), curator transition recorded through the real <code>LearningTimeline</code> → timeline shows them.</li>
</ol>
<p>run log:</p>
<pre>${scenarioLog.map((l) => l.replace(/</g, "&lt;")).join("\n")}</pre>
</div>
${bodyHtml}
</body>
</html>
`

