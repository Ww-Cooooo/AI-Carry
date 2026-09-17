import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {Popover,Tabs} from 'radix-ui';
import {ReactLenis} from 'lenis/react';
import {Search,X,Focus,ArrowUpRight,ArrowLeft,Network,HelpCircle,ChevronDown,Check,Compass,Layers,GitBranch} from 'lucide-react';
import gsap from 'gsap';
import {useGSAP} from '@gsap/react';
import {AccumulationScene,accumulationIcons,type AccumulationNode as Node,type AccumulationData as Data} from './AccumulationScene';
import {collectionGroups,overviewView,networkView,detailGroups,otherEnd,relationDescription} from './accumulation-network.mjs';
import {kinds} from './accumulation-data.mjs';
import {SourceText} from './SourceText';
import {localizeText} from '../lib/i18n';
import './accumulation.css';

const coreNode = (node:Node) => ['memory','sop','capability','experience'].includes(node.kind);
function Mark({node}:{node:Node}) {
  const Icon=accumulationIcons[node.kind];
  return <span className="ac-map-mark" style={{color:kinds[node.kind].color,background:kinds[node.kind].tint}}><Icon size={20}/></span>;
}
function Pick({data,focus,onCenter}:{data:Data;focus:string|null;onCenter:(id:string)=>void}) {
  const [open,setOpen]=useState(false),[query,setQuery]=useState('');
  const matches=data.nodes.filter(n=>(n.title+' '+n.summary+' '+localizeText(kinds[n.kind].label)).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <Popover.Root open={open} onOpenChange={value=>{setOpen(value);setQuery('');}}>
    <Popover.Trigger className="ac-map-picker" aria-label="选择要探索的内容"><Search size={17}/><strong>{focus&&data.byId[focus]?<SourceText>{data.byId[focus].title}</SourceText>:'找一项积累或记录'}</strong><ChevronDown size={16}/></Popover.Trigger>
    <Popover.Portal><Popover.Content className="ac-map-picker-menu" sideOffset={8} align="start" collisionPadding={20}>
      <label><Search size={17}/><input placeholder="搜索名称或类型" aria-label="搜索积累或记录" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <div className="ac-map-picker-results">{matches.map(n=><button key={n.id} onClick={()=>{onCenter(n.id);setOpen(false);}}><Mark node={n}/><span><SourceText>{n.title}</SourceText><small>{kinds[n.kind].label}</small></span>{focus===n.id&&<Check size={16}/>}</button>)}{!matches.length&&<p>没有找到匹配内容</p>}</div>
      <small>{matches.length} 项内容</small>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
function Scroll({reduced,children}:{reduced:boolean;children:ReactNode}) {
  return reduced?<div className="ac-map-side-scroll">{children}</div>:<ReactLenis className="ac-map-side-scroll" options={{autoRaf:true,lerp:.13,overscroll:false}}>{children}</ReactLenis>;
}
function Sources({data,counts,onSelect}:{data:Data;counts:Record<string,number>;onSelect:(id:string)=>void}) {
  const [open,setOpen]=useState(false);
  const sources=data.nodes.filter(n=>counts[n.id]>=2).sort((a,b)=>counts[b.id]-counts[a.id]||a.id.localeCompare(b.id,undefined,{numeric:true}));
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="ac-sources-trigger"><GitBranch size={16}/>共同来源<span>{sources.length}</span><ChevronDown size={14}/></Popover.Trigger>
    <Popover.Portal><Popover.Content className="ac-map-picker-menu ac-sources-menu" sideOffset={8} align="end" collisionPadding={20}>
      <header><GitBranch size={18}/><strong>共同来源</strong></header><p>两项或更多积累以它为来源。点开可查看具体联系。</p>
      <div className="ac-map-picker-results">{sources.map(n=><button key={n.id} onClick={()=>{onSelect(n.id);setOpen(false);}}><Mark node={n}/><span><SourceText>{n.title}</SourceText><small>{counts[n.id]} 项积累以它为来源</small></span><ArrowUpRight size={16}/></button>)}{!sources.length&&<p>现有记录还没有显示共同来源，不代表积累没有关联。</p>}</div>
      <small>只在任务中用过，不算共同来源。</small>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
function Detail({data,node,sourceCount,onSelect,onCenter,onOpenList,reduced}:{data:Data;node:Node;sourceCount:number;onSelect:(id:string|null)=>void;onCenter:(id:string)=>void;onOpenList:(node:Node)=>void;reduced:boolean}) {
  const root=useRef<HTMLElement>(null),edges=data.adjacent(node.id);
  useGSAP(()=>{if(!reduced)gsap.fromTo(root.current,{opacity:.45,x:18},{opacity:1,x:0,duration:.22,clearProps:'transform'});},{scope:root,dependencies:[node.id,reduced],revertOnUpdate:true});
  const groups:{label:string;edges:any[];primary?:boolean}[]=detailGroups(data,node);
  return <section className="ac-map-detail" ref={root} aria-label="所选条目详情"><div className="ac-map-detail-top"><span><Mark node={node}/>{kinds[node.kind].label}</span><button aria-label="关闭地图详情" onClick={()=>onSelect(null)}><X size={18}/></button></div>
    <Scroll reduced={reduced}><h2><SourceText>{node.title}</SourceText></h2>{sourceCount>=2&&<p className="ac-source-note"><GitBranch size={16}/><span>共同来源 · {sourceCount} 项积累</span></p>}<p className="ac-map-summary"><SourceText>{node.summary}</SourceText></p>
      {coreNode(node)?<button className="text-button ac-map-jump" onClick={()=>onOpenList(node)}>跳转到列表<ArrowUpRight size={16}/></button>:node.entry&&<button className="text-button ac-map-jump" onClick={()=>{location.hash=node.kind==='learning'?'growth':'workshop';}}>{node.kind==='learning'?'到待办与成长查看':'到 Skill 工坊查看'}<ArrowUpRight size={16}/></button>}
      <button className="ac-map-recenter" onClick={()=>onCenter(node.id)}><Focus size={16}/>围绕它看关联</button>
      {groups.map(group=>{const matches=group.edges;if(!matches.length&&!group.primary)return null;return <div className="ac-map-relations" key={group.label}><h3>{group.label}<small>{matches.length}</small></h3>{!matches.length&&<p className="ac-map-muted">还没有相关任务记录，不代表这项积累不能使用。</p>}{matches.map(edge=>{const other=data.byId[otherEnd(edge,node.id)];return <button className="ac-map-relation" key={edge.id} onClick={()=>onSelect(other.id)}><Mark node={other}/><span><strong><SourceText>{other.title}</SourceText></strong><small>{relationDescription(edge,node.id)}</small></span><ArrowUpRight size={15}/></button>;})}</div>;})}
    </Scroll><footer>{edges.length} 条已记录关联</footer>
  </section>;
}

export default function AccumulationMap({data,selected,onSelect,onOpenList,reduced,paused=false}:{data:Data;selected:string|null;onSelect:(id:string|null)=>void;onOpenList:(node:Node)=>void;reduced:boolean;paused?:boolean}) {
  const groups=useMemo(()=>collectionGroups(data),[data]);
  const [view,setView]=useState(selected?'network':'overview'),[focus,setFocus]=useState<string|null>(selected||null),[page,setPage]=useState(0),[stopped,setStopped]=useState(false),[width,setWidth]=useState(1100);
  const explorer=useRef<HTMLElement>(null),picked=selected?data.byId[selected]:null;
  const [returnKey,setReturnKey]=useState(0);
  const currentFocus=focus&&data.byId[focus]?focus:groups[0]?.items[0]?.id||null;
  const compactNetwork=width<830;
  const overview=useMemo(()=>overviewView(data),[data]);
  const network=useMemo(()=>currentFocus?networkView(data,currentFocus,page,compactNetwork?5:7):overview,[data,currentFocus,page,compactNetwork,overview]);
  const model=view==='overview'?overview:network;
  useEffect(()=>{const el=explorer.current;if(!el)return;const observer=new ResizeObserver(()=>setWidth(el.clientWidth));observer.observe(el);return()=>observer.disconnect();},[]);
  function center(id:string) {setFocus(id);setView('network');setPage(0);onSelect(null);}
  function chooseView(value:string) {if(value==='network'&&selected)setFocus(selected);setView(value);setPage(0);onSelect(null);}
  function chooseGroup(kind:string) {const first=groups.find((g:any)=>g.kind===kind)?.items[0];if(first)onSelect(first.id);}
  function returnToOverview(){setView('overview');setPage(0);onSelect(null);setReturnKey(value=>value+1);}
  const visibleEdges=model.edges.filter((e:any)=>e.source===model.focus||e.target===model.focus).length;
  return <div className="ac-collection">
    <div className="ac-map-navigation"><Tabs.Root value={view} onValueChange={chooseView}><Tabs.List className="ac-map-view-tabs" aria-label="地图查看方式"><Tabs.Trigger value="overview"><Compass size={18}/>积累总览</Tabs.Trigger><Tabs.Trigger value="network" disabled={!data.nodes.length}><Network size={18}/>探索关联</Tabs.Trigger></Tabs.List></Tabs.Root>
      {(picked||view==='network')&&<button className="ac-map-return" onClick={returnToOverview}><ArrowLeft size={17}/>返回全局</button>}
      <Popover.Root><Popover.Trigger className="ac-map-help" aria-label="地图说明"><HelpCircle size={17}/></Popover.Trigger><Popover.Portal><Popover.Content className="help-bubble" sideOffset={10} collisionPadding={20}><strong>只显示已记录的关系</strong><p>连线来自已有资产的来源、关联和使用记录，不按名称猜测。任务和来源记录以编号展示，不展开原始对话。</p><p>任务与来源记录不计入记忆或能力；查看地图不会修改积累，也不会执行任务。</p><Popover.Arrow className="help-arrow"/></Popover.Content></Popover.Portal></Popover.Root>
    </div>
    <div className={'ac-map-workspace'+(picked?' has-sidebar':'')}><section className="ac-map-explorer" ref={explorer} aria-label="积累地图">
      <div className="ac-map-toolbar"><p><Layers size={18}/>{view==='overview'?<>全部 {data.nodes.length} 项积累与记录</>:'看看它从哪里来，又在哪里用过。'}</p>{data.nodes.length>0&&<div className="ac-map-tools"><Sources data={data} counts={overview.sourceCounts} onSelect={onSelect}/><Pick data={data} focus={selected||(view==='network'?currentFocus:null)} onCenter={onSelect}/></div>}</div>
      {data.nodes.length?<AccumulationScene data={data} model={model} selected={selected} returnKey={returnKey} onSelect={onSelect} onGroup={chooseGroup} reduced={reduced} paused={paused||stopped} onPause={()=>setStopped(!stopped)} onPage={value=>{setPage(value);onSelect(null);}}/>:<div className="ac-map-empty"><Network size={40} strokeWidth={1.3}/><h2>这里还没有积累</h2><p>以后保存的记忆、方法与关联，会显示在这里。</p></div>}
      <footer className="ac-map-footer"><div aria-label="按类型定位条目">{groups.map((group:any)=><button key={group.kind} onClick={()=>chooseGroup(group.kind)}><i style={{background:kinds[group.kind].color}}/>{kinds[group.kind].label}<span>{group.items.length}</span></button>)}</div>{view==='network'&&data.nodes.length>0&&<span>{visibleEdges} / {model.total} 条直接联系</span>}</footer>
      {(data.skipped>0||data.partial)&&<p className="ac-map-partial" role="status">部分关联暂未显示，积累内容仍可从列表查看。</p>}
    </section><aside className="ac-map-side">{picked&&<Detail data={data} node={picked} sourceCount={overview.sourceCounts[picked.id]||0} onSelect={onSelect} onCenter={center} onOpenList={onOpenList} reduced={reduced}/>}</aside></div>
  </div>;
}
