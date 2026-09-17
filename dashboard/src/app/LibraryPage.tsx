import {SourceText} from './SourceText';
import React,{useEffect,useRef,useState,useMemo} from 'react';

import {Tabs,Popover,Dialog} from 'radix-ui';
import {ArrowUpRight,ArrowRight,ArrowLeft,ChevronDown,Brain,Route,Lightbulb,Compass,Search,HelpCircle,X,MessageCircle,BookOpen,LayoutGrid,Network,List} from 'lucide-react';
import gsap from 'gsap';
import {useGSAP} from '@gsap/react';
import Lenis from 'lenis';
import {type Asset,useClient} from './client-state';
import {AssistantNotice,type Ask} from './shared';
import './base.css';
import AccumulationMap from './AccumulationMap';
import {buildAccumulationData} from './accumulation-data.mjs';
import {localizeText,useDashboardLocale} from '../lib/i18n';
import {buildDashboardAction,buildHabitCorrectionAction,buildHabitForgetAction} from '../lib/data';
const actionTarget=(entry:Asset)=>({...entry,status:entry.state||entry.status,reliability:entry.maturity||entry.reliability,approvalState:entry.approval_state,activationBasis:entry.activation_basis,approvedByUser:entry.approved_by_user,riskTier:entry.risk_tier});

gsap.registerPlugin(useGSAP);
type Kind='memories'|'sops'|'capabilities'|'experiences';
type Entry=Asset&{kind:Kind;when:string};
const kinds:{id:Kind|'all';label:string;Icon:typeof Brain}[]=[
  {id:'memories',label:'记忆',Icon:Brain},
  {id:'sops',label:'固定流程（SOP）',Icon:Route},{id:'capabilities',label:'能力',Icon:Compass},{id:'experiences',label:'经验',Icon:Lightbulb},{id:'all',label:'全部积累',Icon:LayoutGrid}
];
function readCollectionKind():Kind|'all'{
  const [route,query]=location.hash.slice(1).split('?');
  const value=route==='library'?new URLSearchParams(query||'').get('kind'):null;
  return kinds.find(item=>item.id===value)?.id||'memories';
}

export function useReducedMotion(){
  const [reduced,setReduced]=useState(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(()=>{const media=matchMedia('(prefers-reduced-motion: reduce)');const update=()=>setReduced(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  return reduced;
}
export function Help({label,children}:{label:string;children:React.ReactNode}){
  const [open,setOpen]=useState(false),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const enter=()=>{if(timer.current)clearTimeout(timer.current);setOpen(true);};
  const leave=()=>{timer.current=setTimeout(()=>setOpen(false),180);};
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
  return <Popover.Root open={open} onOpenChange={setOpen}><Popover.Trigger asChild><button className="help-button" aria-label={label} onPointerEnter={enter} onPointerLeave={leave} onFocus={enter}><HelpCircle size={18}/></button></Popover.Trigger><Popover.Portal><Popover.Content className="help-bubble" sideOffset={10} collisionPadding={20} onPointerEnter={enter} onPointerLeave={leave} onOpenAutoFocus={e=>e.preventDefault()} onCloseAutoFocus={e=>e.preventDefault()}><strong>{label}</strong><p>{children}</p><Popover.Arrow className="help-arrow"/></Popover.Content></Popover.Portal></Popover.Root>;
}
export function BrandStroke({reduced}:{reduced:boolean}){
  const canvas=useRef<HTMLCanvasElement>(null);
  useGSAP(()=>{
    const el=canvas.current;if(!el)return;
    let ctx:CanvasRenderingContext2D|null=null;
    try{ctx=el.getContext('2d');}catch{/* A decorative stroke must not take down the collection. */}
    if(!ctx){el.dataset.unavailable='true';return;}
    delete el.dataset.unavailable;
    const phase={value:reduced?1:0};
    const draw=()=>{
      const {width,height}=el.getBoundingClientRect();if(!width||!height)return;
      const ratio=Math.min(devicePixelRatio||1,2);el.width=Math.round(width*ratio);el.height=Math.round(height*ratio);ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
      const start={x:4,y:height*.7},end={x:width-4,y:height*.35};
      ctx.beginPath();ctx.moveTo(start.x,start.y);ctx.quadraticCurveTo(width*.44,2,end.x,end.y);ctx.lineWidth=3;ctx.lineCap='round';ctx.strokeStyle='#255de1';ctx.setLineDash([width]);ctx.lineDashOffset=width*(1-phase.value);ctx.stroke();el.dataset.phase=phase.value.toFixed(3);
    };
    const observer=new ResizeObserver(draw);observer.observe(el);draw();
    const timeline=reduced?null:gsap.to(phase,{value:1,duration:.85,ease:'power2.out',onUpdate:draw});
    return()=>{observer.disconnect();timeline?.kill();};
  },{dependencies:[reduced],revertOnUpdate:true});
  return <canvas ref={canvas} className="brand-stroke" aria-hidden="true"/>;
}
function EntryDetail({entry,reduced,onRequest,onExplore,ask}:{entry:Entry;reduced:boolean;onRequest:()=>void;onExplore:()=>void;ask?:Ask}){
  const root=useRef<HTMLDivElement>(null);
  const {act,assistant,demo}=useClient();
  const [body,setBody]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let current=true;setBody('');setError('');void act('assistant-entry',{id:entry.id}).then(value=>{if(current)setBody(value.body);}).catch(e=>{if(current)setError(e.message);});return()=>{current=false;};},[act,entry.id,assistant]);
  useGSAP(()=>{
    if(reduced)return;
    gsap.timeline().from(root.current,{height:0,opacity:0,duration:.46,ease:'power3.inOut',clearProps:'height,opacity'})
      .from('.asset-body',{x:-14,opacity:0,stagger:.065,duration:.4,ease:'power2.out'},.18)
      .from('.detail-context,.detail-actions',{y:12,opacity:0,duration:.35,stagger:.08},.24);
  },{scope:root,dependencies:[entry.id,reduced],revertOnUpdate:true});
  return <div ref={root} className="entry-detail" id={`detail-${entry.id}`}>
    <div className="detail-inner">
      <section className="detail-method"><h3>{entry.kind==='sops'?'这套流程怎么做':entry.kind==='capabilities'?'这项能力怎么用':entry.kind==='experiences'?'记录了什么经验':'记住了什么'}</h3><div className="asset-body">{error||<SourceText>{body||'正在读取这一条的正文…'}</SourceText>}</div></section>
      <section className="detail-context"><button className="text-button ac-map-back" onClick={onExplore}><Network size={16}/>在地图中看关联<ArrowUpRight size={16}/></button><h3>什么时候用<Help label="一定要说这句话吗？">不用。Agent 会根据你正在做的事，查找相关记忆和方法。你也可以点“让 Agent 用这条”，明确告诉它参考哪一条。</Help></h3><p>{entry.when||'这条记录还没写明使用场景，可以让 Agent 结合当前任务判断。'}</p>{entry.maturity&&<p>{({unvalidated:'还没有实际使用记录',practiced:'已在实际任务中使用',reliable:'已通过多次任务验证',portable:'已在不同 Agent 或环境中验证'} as Record<string,string>)[entry.maturity]||'实践情况待确认'}</p>}</section>
      <div className="detail-actions"><details className="source-detail"><summary>查看来源与补充<ChevronDown size={16}/></summary><p>{entry.source_summary||'来自你选择的助手文件夹。'}</p><p>条目：<SourceText>{entry.id}</SourceText></p>{entry.kind==="memories"&&entry.subtype==="habit"&&ask&&<div>{[buildHabitCorrectionAction(actionTarget(entry)),buildHabitForgetAction(actionTarget(entry))].map(a=><button key={a.buttonLabel} className="text-button" onClick={()=>ask({title:a.buttonLabel,itemId:entry.id,body:a.text})}>{a.buttonLabel}</button>)}</div>}<p>{demo?'这里是演示正文，不是你的真实记录。':(window.carryClient?'这里显示已保存的原始内容。':'网页显示保存的摘要；完整正文由 Agent 从原文件读取。')}</p></details><button className="primary-button" onClick={onRequest}>{buildDashboardAction(entry.kind,actionTarget(entry)).buttonLabel}<ArrowUpRight size={19}/></button></div>
    </div>
  </div>;
}
function readView():'map'|'list' {
  const query=new URLSearchParams(location.hash.split('?')[1]||'');
  return query.get('view')==='list'||(!query.has('view')&&query.has('kind'))?'list':'map';
}
export default function LibraryPage({ask,paused=false}:{ask?:Ask;paused?:boolean}={}) {
  const [view,setView]=useState(readView),[kind,setKind]=useState<Kind|'all'>(readCollectionKind),[query,setQuery]=useState('');
  const [selected,setSelected]=useState<string|null>(null),[mapSelected,setMapSelected]=useState<string|null>(null),[request,setRequest]=useState<Entry|null>(null);
  const {assistant}=useClient(),reduced=useReducedMotion(),{locale}=useDashboardLocale();
  const scroll=useRef<HTMLElement>(null),content=useRef<HTMLDivElement>(null),root=useRef<HTMLDivElement>(null);
  const entries:Entry[]=(['memories','sops','capabilities','experiences'] as Kind[]).flatMap(kind=>(assistant?.snapshot[kind]||[]).map(item=>({...item,kind,when:(item.triggers||[]).join('、')})));
  const snapshot=assistant?.snapshot;
  const dataKey=JSON.stringify([assistant?.binding, snapshot?.memories,snapshot?.sops,snapshot?.capabilities,snapshot?.experiences,snapshot?.evolution,snapshot?.skills,snapshot?.accumulation]);
  const data=useMemo(()=>buildAccumulationData(snapshot||{},localizeText),[dataKey,locale]);
  const identity=JSON.stringify([assistant?.binding.root,assistant?.binding.instanceId,snapshot?.meta.identity_ref]);
  useEffect(()=>{setSelected(null);setMapSelected(null);setQuery('');},[identity]);
  useEffect(()=>{if(mapSelected&&!data.byId[mapSelected])setMapSelected(null);if(selected&&!entries.some(e=>e.id===selected))setSelected(null);},[data]);
  const navigate=(next:'map'|'list',nextKind=kind,id:string|null=selected)=>{
    const query=new URLSearchParams({view:next,kind:nextKind});if(id)query.set('item',id);
    location.hash='library?'+query.toString();
    setView(next);setKind(nextKind);setSelected(id);
  };
  useEffect(()=>{const sync=()=>{
    const params=new URLSearchParams(location.hash.split('?')[1]||'');
    setView(readView());setKind(readCollectionKind());setSelected(params.get('item'));
  };addEventListener('hashchange',sync);return()=>removeEventListener('hashchange',sync);},[]);
  const openList=(node:{area?:string;assetId?:string})=>{if(!node.area||!node.assetId)return;setQuery('');navigate('list',node.area as Kind,node.assetId);};
  const explore=(entry:Entry)=>{setMapSelected('asset:'+entry.id);navigate('map',entry.kind,entry.id);};
  const chooseKind=(value:Kind|'all')=>{setQuery('');navigate('list',value,null);};
  const prepare=(entry:Entry)=>{const action=buildDashboardAction(entry.kind,actionTarget(entry));ask?ask({title:action.buttonLabel,itemId:entry.id,body:action.text}):setRequest(entry);};
  const filtered=entries.filter(entry=>(kind==='all'||entry.kind===kind)&&`${entry.title} ${entry.summary} ${entry.when}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(()=>{if(view!=='list'||reduced||!scroll.current||!content.current)return;const lenis=new Lenis({wrapper:scroll.current,content:content.current,smoothWheel:true,duration:.6});const tick=(time:number)=>lenis.raf(time*1000);gsap.ticker.add(tick);return()=>{gsap.ticker.remove(tick);lenis.destroy();};},[view,reduced]);
  useGSAP(()=>{if(reduced||view!=='list')return;const rows=root.current?.querySelectorAll('.entry-row');if(!rows?.length)return;gsap.from(rows,{y:16,opacity:0,stagger:{each:.035,amount:.25},duration:.4,clearProps:'transform,opacity'});},{scope:root,dependencies:[kind,view,reduced,entries.length],revertOnUpdate:true});
  useEffect(()=>{if(view==='list'&&selected)requestAnimationFrame(()=>document.getElementById('entry-'+selected)?.scrollIntoView({block:'nearest',behavior:reduced?'instant':'smooth'}));},[view,selected,reduced]);
  return <div className="app accumulation-page" ref={root}>
    <main className="page-scroll" ref={scroll}><div className="page-content" ref={content}>
      <div className="page-heading"><div><h1><span className="marked-word">{view==='map'?'积累地图':'我的积累'}<BrandStroke reduced={reduced}/></span></h1><p className="page-purpose">{view==='map'?'看看每一份积累，从哪里来、用到了哪里。':'记住的习惯、做熟的方法，都在这里。'}</p></div><Tabs.Root value={view} onValueChange={value=>navigate(value as 'map'|'list')}><Tabs.List className="ac-view-switch" aria-label="选择查看方式"><Tabs.Trigger value="map"><Network size={18}/>积累地图</Tabs.Trigger><Tabs.Trigger value="list"><List size={18}/>列表</Tabs.Trigger></Tabs.List></Tabs.Root></div>
      <AssistantNotice/>
      {view==='map'?<AccumulationMap key={identity} data={data} selected={mapSelected} onSelect={setMapSelected} onOpenList={openList} reduced={reduced} paused={paused}/>:<section className="collection" aria-label="助手积累列表"><div className="collection-toolbar"><Tabs.Root value={kind} onValueChange={value=>chooseKind(value as Kind|'all')}><Tabs.List className="category-tabs" aria-label="按类型查看积累">{kinds.map(item=><Tabs.Trigger className={item.id==='all'?'all-accumulation':''} value={item.id} key={item.id}><item.Icon size={17}/><span>{item.label}</span><small>{item.id==='all'?entries.length:entries.filter(e=>e.kind===item.id).length}</small></Tabs.Trigger>)}</Tabs.List></Tabs.Root><label className="search"><Search size={18}/><span className="sr-only">搜索积累</span><input value={query} onChange={e=>{setQuery(e.target.value);setSelected(null);}} placeholder="搜索名称或内容"/>{query&&<button aria-label="清空搜索" onClick={()=>setQuery('')}><X size={16}/></button>}</label></div>
      <div className="entry-list">{filtered.map(entry=>{const type=kinds.find(k=>k.id===entry.kind)!,open=selected===entry.id;return <article className={`entry ${open?'is-open':''}`} key={entry.id} id={'entry-'+entry.id}>
        <button className="entry-row" aria-expanded={open} aria-controls={`detail-${entry.id}`} onClick={()=>setSelected(open?null:entry.id)}><span className={`entry-icon ${entry.kind}`}><type.Icon size={23} strokeWidth={1.65}/></span><span className="entry-title"><strong><SourceText>{entry.title}</SourceText></strong><span className="kind-label">{type.label}</span></span><span className="entry-summary"><SourceText>{entry.summary}</SourceText></span><span className="entry-open">{open?'收起':'查看'}{open?<ChevronDown size={18}/>:<ArrowUpRight size={18}/>}</span></button>
        {open&&<EntryDetail entry={entry} reduced={reduced} ask={ask} onExplore={()=>explore(entry)} onRequest={()=>prepare(entry)}/>}
      </article>;})}</div>
      {!filtered.length&&<div className="empty-state"><BookOpen size={30}/><h2>{!assistant?'先选择助手文件夹':entries.length?'没有找到匹配的内容':'这里还没有积累'}</h2><p>{!assistant?'点上方“选择助手文件夹”，查看已有的记忆和方法。':entries.length?'换个词试试，或清空筛选再找。':'以后保存的记忆、方法和经验，会显示在这里。'}</p>{entries.length>0&&<button className="secondary-button" onClick={()=>{setQuery('');chooseKind('all');}}>清空筛选<ArrowRight size={17}/></button>}</div>}
      <footer className="collection-footer"><span>执行任务：复制请求，发给 Agent</span><span>字体：MiSans · Xiaomi</span></footer></section>}
    </div></main>
    <Dialog.Root open={!!request} onOpenChange={value=>{if(!value)setRequest(null);}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="request-dialog"><Dialog.Close className="dialog-close" aria-label="关闭请求预览"><X size={20}/></Dialog.Close><span className="request-icon"><MessageCircle size={26}/></span><Dialog.Title>让 Agent 参考这一条</Dialog.Title><Dialog.Description>这里先预览请求内容，没有发送给 Agent。</Dialog.Description><p className="request-copy">请参考「{request?.title}」，先问我这次要做什么，再结合当前任务使用；不适用的部分不用照搬。</p><Dialog.Close className="primary-button">返回查看<ArrowLeft size={18}/></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
