import React,{Component,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowUpRight,ArrowRight,HelpCircle,Pause,Play,Settings} from 'lucide-react';
import gsap from 'gsap';
import {useGSAP} from '@gsap/react';
import LibraryPage from './LibraryPage';
import Workshop from './Workshop';
import Growth from './Growth';
import Transfer from './Transfer';
import Onboarding from './Onboarding';
import Status from './Status';
import UsageGuide from './UsageGuide';
import {LocaleRoot,useDashboardLocale} from '../lib/i18n';
import {type Ask,type Request,RequestDialog,useReducedMotion} from './shared';
import KnowledgeBag from './KnowledgeBag';

import './pages.css';
import {ClientProvider,useClient} from './client-state';
import blueTvIcon from './assets/ai-carry-tv-blue.png';
gsap.registerPlugin(useGSAP);
const routes=[{id:'home',label:'总览'},{id:'library',label:'我的积累'},{id:'workshop',label:'Skill 工坊'},{id:'growth',label:'待办与成长'},{id:'transfer',label:'迁移与安全'}];
type Route='home'|'library'|'workshop'|'growth'|'transfer'|'system'|'create'|'status';
function readRoute():Route{const name=location.hash.slice(1).split('?')[0];return [...routes.map(r=>r.id),'system','create','status'].includes(name)?name as Route:'home';}
function Home({go,active}:{go:(r:Route)=>void;active:boolean}){
  const {assistant}=useClient();
  const root=useRef<HTMLDivElement>(null),timeline=useRef<gsap.core.Timeline|null>(null),enabled=useRef(active),reduced=useReducedMotion();
  enabled.current=active;
  useEffect(()=>{const sync=()=>timeline.current?.paused(!enabled.current||document.hidden);sync();document.addEventListener('visibilitychange',sync);return()=>document.removeEventListener('visibilitychange',sync);},[active]);
  useGSAP(()=>{if(reduced)return;const tl=gsap.timeline({paused:!enabled.current||document.hidden});timeline.current=tl;tl.from('.ribbon-heading .line',{yPercent:105,rotation:3,stagger:.12,duration:1.2,ease:'power4.out'},.1).from('.ribbon-lead,.ribbon-create',{y:25,autoAlpha:0,duration:.7,stagger:.1},.7).from('.ribbon-links button',{x:-28,autoAlpha:0,duration:.7,stagger:.12},1.4);return()=>{tl.kill();timeline.current=null;};},{scope:root,dependencies:[reduced],revertOnUpdate:true});
  return <main className="home-scroll"><div ref={root} className="home-composition home-composition--carry"><KnowledgeBag active={active}/><section className="ribbon-intro"><p className="ribbon-eyebrow"><span/>AI Carry · 随身助手</p><h1 className="ribbon-heading"><span className="line-mask"><span className="line">让你的积累</span></span><span className="line-mask"><span className="line"><span className="you">一直待在你身边。</span></span></span></h1><p className="ribbon-lead">AI Carry 保存你的习惯、记忆和常用方法。<br/>换用其他 Agent，这些积累也能带过去。</p><button className="ribbon-create" onClick={()=>go(assistant?.snapshot.meta.state==='instance'?'library':'create')}>{assistant?.snapshot.meta.state==='instance'?'查看我的积累':'创建我的助手'}<span><ArrowUpRight size={23}/></span></button><p className="ribbon-start-note">{assistant?assistant.snapshot.profile.display_name:'先选使用经验，再选助手方向。'}</p></section><nav className="ribbon-links" aria-label="从总览进入功能"><button onClick={()=>go('library')}>我的积累<ArrowUpRight size={17}/></button><button onClick={()=>go('workshop')}>Skill 工坊<ArrowUpRight size={17}/></button><button onClick={()=>go('transfer')}>换一个 Agent<ArrowUpRight size={17}/></button></nav><footer className="ribbon-footer"><span>属于你的方法，跟着你走。</span><span>字体：MiSans · Xiaomi</span></footer></div></main>;
}
class PageBoundary extends Component<{children:React.ReactNode;go:()=>void},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return{failed:true};}render(){return this.state.failed?<div className="local-page-error"><h1>这一页没能打开</h1><p>助手资料还在。可以先用其他页面，再回来重试。</p><button className="primary-button" onClick={this.props.go}>返回总览<ArrowRight size={18}/></button></div>:this.props.children;}}
function App(){
  const {locale,setLocale}=useDashboardLocale();
  const {assistant,demo,source,dataLoading}=useClient();
  const ask:Ask=request=>setRequest({...request,assistant:route==='create'&&assistant?.snapshot.meta.state!=='template'?undefined:source(request.itemId)});
  const [route,setRoute]=useState<Route>(readRoute),[request,setRequest]=useState<Request|null>(null),[paused,setPaused]=useState(false),reduced=useReducedMotion();
  useEffect(()=>{const update=()=>{setRoute(readRoute());setRequest(null);};addEventListener('hashchange',update);return()=>removeEventListener('hashchange',update);},[]);
  const go=(r:Route)=>{if(location.hash===`#${r}`)setRoute(r);else location.hash=r;};
  const homeRoute=route==='home';
  return <div className="client-app">
    <header className="topbar">
      <a className="wordmark" href="#home" aria-label="AI Carry 总览"><img className="brand-icon" src={blueTvIcon} width={40} height={40} alt="" draggable={false}/><span>AI Carry<span className="brand-dot">.</span></span></a>
      <nav className="top-sections" aria-label="主要页面">{routes.map(r=>{const current=route===r.id||(r.id==='home'&&homeRoute);return <a href={`#${r.id}`} key={r.id} className={current?'current':''} aria-current={current?'page':undefined}>{r.label}</a>;})}</nav>
      <div className="top-tools"><button className="top-icon" onClick={()=>setLocale(locale==='en'?'zh-Hans':'en')} title="中文 / English">{locale==='en'?'中':'EN'}</button>
        {demo?<span className="demo-badge" title="当前窗口展示虚构示例，不会修改你的助手">演示数据</span>:<span className="preview-label">{dataLoading?'正在读取资料':assistant?'本地资料 · 只读查看':(window.carryClient?'本地客户端':'本地网页版')}</span>}
        {homeRoute&&<button className="top-icon" onClick={()=>setPaused(!paused)} disabled={reduced} aria-label={reduced?'系统已减少动态':paused?'播放首屏动效':'暂停首屏动效'} title={reduced?'系统已减少动态':paused?'播放首屏动效':'暂停首屏动效'}>{paused||reduced?<Play size={17}/>:<Pause size={17}/>}</button>}
        <button className="top-icon" onClick={()=>go('status')} aria-label="助手设置" title="助手设置"><Settings size={18}/></button><button className="manual-help" onClick={()=>go('system')} title="查看如何使用客户端"><HelpCircle size={18}/><span>使用说明</span></button>
      </div>
    </header>
    <div className="client-body"><PageBoundary key={route} go={()=>go('home')}>
      {route==='home'?<Home go={go} active={!paused&&!reduced}/>:route==='library'?<div className="library-embed"><LibraryPage ask={ask}/></div>:route==='workshop'?<Workshop ask={ask}/>:route==='growth'?<Growth ask={ask}/>:route==='transfer'?<Transfer ask={ask}/>:route==='create'?<Onboarding ask={ask} home={()=>go('home')}/>:route==='status'?<Status ask={ask}/>:<UsageGuide home={()=>go('home')}/>}
    </PageBoundary></div>
    <RequestDialog request={request} onClose={()=>setRequest(null)}/>
  </div>;
}
createRoot(document.getElementById('root')!).render(<LocaleRoot>{locale=><ClientProvider key={locale}><App/></ClientProvider>}</LocaleRoot>);
