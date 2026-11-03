import {SourceText} from './SourceText';
import React,{useEffect,useId,useRef,useState} from 'react';
import {Collapsible,Dialog,RadioGroup,Tabs} from 'radix-ui';
import {ArrowRight,Check,ChevronDown,Copy,FileText,LoaderCircle,ShieldCheck,X} from 'lucide-react';
import gsap from 'gsap';
import {useGSAP} from '@gsap/react';
import Lenis from 'lenis';
import {Help,useReducedMotion} from './LibraryPage';
import {type AssistantSource,useClient} from './client-state';
import {localizeAgentRequest} from '../lib/i18n';
import {manualRequest} from './manual-request.mjs';
import './manual-requests.css';
export {Help,useReducedMotion};
export type SummaryLine={label:string;value:string;source?:boolean};
export type Request={actionId?:string;title:string;body:string;itemId?:string;assistant?:AssistantSource;preferredDestination?:'current'|'new';operation?:{action:string;selection:Record<string,string>};summary?:SummaryLine[];impact?:string};
export type Ask=(request:Request)=>void;

export function AssistantNotice(){
  const {assistant,demo,dataLoading,dataError,refreshData,chooseAssistant}=useClient();
  if(demo)return <div className="data-notice is-demo" role="status">示例资料 · 操作不会修改真实助手。</div>;
  if(dataError)return <div className="data-notice is-error" role="status"><div><strong>{assistant?'暂未读到新资料':'资料暂时没有读到'}</strong><p>{dataError}</p>{assistant&&<small>仍可查看上次读取的内容。</small>}</div><div className="notice-actions"><button className="secondary-button" disabled={dataLoading} onClick={()=>void refreshData()}>{dataLoading?'正在读取…':'重新读取'}</button><Help label="读取失败怎么办？">先重新读取。仍然失败时，在“设置”中预览重新生成看板的请求；客户端也可以重新选择助手文件夹。已有资料不要删除或重新创建。</Help></div></div>;
  if(dataLoading&&!assistant)return <div className="data-notice" role="status"><LoaderCircle size={18} className="spin"/>正在读取资料…</div>;
  if(!assistant)return <div className="data-notice"><div><strong>{window.carryClient?'选择要查看的助手':'这里没有读到助手资料'}</strong><p>{window.carryClient?'打开已有助手文件夹，继续查看积累。':'请打开这份助手自己的网页入口，或让 Agent 重新生成看板。'}</p></div>{window.carryClient&&<button className="primary-button" onClick={()=>void chooseAssistant()}>选择助手文件夹<ArrowRight size={17}/></button>}</div>;
  if(assistant.snapshot.health)return <div className="data-notice is-warning" role="status"><div><strong>{assistant.snapshot.health.summary}</strong><details><summary>查看处理方法</summary><p>{assistant.snapshot.health.next_step}</p></details></div><button className="secondary-button" disabled={dataLoading} onClick={()=>void refreshData()}>重新读取</button></div>;
  return null;
}
export function Page({children}:{children:React.ReactNode}){
  const wrapper=useRef<HTMLElement>(null),content=useRef<HTMLDivElement>(null),reduced=useReducedMotion();
  useEffect(()=>{if(!wrapper.current||!content.current)return;const scroll=new Lenis({wrapper:wrapper.current,content:content.current,smoothWheel:!reduced,duration:.6});const tick=(time:number)=>scroll.raf(time*1000);gsap.ticker.add(tick);return()=>{gsap.ticker.remove(tick);scroll.destroy();};},[reduced]);
  return <main id="main-content" ref={wrapper} className="page-scroll" tabIndex={-1}><div className="page-content" ref={content}>{children}</div></main>;
}
export function Heading({title,accent='',children,action}:{title:string;accent?:string;children?:React.ReactNode;action?:React.ReactNode}){return <header className="page-heading"><div><h1>{title}{accent}</h1>{children&&<p className="page-purpose">{children}</p>}</div>{action}</header>;}
export function SectionTabs({value,onChange,items,label}:{value:string;onChange:(v:string)=>void;items:{id:string;label:string}[];label:string}){return <Tabs.Root value={value} onValueChange={onChange}><Tabs.List className="section-tabs" aria-label={label}>{items.map(i=><Tabs.Trigger key={i.id} value={i.id}>{i.label}</Tabs.Trigger>)}</Tabs.List></Tabs.Root>;}
export function Primary({children,onClick,disabled=false}:{children:React.ReactNode;onClick:()=>void;disabled?:boolean}){return <button className="primary-button" disabled={disabled} onClick={onClick}>{children}<ArrowRight size={17}/></button>;}
export function Summary({rows}:{rows:SummaryLine[]}){return <dl className="flow-summary">{rows.map(row=><div key={row.label}><dt>{row.label}</dt><dd>{row.source?<SourceText>{row.value}</SourceText>:row.value}</dd></div>)}</dl>;}
export function Disclosure({title,note,children,open:controlled,onOpenChange}:{title:string;note?:string;children:React.ReactNode;open?:boolean;onOpenChange?:(value:boolean)=>void}){
  const [local,setLocal]=useState(false),open=controlled??local,box=useRef<HTMLDivElement>(null),reduced=useReducedMotion();
  useGSAP(()=>{const el=box.current;if(!el)return;el.inert=!open;gsap.to(el,{height:open?'auto':0,opacity:open?1:0,duration:reduced?0:.3,ease:'power2.inOut',overwrite:true});},{scope:box,dependencies:[open,reduced]});
  return <Collapsible.Root className="disclosure" open={open} onOpenChange={value=>{setLocal(value);onOpenChange?.(value);}}><Collapsible.Trigger className="disclosure-trigger"><span>{title}</span>{note&&<small>{note}</small>}<ChevronDown size={17}/></Collapsible.Trigger><Collapsible.Content ref={box} forceMount className="disclosure-expand" aria-hidden={!open} style={{height:0,opacity:0}}><div className="disclosure-content">{children}</div></Collapsible.Content></Collapsible.Root>;
}
export function More({title='查看补充说明',children}:{title?:string;children:React.ReactNode}){return <Disclosure title={title}>{children}</Disclosure>;}
export function Choice({value,onChange,choices,label}:{value:string;onChange:(s:string)=>void;choices:{id:string;title:string;detail?:string;icon?:React.ElementType}[];label:string}){return <RadioGroup.Root value={value} onValueChange={onChange} aria-label={label} className="flow-choices">{choices.map(c=><RadioGroup.Item key={c.id} value={c.id} className="flow-choice">{c.icon&&<c.icon size={22}/>}<span><strong>{c.title}</strong>{c.detail&&<small>{c.detail}</small>}</span><span className="choice-dot"><RadioGroup.Indicator/></span></RadioGroup.Item>)}</RadioGroup.Root>;}
export function FlowCard({children,footer,className=''}:{children:React.ReactNode;footer:React.ReactNode;className?:string}){return <section className={'flow-card '+className}><div className="flow-body" data-lenis-prevent>{children}</div><footer className="flow-actions">{footer}</footer></section>;}
export function Consequence({children,caution=false}:{children:React.ReactNode;caution?:boolean}){return <div className={'flow-consequence'+(caution?' is-caution':'')}><ShieldCheck size={18}/><p>{children}</p></div>;}
export function Reveal({children,kind='detail',direction=1,className=''}:{children:React.ReactNode;kind?:'detail'|'step'|'selection';direction?:number;className?:string}){
  const root=useRef<HTMLDivElement>(null),reduced=useReducedMotion();
  useGSAP(()=>{if(reduced)return;if(kind==='step')gsap.from(root.current,{x:direction*30,opacity:.1,duration:.36,ease:'power3.out',clearProps:'all'});else if(kind==='selection')gsap.from(root.current,{y:12,opacity:.2,duration:.3,ease:'power3.out',clearProps:'all'});else gsap.timeline().from(root.current,{height:0,opacity:.2,duration:.32,ease:'power3.inOut',clearProps:'height,opacity'}).from('.reveal-item',{y:10,opacity:.1,duration:.24,stagger:.04,clearProps:'all'},.12);},{scope:root,dependencies:[reduced],revertOnUpdate:true});
  return <div className={'reveal '+className} ref={root} data-motion={kind}>{children}</div>;
}
export function RequestDialog({request,onClose}:{request:Request|null;onClose:()=>void}){
  const {act,demo}=useClient();
  const [expanded,setExpanded]=useState(false),[extraOpen,setExtraOpen]=useState(false),[extra,setExtra]=useState(''),[copied,setCopied]=useState(false),[copyError,setCopyError]=useState(''),[busy,setBusy]=useState(false);
  const serial=useRef(0),text=useRef<HTMLTextAreaElement>(null),restore=useRef<HTMLElement|null>(null),drafts=useRef(new Map<string,string>()),activeKey=useRef(''),bodyId=useId();
  useEffect(()=>{serial.current++;setExpanded(false);setExtraOpen(false);setCopied(false);setCopyError('');setBusy(false);if(request){activeKey.current=JSON.stringify([request.assistant?.root,request.assistant?.instanceId,request.itemId,request.title,request.body]);setExtra(drafts.current.get(activeKey.current)||'');}return()=>{serial.current++;};},[request]);
  const body=request?(demo?'这是界面演示用的虚构请求，仅用于查看操作方式；不要把示例条目当作真实资料。\n\n':'')+localizeAgentRequest(manualRequest(request,extra)):'';
  const editExtra=(value:string)=>{serial.current++;setExtra(value);drafts.current.set(activeKey.current,value);if(drafts.current.size>30)drafts.current.delete(drafts.current.keys().next().value!);setCopied(false);setBusy(false);setCopyError('');};
  const copy=async()=>{if(busy)return;const current=++serial.current;setBusy(true);setCopied(false);setCopyError('');let timer:ReturnType<typeof setTimeout>|undefined,timedOut=false;
    try{await Promise.race([act('copy',{text:body}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new Error('copy-not-confirmed'));},4000);})]);if(current===serial.current)setCopied(true);}
    catch{if(current===serial.current){setExpanded(true);setCopyError(timedOut?'暂时无法确认是否复制成功。请选中全文，手动复制。':'没能自动复制。请选中全文，手动复制。');}}
    finally{clearTimeout(timer);if(current===serial.current)setBusy(false);}
  };
  return <Dialog.Root open={!!request} onOpenChange={v=>{if(!v)onClose();}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="request-dialog integrated-request" data-lenis-prevent onOpenAutoFocus={()=>{restore.current=document.activeElement as HTMLElement;}} onCloseAutoFocus={e=>{if(restore.current?.isConnected){e.preventDefault();restore.current.focus();}}}>
    <header className="request-head"><div><Dialog.Title>{request?.title}</Dialog.Title><Dialog.Description>{demo?'示例请求，仅用于体验操作。':'核对后，复制到 Agent 对话并发送。'}</Dialog.Description></div><Dialog.Close className="icon-control" aria-label="关闭请求预览"><X size={20}/></Dialog.Close></header>
    <div className="request-body"><div className="request-target"><span className="document-mark"><FileText size={23}/></span><div><small>本次处理</small><strong>{request?.assistant?.name?<SourceText>{request.assistant.name}</SourceText>:'当前助手'}</strong></div></div>
    {request?.summary?.length?<Summary rows={request.summary}/>:<Summary rows={[{label:'操作',value:request?.title||''}]}/>}
    <Consequence caution={!!request?.assistant?.entryMismatch}>{request?.assistant?.entryMismatch?'入口与资料标识不一致，请先核对助手目录和实例。':request?.impact||'先核对当前资料，再由 Agent 按本次授权处理。'}</Consequence>
    {request?.preferredDestination==='new'&&<p className="request-hint">可以在 Agent 中另开对话处理。</p>}{copyError&&<p className="copy-feedback copy-failed" role="status">{copyError}</p>}
    <Disclosure title={expanded?'收起完整请求':'查看完整请求'} open={expanded} onOpenChange={setExpanded}><textarea ref={text} id={bodyId} aria-label="完整请求" className="full-request-text" readOnly value={body}/><button className="secondary-button select-request" onClick={()=>{text.current?.focus();text.current?.select();}}>选中全文</button></Disclosure>
    <Disclosure title="补充要求" note={extra.trim()?'已填写':'选填'} open={extraOpen} onOpenChange={setExtraOpen}><label className="field"><span className="sr-only">补充要求</span><textarea value={extra} onChange={e=>editExtra(e.target.value)} rows={3} placeholder="例如：输出格式或保存位置。" maxLength={4000}/></label></Disclosure>
    {!extraOpen&&extra.trim()&&<p className="extra-summary"><SourceText>{extra}</SourceText></p>}</div>
    <footer className="request-footer"><p className={'copy-feedback'+(copied?' copy-success':'')} role="status">{copyError?'原请求已保留。':copied?(demo?'演示请求已复制，未执行任务。':'已复制。请粘贴到 Agent 对话并发送。'):'复制不会执行操作；结果在原对话查看。'}</p><button className="secondary-button" onClick={onClose}>返回</button><button className="primary-button" disabled={busy} onClick={()=>void copy()}>{copied?<Check size={17}/>:busy?<LoaderCircle size={17} className="spin"/>:<Copy size={17}/>}<span>{copied?'再次复制':busy?'正在复制…':demo?'复制演示请求':'复制请求'}</span></button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
