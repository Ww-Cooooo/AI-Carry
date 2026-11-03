import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {Popover,Tabs,Tooltip} from 'radix-ui';
import {ReactLenis} from 'lenis/react';
import {ArrowLeft,ArrowUpRight,ChevronDown,ChevronRight,Compass,GitBranch,HelpCircle,Layers,Search,X} from 'lucide-react';
import gsap from 'gsap';
import {useGSAP} from '@gsap/react';
import {type AccumulationNode as Node,type AccumulationData as Data} from './AccumulationScene';
import {collectionGroups,sourceCounts,detailGroups,otherEnd,relationDescription} from './accumulation-network.mjs';
import {kinds} from './accumulation-data.mjs';
import {SourceText} from './SourceText';
import {MapScene,type SceneControls,type MapSceneState} from './MapScene';
import {presentation} from './map-presentation';
import './refined-map.css';
import {useClient} from './client-state';
import {localizeText} from '../lib/i18n';
import {contentLocation} from './map-navigation.mjs';

const color:Record<string,string>={sop:'#588f7b',capability:'#a88342',source:'#3365b5',task:'#255de1',memory:'#5274c5',experience:'#896e9a',skill:'#58729d',learning:'#318878'};
// Keep only this assistant's transient viewing context. No records are stored
// on disk, and switching assistants discards the previous context.
type MapSession={identity:string;scene?:MapSceneState;trail:string[]};
let lastSession:MapSession|undefined;
function mapSession(identity:string){if(lastSession?.identity!==identity)lastSession={identity,trail:[]};return lastSession;}
export function NodeMark({node,size=18}:{node:Node;size?:number}){const Icon=presentation(node).icon;return <span className={'rm-mark rm-mark-'+node.kind} style={{color:color[node.kind]}}><Icon size={size} strokeWidth={1.7}/></span>;}
function Smooth({reduced,children}:{reduced:boolean;children:ReactNode}){
  const ref=useRef<any>(null);
  useEffect(()=>{if(reduced)return;const tick=(t:number)=>ref.current?.lenis?.raf(t*1000);gsap.ticker.add(tick);return()=>{gsap.ticker.remove(tick);};},[reduced]);
  return reduced?<div className="rm-detail-scroll">{children}</div>:<ReactLenis ref={ref} className="rm-detail-scroll" options={{autoRaf:false,duration:.65,overscroll:false}}>{children}</ReactLenis>;
}

function SearchMenu({data,onSelect}:{data:Data;onSelect:(id:string)=>void}){
  const[open,setOpen]=useState(false),[q,setQ]=useState('');
  const matches=data.nodes.filter(n=>(presentation(n,data.nodes).label+' '+n.title+' '+n.summary+' '+localizeText(kinds[n.kind].label)).toLowerCase().includes(q.trim().toLowerCase()));
  return <Popover.Root open={open} onOpenChange={v=>{setOpen(v);setQ('');}}><Popover.Trigger className="rm-search-trigger" aria-label="找一项积累或记录"><Search size={17}/><span>搜索地图</span><ChevronDown size={15}/></Popover.Trigger><Popover.Portal><Popover.Content className="rm-search-menu" sideOffset={12} align="end" collisionPadding={20}>
    <label><Search size={18}/><input autoComplete="off" placeholder="搜索名称或内容" aria-label="搜索积累或记录" value={q} onChange={e=>setQ(e.target.value)}/>{q&&<button aria-label="清空搜索" onClick={()=>setQ('')}><X size={16}/></button>}</label>
    <div className="rm-search-results">{matches.map(n=><button key={n.id} onClick={()=>{onSelect(n.id);setOpen(false);}}><NodeMark node={n}/><span><SourceText>{n.title}</SourceText><small>{kinds[n.kind].label}</small></span><ArrowUpRight size={15}/></button>)}{!matches.length&&<p>没有找到匹配内容，换个词试试。</p>}</div><footer>{matches.length} 项内容</footer>
  </Popover.Content></Popover.Portal></Popover.Root>;
}

function Detail({data,node,onSelect,onClose,onOpenList,reduced}:{data:Data;node:Node;onSelect:(id:string)=>void;onClose:()=>void;onOpenList:(node:Node)=>void;reduced:boolean}){
  const content=useRef<HTMLDivElement>(null);
  const groups=detailGroups(data,node),count=data.adjacent(node.id).length;
  useGSAP(()=>{
    const parts=content.current?.children;if(!parts)return;
    if(reduced){gsap.set(parts,{y:0,autoAlpha:1});return;}
    gsap.fromTo(parts,{y:12,autoAlpha:0},{y:0,autoAlpha:1,delay:.23,duration:.42,stagger:.045,ease:'power3.out'});
  },{scope:content,dependencies:[node.id,reduced],revertOnUpdate:true});
  return <><div className="rm-detail-head"><span><NodeMark node={node}/>{kinds[node.kind].label}</span><button aria-label="关闭详情并返回全景" onClick={onClose}><X size={18}/></button></div>
    <Smooth key={node.id} reduced={reduced}><div className="rm-detail-body" key={node.id} ref={content}>
      <h2><SourceText>{node.title}</SourceText></h2><p className="rm-summary"><SourceText>{node.summary}</SourceText></p>
      {node.entry&&<button className="rm-open-content" onClick={()=>['memory','sop','capability','experience'].includes(node.kind)?onOpenList(node):location.hash=contentLocation(node)||'library'}>{['memory','sop','capability','experience'].includes(node.kind)?'查看内容与来源':node.kind==='learning'?'查看这条建议':'查看这份 Skill'}<ArrowUpRight size={16}/></button>}
      <div className="rm-detail-divider"/>{!count&&<p className="rm-summary">还没有关联记录，不影响这条积累的使用。</p>}
      {groups.map((group:any)=>group.edges.length>0&&<section className="rm-related-group" key={group.label}><h3>{group.label}<span>{group.edges.length}</span></h3>{group.edges.map((edge:any)=>{const other=data.byId[otherEnd(edge,node.id)];return <button className="rm-related" key={edge.id} data-related-id={other.id} aria-label={`探索${other.title}，${relationDescription(edge,node.id)}`} onClick={()=>onSelect(other.id)}><NodeMark node={other} size={21}/><span><strong><SourceText>{presentation(other,data.nodes).label}</SourceText></strong><small>{relationDescription(edge,node.id)}</small></span><ChevronRight size={15}/></button>;})}</section>)}
    </div></Smooth><footer className="rm-detail-footer"><GitBranch size={15}/>{count} 条已记录关联</footer></>;
}

export default function AccumulationMap({data,selected,onSelect,onOpenList,reduced,paused=false,sessionKey}:{data:Data;selected:string|null;onSelect:(id:string|null)=>void;onOpenList:(node:Node)=>void;reduced:boolean;paused?:boolean;sessionKey:string}){
  const {demo,assistant,dataLoading}=useClient();
  const session=useMemo(()=>mapSession(sessionKey),[sessionKey]);
  const root=useRef<HTMLDivElement>(null),panel=useRef<HTMLElement>(null),scene=useRef<SceneControls|null>(null);
  const[retained,setRetained]=useState<string|null>(selected),[emphasis,setEmphasis]=useState<string|null>(null);
  const[trail,setTrail]=useState<string[]>(selected?(session.trail.at(-1)===selected?session.trail:[selected]):[]);
  useEffect(()=>{session.trail=trail;},[session,trail]);
  const groups=useMemo(()=>collectionGroups(data),[data]),sources=useMemo(()=>sourceCounts(data),[data]);
  const close=()=>{setTrail([]);onSelect(null);setEmphasis(null);};
  const pick=(id:string|null)=>{setEmphasis(null);onSelect(id);};
  const visit=(index:number)=>{const next=trail.slice(0,index+1);setTrail(next);pick(next.at(-1)||null);};
  const back=()=>trail.length>1?visit(trail.length-2):close();
  useEffect(()=>{if(selected)setRetained(selected);setTrail(prev=>!selected?[]:prev.at(-1)===selected?prev:[...prev,selected]);},[selected]);
  useEffect(()=>setTrail(prev=>prev.filter(id=>!!data.byId[id])),[data]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==='Escape')close();};addEventListener('keydown',key);return()=>removeEventListener('keydown',key);},[onSelect]);
  useGSAP(()=>{
    if(!panel.current)return;
    const el=panel.current;
    gsap.killTweensOf(el);
    el.inert=!selected;
    gsap.to(el,{x:selected?0:42,autoAlpha:selected?1:0,delay:reduced||!selected?0:.22,duration:reduced?0:.46,ease:'power3.out',overwrite:true});
  },{scope:root,dependencies:[Boolean(selected),reduced]});
  const picked=retained?data.byId[retained]:null;
  return <Tooltip.Provider delayDuration={350}><div className={'rm-map'+(selected?' is-focused':'')} ref={root}>
    <div className="rm-topline"><div className="rm-map-heading">{selected?<nav className="rm-trail" aria-label="地图探索路径">
      <button className="rm-trail-back" aria-label="返回上一项" onClick={back}><ArrowLeft size={17}/></button>
      <button className="rm-trail-home" aria-label="返回全景" onClick={close}><Compass size={17}/></button>
      {trail.length>3&&<span className="rm-trail-ellipsis" aria-hidden="true">…</span>}
      {trail.slice(-3).map((id,i)=>{const index=trail.length-Math.min(trail.length,3)+i,node=data.byId[id];return node&&<span className="rm-trail-item" key={index}><ChevronRight size={12}/>{index===trail.length-1?<span aria-current="page"><SourceText>{presentation(node,data.nodes).label}</SourceText></span>:<button onClick={()=>visit(index)} aria-label={`返回${presentation(node,data.nodes).label}`}><SourceText>{presentation(node,data.nodes).label}</SourceText></button>}</span>;})}
    </nav>:<><span><Compass size={19}/>积累全景</span><i/><small>{data.nodes.length} 项内容 <b>·</b> {data.edges.length} 条关联</small></>}</div><div className="rm-map-tools"><SearchMenu data={data} onSelect={pick}/><Popover.Root><Popover.Trigger className="rm-round" aria-label="地图说明"><HelpCircle size={18}/></Popover.Trigger><Popover.Portal><Popover.Content className="rm-help" align="end" sideOffset={10}><strong>只显示已记录的关系</strong><p>点选节点查看内容，沿关联继续探索。左上角可返回上一项或全景。</p><p>连线来自来源、关联和使用记录，不按名称猜测。任务与来源用编号展示，不展开原始对话。</p><div className="rm-legend" aria-label="连线含义"><span><i className="formed"/>来源 / 学到</span><span><i className="used"/>在任务中用过</span><span><i className="related"/>已有联系</span></div><p>任务与来源记录不计入记忆或能力；查看地图不会修改积累，也不会执行任务。</p>{demo&&<p>当前为演示数据，不是你的真实记录。</p>}</Popover.Content></Popover.Portal></Popover.Root></div></div>
    <div className="rm-surface">
      {data.nodes.length?<MapScene data={data} selected={selected} emphasis={emphasis} reduced={reduced} paused={paused} onSelect={pick} controls={scene} sources={sources} session={session}/>:<div className="rm-empty"><Compass size={36}/><h2>{dataLoading?'正在读取积累…':!assistant?'先选择助手文件夹':'这里还没有积累'}</h2><p>{!assistant?'选择助手后，查看已有的记忆和方法。':'以后保存的记忆、方法与关联，会显示在这里。'}</p></div>}
      <aside ref={panel} className="rm-detail" aria-label="所选条目详情" aria-hidden={!selected}>{picked&&<Detail data={data} node={picked} onSelect={pick} onClose={close} onOpenList={onOpenList} reduced={reduced}/>}</aside>
    </div>
    <div className="rm-bottomline"><Tabs.Root value={emphasis||'all'} onValueChange={v=>{onSelect(null);setEmphasis(v==='all'?null:v);}}><Tabs.List className="rm-kind-tabs" aria-label="按类型突出显示"><Tabs.Trigger value="all"><Layers size={15}/>全部</Tabs.Trigger>{groups.map((g:any)=><Tabs.Trigger value={g.kind} key={g.kind}><i style={{background:color[g.kind]||'#497fa4'}}/>{kinds[g.kind].label}</Tabs.Trigger>)}</Tabs.List></Tabs.Root><span className="rm-footer-hint">点选探索 · 拖动 · 缩放</span></div>
    {(data.skipped>0||data.partial)&&<p className="rm-partial">部分关联暂未显示，积累内容仍可从列表查看。</p>}
  </div></Tooltip.Provider>;
}
