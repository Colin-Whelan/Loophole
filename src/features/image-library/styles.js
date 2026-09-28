// Styles for the asset browser and its upload dialog, on top of theme.css tokens. Passed to each
// ctx.ui.dialog as `css` (every dialog is a separate overlay mount with its own shadow root).

const CHECKER = 'conic-gradient(var(--wb-sunken) 25%, var(--wb-surface) 0 50%, var(--wb-sunken) 0 75%, var(--wb-surface) 0) 0 0/16px 16px';

export const BROWSER_CSS = `
.il{display:flex; flex-direction:column; gap:10px; height:100%; min-height:0}
.il-ico{width:14px; height:14px; flex:none}
.il-row{display:flex; flex-wrap:wrap; align-items:center; gap:8px}
.il-crumbs{display:flex; flex-wrap:wrap; align-items:center; gap:2px; flex:1 1 260px; min-width:0; font-size:13px; margin:0; padding:0; list-style:none}
.il-crumbs li{display:inline-flex; align-items:center; gap:2px; min-width:0}
.il-crumb{border:0; background:transparent; color:var(--wb-accent-strong); font:500 13px var(--wb-font); padding:3px 6px; border-radius:var(--wb-r-sm); cursor:pointer; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.il-crumb:hover{background:var(--wb-accent-soft)}
.il-crumb[aria-current]{color:var(--wb-ink); font-weight:600; cursor:default; background:transparent}
.il-sep{color:var(--wb-faint); user-select:none}
.il-skip{display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--wb-muted); cursor:pointer; user-select:none}
.il-search{position:relative; flex:1 1 220px; max-width:380px}
.il-search .il-ico{position:absolute; left:9px; top:50%; transform:translateY(-50%); color:var(--wb-faint); pointer-events:none}
.il-search .wb-input{padding-left:30px}
.il-ctl{display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--wb-muted)}
.il-ctl .wb-select{width:auto; padding:5px 8px; font-size:12.5px}
.il-grow{flex:1}
.il-stage{position:relative; flex:1; min-height:0; display:flex}
.il-main{flex:1; min-width:0; overflow:auto; background:var(--wb-raised); border:1px solid var(--wb-line); border-radius:var(--wb-r); padding:12px}
.il-drop{position:absolute; inset:0; display:grid; place-items:center; background:var(--wb-accent-soft); border:2px dashed var(--wb-accent); border-radius:var(--wb-r); color:var(--wb-accent-strong); font-weight:600; pointer-events:none; z-index:2}
.il-drop > div{display:flex; flex-direction:column; align-items:center; gap:8px}
.il-drop .il-ico{width:32px; height:32px}
.il-note{font-size:12px; color:var(--wb-warn); background:var(--wb-warn-soft); border-radius:var(--wb-r); padding:6px 10px}
.il-sec + .il-sec{margin-top:16px}
.il-h{font-family:var(--wb-mono); font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--wb-faint); margin:0 0 8px}
.il-folders{display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:8px}
.il-images{display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:12px}
.il-folder{display:flex; align-items:center; gap:10px; min-width:0; padding:10px 12px; background:var(--wb-surface); border:1px solid var(--wb-line); border-radius:var(--wb-r); color:var(--wb-ink); font:500 13px var(--wb-font); text-align:left; cursor:pointer; transition:border-color .12s, box-shadow .12s}
.il-folder .il-ico{width:18px; height:18px; color:var(--wb-accent)}
.il-folder span{overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.il-card{position:relative; display:flex; flex-direction:column; min-width:0; padding:0; background:var(--wb-surface); border:1px solid var(--wb-line); border-radius:var(--wb-r); overflow:hidden; cursor:pointer; text-align:left; color:var(--wb-ink); font:inherit; transition:border-color .12s, box-shadow .12s}
.il-folder:hover, .il-card:hover{border-color:var(--wb-accent); box-shadow:var(--wb-shadow)}
.il-thumb{aspect-ratio:4/3; display:grid; place-items:center; padding:6px; background:${CHECKER}; border-bottom:1px solid var(--wb-line); overflow:hidden}
.il-thumb img{max-width:100%; max-height:100%; object-fit:contain; display:block}
.il-thumb.broken::after{content:"No preview"; font-size:11px; color:var(--wb-faint)}
.il-thumb.broken img{display:none}
.il-info{padding:8px 10px; min-width:0; display:flex; flex-direction:column; gap:2px}
.il-name{font-size:12.5px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.il-meta{font-family:var(--wb-mono); font-size:11px; color:var(--wb-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.il-state{height:100%; min-height:200px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--wb-muted); text-align:center; padding:20px}
.il-state .il-ico{width:32px; height:32px; color:var(--wb-faint)}
.il-state.bad{color:var(--wb-bad)}
.il-spin{width:28px; height:28px; border:3px solid var(--wb-line); border-top-color:var(--wb-accent); border-radius:50%; animation:il-spin .8s linear infinite}
@keyframes il-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.il-spin{animation-duration:2.4s}}
.il-foot{display:flex; flex-wrap:wrap; align-items:center; gap:8px; min-height:28px}
.il-count{font-size:12px; color:var(--wb-muted)}
.il-pages{display:flex; align-items:center; gap:4px}
.il-page{min-width:28px; height:28px; display:inline-grid; place-items:center; padding:0 6px; border:1px solid var(--wb-line-strong); background:var(--wb-surface); border-radius:var(--wb-r); font:500 12px var(--wb-font); color:var(--wb-ink); cursor:pointer}
.il-page:hover:not(:disabled){border-color:var(--wb-accent); color:var(--wb-accent-strong)}
.il-page[aria-current="page"]{background:var(--wb-accent); border-color:var(--wb-accent); color:var(--wb-on-accent)}
.il-page:disabled{opacity:.45; cursor:not-allowed}
.il-gap{color:var(--wb-faint); padding:0 2px}
.il-up{border:1px solid var(--wb-line); border-radius:var(--wb-r); background:var(--wb-surface); padding:8px 10px}
.il-up-head{display:flex; align-items:center; gap:10px; font-size:12.5px}
.il-up-t{flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.il-track{height:6px; background:var(--wb-sunken); border-radius:3px; overflow:hidden; margin-top:6px}
.il-fill{height:100%; width:0; background:var(--wb-accent); transition:width .2s}
.il-up.has-bad .il-fill{background:var(--wb-warn)}
.il-up-list{list-style:none; margin:8px 0 0; padding:0; max-height:132px; overflow:auto; display:flex; flex-direction:column; gap:3px}
.il-up-list li{display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 8px; align-items:center; font-size:12px}
.il-up-list .fn{overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.il-up-list .msg{grid-column:1/-1; color:var(--wb-bad); font-size:11.5px; overflow-wrap:anywhere}
.il-edit{display:flex; flex-direction:column; gap:10px}
.il-edit-intro{margin:0; font-size:12.5px; color:var(--wb-muted)}
.il-erow{display:grid; grid-template-columns:96px minmax(0,1fr); gap:12px; padding:10px; border:1px solid var(--wb-line); border-radius:var(--wb-r); background:var(--wb-raised)}
.il-eprev{width:96px; height:96px; display:grid; place-items:center; background:${CHECKER}; border-radius:var(--wb-r-sm); overflow:hidden}
.il-eprev img{max-width:100%; max-height:100%; object-fit:contain; display:block}
.il-efields{display:flex; flex-direction:column; gap:8px; min-width:0}
.il-namewrap{display:flex; align-items:center; gap:6px}
.il-ext{font-family:var(--wb-mono); font-size:12px; color:var(--wb-muted)}
.il-emeta{font-family:var(--wb-mono); font-size:11px; color:var(--wb-faint); overflow-wrap:anywhere}
.il-err{font-size:11.5px; color:var(--wb-bad); min-height:0}
`;
