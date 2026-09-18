// Official DSH lazy factory format; React is supplied by the platform module table.
window.__ModuleLoader__.load({id:'@dshagent/ui-runtime-selector',factory(require){
  const {createElement:h,useEffect,useState,useRef}=require('react');
  async function runtimeRequest(sessionId,selection,signal){
    const response=await fetch('/mvp/runtime?sessionId='+encodeURIComponent(sessionId),{
      method:selection?'POST':'GET',credentials:'same-origin',signal,
      headers:selection?{'Content-Type':'application/json'}:{},
      ...(selection?{body:JSON.stringify(selection)}:{})
    });
    const value=await response.json();
    if(!response.ok)throw new Error(value.error||'无法读取 Runtime，请重试');
    return value;
  }
  async function skillRequest(selection,signal){
    const response=await fetch('/mvp/skills',{
      method:selection?'POST':'GET',credentials:'same-origin',signal,
      headers:selection?{'Content-Type':'application/json'}:{},
      ...(selection?{body:JSON.stringify(selection)}:{})
    });
    const value=await response.json();
    if(!response.ok)throw new Error(value.error||'无法读取 Skill，请重试');
    return value;
  }
  function SkillPanel(){
    const revision=useRef(0),savingRef=useRef(false);
    const [state,setState]=useState(null),[error,setError]=useState(''),[saving,setSaving]=useState('');
    const refresh=async(signal)=>{const version=revision.current;try{const value=await skillRequest(undefined,signal);if(!signal.aborted&&version===revision.current){setState(value);setError('');}}catch(e){if(!signal.aborted&&version===revision.current)setError(e.message);}};
    useEffect(()=>{revision.current++;const abort=new AbortController();let timer;const poll=async()=>{await refresh(abort.signal);if(!abort.signal.aborted)timer=setTimeout(poll,2500);};void poll();return()=>{revision.current++;abort.abort();clearTimeout(timer);};},[]);
    const toggle=async skill=>{
      if(state?.busy||savingRef.current)return;
      const version=++revision.current;savingRef.current=true;setSaving(skill.key);setError('');
      try{const value=await skillRequest({key:skill.key,enabled:!skill.enabled});if(version===revision.current)setState(value);}
      catch(e){if(version===revision.current)setError(e.message);}
      finally{if(version===revision.current){savingRef.current=false;setSaving('');}}
    };
    const skills=state?.skills||[];
    return h('main',{style:{height:'100%',overflow:'auto',padding:'40px 48px',boxSizing:'border-box',fontSize:14,color:'var(--dsw-alias-label-primary)'},'data-testid':'mvp-dsh-skills-panel'},
      h('div',{style:{maxWidth:900,margin:'0 auto'}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:20,marginBottom:24}},
          h('div',{style:{minWidth:0}},h('h1',{style:{fontSize:28,lineHeight:'36px',fontWeight:600,margin:'0 0 8px'}},'DSH Skills'),h('p',{style:{margin:0,color:'var(--dsw-alias-label-secondary)',lineHeight:'22px'}},'管理 DSH 声明的全局 Skill。Disable 会同步到 Multica，并影响后续任务。')),
          h('button',{type:'button',onClick:()=>{const abort=new AbortController();void refresh(abort.signal);},disabled:!!saving,style:{font:'inherit',padding:'7px 12px',border:'1px solid var(--dsw-alias-border-l3,#d5d9df)',borderRadius:8,background:'transparent',cursor:'pointer'}},'刷新')),
        state?.busy?h('div',{role:'status',style:{marginBottom:16,padding:'10px 12px',borderRadius:8,background:'#fff7ed',color:'#9a3412'}},'当前有任务执行中，Skill 状态暂时不可修改。'):null,
        error?h('div',{role:'alert',style:{marginBottom:16,padding:'10px 12px',borderRadius:8,background:'#fef2f2',color:'#b42318'}},error):null,
        h('div',{style:{border:'1px solid var(--dsw-alias-border-l3,#d5d9df)',borderRadius:12,overflow:'hidden',background:'var(--dsw-alias-bg-layer-1,#fff)'}},
          h('div',{style:{display:'grid',gridTemplateColumns:'minmax(0,1fr) 110px 100px',gap:16,padding:'12px 16px',borderBottom:'1px solid #edf0f2',color:'var(--dsw-alias-label-secondary)',fontSize:12,fontWeight:600}},h('span',null,'Skill'),h('span',null,'状态'),h('span',null,'操作')),
          skills.length?h('ul',{style:{listStyle:'none',padding:0,margin:0}},skills.map(skill=>h('li',{key:skill.key,style:{display:'grid',gridTemplateColumns:'minmax(0,1fr) 110px 100px',gap:16,alignItems:'center',padding:'16px',borderBottom:'1px solid #edf0f2'}},
            h('div',{style:{minWidth:0}},h('div',{style:{fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},skill.name),h('div',{style:{marginTop:4,color:'var(--dsw-alias-label-secondary)',lineHeight:'20px'}},skill.description||'无描述'),h('div',{style:{marginTop:5,fontSize:11,color:'var(--dsw-alias-label-tertiary,#98a2b3)'}},skill.key,' · v',skill.version)),
            h('span',{style:{color:skill.enabled?'#067647':'#b42318',fontWeight:500}},skill.enabled?'Enabled':'Disabled'),
            h('button',{type:'button',disabled:!!state?.busy||saving===skill.key,onClick:()=>toggle(skill),style:{font:'inherit',padding:'6px 10px',border:'1px solid #d5d9df',borderRadius:7,background:skill.enabled?'#fff4ed':'#eef8f1',cursor:state?.busy?'not-allowed':'pointer',opacity:state?.busy?0.6:1}},saving===skill.key?'保存中…':skill.enabled?'Disable':'Enable')))):
            h('div',{style:{padding:'28px 16px',color:'var(--dsw-alias-label-secondary)'}},'当前没有检测到 DSH Skill。请检查 managedSkillsDir 或 DSH Skill Registry 配置。'),
        h('p',{style:{margin:'14px 0 0',fontSize:12,color:'var(--dsw-alias-label-secondary)'}},'删除 DSH 源 Skill 后，下一次任务同步会删除对应的 DSH-owned Multica Skill；外部创建的同名 Skill 不会被删除。'))));
  }
  function PanelIcon({size=16}){return h('span',{style:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:size,height:size,fontSize:size*.72,fontWeight:700,border:'1.5px solid currentColor',borderRadius:4}},'S');}
  function RuntimeSelect({sessionId,available,locked}){
    const revision=useRef(0),savingRef=useRef(false);
    const [state,setState]=useState(null),[error,setError]=useState(''),[saving,setSaving]=useState(false);
    useEffect(()=>{revision.current++;savingRef.current=false;setSaving(false);setState(null);setError('');if(!available)return;const abort=new AbortController();let timer;const refresh=async()=>{const version=revision.current;try{if(savingRef.current)return;const value=await runtimeRequest(sessionId,undefined,abort.signal);if(!abort.signal.aborted&&version===revision.current){setState(value);setError('');}}catch(e){if(!abort.signal.aborted&&version===revision.current){setState(null);setError(e.message);}}finally{if(!abort.signal.aborted)timer=setTimeout(refresh,1500);}};void refresh();return()=>{revision.current++;abort.abort();clearTimeout(timer);};},[sessionId,available]);
    if(!available)return null;
    const blocked=locked||saving||!state||state.busy;
    const change=async event=>{const runtimeId=event.target.value;const selected=(state?.runtimes||[]).find(item=>item.runtimeId===runtimeId);if(!selected)return;const version=++revision.current;savingRef.current=true;setSaving(true);setError('');try{const value=await runtimeRequest(sessionId,{runtime:selected.kind,runtimeId:selected.runtimeId,daemonId:selected.daemonId});if(version===revision.current)setState(value);}catch(e){if(version===revision.current)setError(e.message);}finally{if(version===revision.current){savingRef.current=false;setSaving(false);}}};
    const selectedRuntimeId=state?.runtimeId||((state?.runtimes||[]).find(item=>item.kind===state?.runtime)?.runtimeId)||'';return h('span',{style:{display:'inline-flex',alignItems:'center',gap:6,flexWrap:'wrap',fontSize:13},'data-testid':'mvp-runtime-selector'},h('label',null,'执行器 ',h('select',{'aria-label':'执行器 Runtime',value:selectedRuntimeId,disabled:blocked,onChange:change,title:state?.busy?'任务执行或对账期间不能切换':'同一会话切换执行器，保留工作目录和历史',style:{font:'inherit',color:'inherit',background:'transparent',border:'1px solid #d5d9df',borderRadius:7,padding:'4px 8px'}},!state?h('option',{value:''},'加载中…'):null,(state?.runtimes||[]).map(item=>h('option',{key:item.runtimeId,value:item.runtimeId},item.label)),state?.runtimeId&&!(state.runtimes||[]).some(item=>item.runtimeId===state.runtimeId)?h('option',{value:state.runtimeId},state.label||({codex:'Codex','claude-code':'Claude Code'}[state.runtime]||state.runtime)):null)),state?.busy?h('span',{role:'status'},'任务进行中，结束后可切换'):null,saving?h('span',{role:'status'},'切换中…'):null,error?h('span',{role:'alert',style:{color:'#b42318',maxWidth:360}},error):null);
  }
  return {inject:['slots','sessions'],apply(ctx){
    ctx.slots.inject('conversation.input.model',()=>ctx.slots.register({name:'conversation.input.model',inject:sessionId=>({sessionId,available:ctx.sessions.subagentAddress(sessionId)===undefined})},RuntimeSelect));
    ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'mvp-dsh-skills',order:90,label:'DSH Skills'},PanelIcon));
    ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'mvp-dsh-skills'},SkillPanel));
  }};
}});
