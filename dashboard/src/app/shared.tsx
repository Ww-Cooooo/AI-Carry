import {SourceText} from './SourceText';
import React,{useEffect,useRef,useState} from 'react';
import {Dialog,Tabs} from 'radix-ui';
import {ArrowUpRight,Check,Copy,MessageCircle,X} from 'lucide-react';
import gsap from 'gsap';
import {useGSAP} from '@gsap/react';
import Lenis from 'lenis';
import {BrandStroke,Help,useReducedMotion} from './LibraryPage';
import {type AssistantSource,useClient} from './client-state';
import {localizeAgentRequest} from '../lib/i18n';
import {manualRequest} from './manual-request.mjs';
import './manual-requests.css';
export {Help,useReducedMotion};
export type Request={actionId?:string;title:string;body:string;itemId?:string;assistant?:AssistantSource;preferredDestination?:'current'|'new';operation?:{action:string;selection:Record<string,string>}};
export type Ask=(request:Request)=>void;

export function AssistantNotice(){
  const {assistant,demo,dataLoading,dataError,refreshData,chooseAssistant}=useClient();
  return <div className="assistant-data-note" role="status"><div><strong>{dataLoading?'正在读取助手资料…':assistant?<SourceText>{assistant.snapshot.profile.display_name}</SourceText>:'还没有选择助手资料'}</strong><span>{demo?'这些是虚构示例，可以点开体验，不会修改你的助手。':dataError||assistant?.snapshot.health?.summary||(assistant?'显示的是这份助手保存在本机的资料。':'先选择 AI Carry 助手文件夹，这里会显示已有资料，不会修改原文件。')}</span>{!demo&&assistant?.snapshot.health&&<details><summary>查看资料提示</summary><p>{assistant.snapshot.health.next_step}</p></details>}{!demo&&assistant?.binding.root&&<details><summary>资料存放位置</summary><p><SourceText>{assistant.binding.root}</SourceText></p></details>}</div>{!demo&&<div className="assistant-data-actions">{(assistant||dataError)&&<button className="text-button" disabled={dataLoading} onClick={()=>void refreshData()}>重新读取</button>}{window.carryClient&&<button className="text-button" disabled={dataLoading} onClick={()=>void chooseAssistant()}>{assistant?'更换文件夹':'选择助手文件夹'}</button>}</div>}</div>;
}

export function Page({children}:{children:React.ReactNode}){
  const wrapper=useRef<HTMLElement>(null),content=useRef<HTMLDivElement>(null),reduced=useReducedMotion();
  useEffect(()=>{if(!wrapper.current||!content.current)return;const scroll=new Lenis({wrapper:wrapper.current,content:content.current,smoothWheel:!reduced,duration:.6});const tick=(time:number)=>scroll.raf(time*1000);gsap.ticker.add(tick);return()=>{gsap.ticker.remove(tick);scroll.destroy();};},[reduced]);
  return <main ref={wrapper} className="page-scroll"><div className="page-content" ref={content}>{children}<footer className="page-footer"><span>执行任务：复制请求，发给 Agent</span><span>字体：MiSans · Xiaomi</span></footer></div></main>;
}
export function Heading({title,accent,children,action}:{title:string;accent:string;children:React.ReactNode;action?:React.ReactNode}){
  const reduced=useReducedMotion();return <div className="page-heading"><div><h1>{title}<span className="marked-word">{accent}<BrandStroke reduced={reduced}/></span></h1><p className="page-purpose">{children}</p></div>{action}</div>;
}
export function SectionTabs({value,onChange,items,label}:{value:string;onChange:(v:string)=>void;items:{id:string;label:string}[];label:string}){
  return <Tabs.Root value={value} onValueChange={onChange}><Tabs.List className="section-tabs" aria-label={label}>{items.map(i=><Tabs.Trigger key={i.id} value={i.id}>{i.label}</Tabs.Trigger>)}</Tabs.List></Tabs.Root>;
}
export function Primary({children,onClick,disabled=false}:{children:React.ReactNode;onClick:()=>void;disabled?:boolean}){return <button className="primary-button" disabled={disabled} onClick={onClick}>{children}<ArrowUpRight size={19}/></button>;}
export function More({title='查看补充说明',children}:{title?:string;children:React.ReactNode}){return <details className="more-info"><summary>{title}</summary><div>{children}</div></details>;}

// Mount motion inside the actual content, including portals. Do not start against absent nodes.
export function Reveal({children,kind='detail',direction=1,className=''}:{children:React.ReactNode;kind?:'detail'|'step'|'selection';direction?:number;className?:string}){
  const root=useRef<HTMLDivElement>(null),reduced=useReducedMotion();
  useGSAP(()=>{if(reduced)return;
    if(kind==='step')gsap.from(root.current,{x:direction*38,opacity:.1,duration:.48,ease:'power3.out',clearProps:'all'});
    else if(kind==='selection')gsap.from(root.current,{y:16,opacity:.2,duration:.48,ease:'power3.out',clearProps:'all'});
    else gsap.timeline().from(root.current,{height:0,opacity:.2,duration:.44,ease:'power3.inOut',clearProps:'height,opacity'}).from('.reveal-item',{y:14,opacity:.1,duration:.36,stagger:.05,clearProps:'all'},.15);
  },{scope:root,dependencies:[reduced],revertOnUpdate:true});
  return <div ref={root} className={`reveal ${className}`} data-motion={kind}>{children}</div>;
}
export function RequestDialog({request,onClose}:{request:Request|null;onClose:()=>void}){
  const {act,demo}=useClient();
  const [expanded,setExpanded]=useState(false),[extra,setExtra]=useState(''),[copied,setCopied]=useState(false),[copyError,setCopyError]=useState(''),[busy,setBusy]=useState(false);
  const serial=useRef(0),text=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{serial.current++;setExpanded(false);setExtra('');setCopied(false);setCopyError('');setBusy(false);},[request]);
  const body=request?(demo?'这是界面演示用的虚构请求，仅用于查看操作方式；不要把示例条目当作真实资料。\n\n':'')+localizeAgentRequest(manualRequest(request,extra)):'';
  const copy=async()=>{
    if(busy)return;const current=serial.current;setBusy(true);
    try{await act('copy',{text:body});if(current===serial.current){setCopied(true);setCopyError('');}}
    catch{if(current===serial.current){setExpanded(true);setCopyError('没能自动复制。请点“选中全文”，手动复制后发给 Agent。');}}
    finally{if(current===serial.current)setBusy(false);}
  };
  return <Dialog.Root open={!!request} onOpenChange={v=>{if(!v)onClose();}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="request-dialog manual-request-dialog" data-lenis-prevent><Dialog.Close className="dialog-close" aria-label="关闭请求预览"><X size={20}/></Dialog.Close><Reveal kind="selection"><span className="request-icon"><MessageCircle size={26}/></span><Dialog.Title>{request?.title}</Dialog.Title><Dialog.Description>{demo?'这里预览的是演示请求，示例条目不对应真实文件。':'点击“复制请求”，粘贴到你想用的 Agent 对话中，再发送。'}</Dialog.Description>
    {request?.preferredDestination==='new'&&<p className="manual-task-hint">这件事可以在 Agent 中另开对话处理，不必打断手头的任务。</p>}
    {copyError&&<p className="copy-feedback copy-failed" role="status">{copyError}</p>}
    <label className="dispatch-extra">补充要求（可选）<textarea value={extra} onChange={e=>{serial.current++;setExtra(e.target.value);setCopied(false);setBusy(false);setCopyError('');}} rows={2} placeholder="还有什么要求？比如内容主题、输出格式或保存位置。" maxLength={4000}/></label>
    <div className="request-copy progressive-copy">{expanded?<textarea ref={text} id="preview-request-body" aria-label="完整请求" className="full-request-text" readOnly value={body}/>:<p id="preview-request-body" className="request-text condensed">{body}</p>}<button className="text-button" aria-expanded={expanded} aria-controls="preview-request-body" onClick={()=>setExpanded(!expanded)}>{expanded?'收起全文':'展开完整请求'}</button>{copyError&&<button className="text-button select-request" onClick={()=>{text.current?.focus();text.current?.select();}}>选中全文</button>}</div>
    <button className="primary-button" disabled={busy} onClick={()=>void copy()}>{copied?'再次复制':busy?'正在复制…':demo?'复制演示请求':'复制请求'}{copied?<Check size={19}/>:<Copy size={19}/>}</button>
    <p className={`copy-feedback ${copied?'copy-success':''}`} role="status">{copyError?'原请求已保留，可以选中全文手动复制。':demo?(copied?'演示请求已复制，没有执行任何任务。':'可查看完整流程；此窗口不会调用 Agent 或修改助手资料。'):(copied?'已复制。粘贴到你想用的 Agent 对话中，再发送。':'复制的是完整请求，折叠的内容也会带上。')}</p>
  </Reveal></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
