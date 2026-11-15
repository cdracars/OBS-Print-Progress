/* Pure presentation rules, shared by the browser and behavioral tests. */
(function(root){'use strict';
  function attention(p){return p.connection.state!=='online'||['paused','error'].includes(p.job.state)||p.lifecycle==='maintenance';}
  function state(p){if(p.lifecycle==='retired')return 'Retired';if(p.lifecycle==='planned')return 'Planned';if(p.connection.state!=='online')return p.connection.state==='stale'?'Stale data':'Offline';return ({standby:'Ready',printing:'Printing',paused:'Paused',complete:'Complete',cancelled:'Cancelled',error:'Needs attention'})[p.job.state]||'Unknown';}
  function duration(seconds){if(seconds==null||!Number.isFinite(seconds))return 'Not reported';const m=Math.max(0,Math.round(seconds/60));return m>=60?`${Math.floor(m/60)}h ${m%60}m`:`${m}m`;}
  function age(seconds){if(seconds==null)return 'No observation yet';if(seconds<3)return 'Just received';if(seconds<60)return `${Math.floor(seconds)}s ago`;return `${Math.floor(seconds/60)}m ago`;}
  function matches(p,filter,technology,search){return (technology==='all'||p.technology===technology)&&(!search||[p.name,p.type,p.location,p.id].join(' ').toLowerCase().includes(search.toLowerCase()))&&(filter==='all'||(filter==='attention'?attention(p):filter==='printing'?p.connection.state==='online'&&p.job.state==='printing':p.connection.state==='online'&&['standby','complete','cancelled'].includes(p.job.state)));}
  function totals(printers){return {all:printers.length,printing:printers.filter(p=>p.connection.state==='online'&&p.job.state==='printing').length,attention:printers.filter(attention).length,ready:printers.filter(p=>p.connection.state==='online'&&p.lifecycle==='active'&&['standby','complete','cancelled'].includes(p.job.state)).length};}
  const api={attention,state,duration,age,matches,totals};if(typeof module!=='undefined')module.exports=api;else root.FleetView=api;
})(typeof window!=='undefined'?window:globalThis);
