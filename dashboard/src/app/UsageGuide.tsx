import {useId,useRef} from 'react';
import {ArrowRight,Check,Copy,FileText,MousePointer2,RefreshCw,Send} from 'lucide-react';
import gsap from 'gsap';
import {useGSAP} from '@gsap/react';
import {Heading,Help,Page,Primary,useReducedMotion} from './shared';
import blueTvIcon from './assets/ai-carry-tv-blue.png';
import './usage-guide.css';

// These are illustrations of the manual workflow, not live task controls.
function ChooseScene(){
  return <div className="guide-scene guide-scene--choose" aria-hidden="true">
    <div className="guide-scene-ground"/>
    <div className="guide-mini-client">
      <div className="guide-window-bar"><i/><i/><i/><span>AI Carry</span></div>
      <div className="guide-mini-content">
        <div className="guide-mini-line guide-mini-line--heading"/>
        <div className="guide-mini-line"/>
        <div className="guide-feature"><span className="guide-feature-mark"><FileText size={23}/></span><span>整理 Skill</span><ArrowRight size={18}/></div>
        <div className="guide-mini-line guide-mini-line--short"/>
      </div>
      <MousePointer2 className="guide-click-cursor" size={39} strokeWidth={1.6}/>
      <svg className="guide-click-rays" viewBox="0 0 54 54"><path d="M12 16 5 11M21 10 19 2M9 27 1 29"/></svg>
    </div>
    <img className="guide-tv" src={blueTvIcon} alt="" width={88} height={88} draggable={false}/>
  </div>;
}

function SendScene(){
  return <div className="guide-scene guide-scene--send" aria-hidden="true">
    <div className="guide-scene-ground"/>
    <div className="guide-request-paper">
      <span className="guide-paper-title">准备好的请求</span>
      <div className="guide-mini-line"/><div className="guide-mini-line"/><div className="guide-mini-line guide-mini-line--short"/>
      <span className="guide-copy-label"><Copy size={17}/>复制请求</span>
    </div>
    <div className="guide-agent-chat">
      <div className="guide-chat-title"><span className="guide-chat-dot"/>你想用的 Agent</div>
      <div className="guide-pasted-request"><span>粘贴请求</span><div className="guide-mini-line"/><div className="guide-mini-line guide-mini-line--short"/></div>
      <span className="guide-send-label">发送<Send size={17}/></span>
    </div>
  </div>;
}

function ResultScene(){
  return <div className="guide-scene guide-scene--result" aria-hidden="true">
    <div className="guide-scene-ground"/>
    <div className="guide-result-reply">
      <span className="guide-result-label">Agent 的回复</span>
      <div className="guide-reply-line"><Check size={18}/><div className="guide-mini-line"/></div>
      <div className="guide-reply-line"><Check size={18}/><div className="guide-mini-line guide-mini-line--short"/></div>
      <div className="guide-reply-line"><Check size={18}/><div className="guide-mini-line"/></div>
    </div>
    <div className="guide-result-file"><FileText size={34} strokeWidth={1.4}/><span>文件与结果</span><i><Check size={17}/></i></div>
    <svg className="guide-result-spark" viewBox="0 0 55 52"><path d="m25 3 2 12M45 14l-10 8M49 34l-12-2M11 39l6-9"/></svg>
  </div>;
}

function CrayonArrow({second=false}:{second?:boolean}){
  const texture=useId().replace(/:/g,'');
  const shaft=second?'M9 33 C46 88 112 90 157 46':'M9 81 C43 24 102 19 157 54';
  const tip=second?'M130 44 L161 42 L151 72':'M137 29 L161 57 L125 64';
  return <svg className={`guide-arrow ${second?'guide-arrow--second':''}`} viewBox="0 0 180 115" aria-hidden="true">
    <defs><filter id={texture} x="-10%" y="-15%" width="120%" height="130%">
      <feTurbulence type="fractalNoise" baseFrequency=".72" numOctaves="2" seed={second?17:8} result="grain"/>
      <feColorMatrix in="grain" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  2.4 0 0 0 -.35" result="crayon"/>
      <feComposite in="SourceGraphic" in2="crayon" operator="in"/>
    </filter></defs>
    <g fill="none" strokeLinecap="round" strokeLinejoin="round" filter={`url(#${texture})`}>
      <path className="guide-draw-stroke" d={shaft} stroke="#3467de" strokeWidth="8"/>
      <path className="guide-draw-stroke guide-arrow-tip" d={tip} stroke="#3467de" strokeWidth="8"/>
    </g>
  </svg>;
}

export default function UsageGuide({home}:{home:()=>void}){
  const root=useRef<HTMLElement>(null),reduced=useReducedMotion();
  useGSAP(()=>{
    if(reduced||!root.current)return;
    const scope=root.current;
    const timeline=gsap.timeline({id:'usage-guide-entrance'});
    // Text and real controls remain available throughout. Only the drawings move.
    timeline.from('.guide-mini-client',{y:15,rotation:-7,opacity:.25,duration:.5,ease:'power2.out'},0)
      .from('.guide-click-cursor',{x:22,y:22,opacity:0,duration:.5,ease:'power2.out'},.12)
      .fromTo('.guide-click-rays',{opacity:0},{opacity:1,duration:.15,repeat:1,yoyo:true},.57);
    scope.querySelectorAll<SVGSVGElement>('.guide-arrow').forEach((arrow,index)=>{
      arrow.querySelectorAll<SVGPathElement>('.guide-draw-stroke').forEach((path,part)=>{
        const length=path.getTotalLength();
        timeline.fromTo(path,{strokeDasharray:length+1,strokeDashoffset:length+1},{strokeDashoffset:0,duration:part ? .28 : .62,ease:'power1.inOut'},.62+index*1.06+(part ? .46 : 0));
      });
    });
    timeline.from('.guide-request-paper',{x:-12,y:14,rotation:-12,opacity:.2,duration:.48,ease:'power2.out'},.85)
      .from('.guide-pasted-request',{y:15,scale:.94,opacity:0,duration:.48,ease:'power2.out'},1.15)
      .from('.guide-send-label',{scale:.8,opacity:0,duration:.3,ease:'back.out(1.5)'},1.5)
      .from('.guide-result-reply',{y:18,opacity:0,duration:.48,ease:'power2.out'},1.9)
      .from('.guide-result-file',{y:24,rotation:9,scale:.94,opacity:0,duration:.55,ease:'back.out(1.2)'},2.12);
    const visibility=()=>document.hidden?timeline.pause():timeline.resume();
    document.addEventListener('visibilitychange',visibility);visibility();
    return()=>document.removeEventListener('visibilitychange',visibility);
  },{scope:root,dependencies:[reduced],revertOnUpdate:true});

  return <Page><section ref={root} className="usage-guide" aria-label="客户端使用说明">
    <Heading title="在这里选，" accent="交给 Agent 做。">不用连接 Agent。复制请求，发到你想用的对话里。</Heading>
    <ol className="guide-steps">
      <li className="guide-step">
        <ChooseScene/><CrayonArrow/>
        <div className="guide-step-heading"><span className="guide-number">1</span><h2>选一件事</h2><Help label="怎么选择要做的事？">点击客户端中的功能按钮，例如创建助手或整理 Skill，就会打开请求预览。你可以先看内容，也可以补充自己的要求。</Help></div>
        <p>点击功能按钮，预览准备好的请求。</p>
      </li>
      <li className="guide-step">
        <SendScene/><CrayonArrow second/>
        <div className="guide-step-heading"><span className="guide-number">2</span><h2>复制，发给 Agent</h2><Help label="复制后发到哪里？">点击“复制请求”，切换到你想用的 Agent，把请求粘贴到对话框里，再点击发送。客户端不会替你发送；独立的任务也可以另开对话处理。</Help></div>
        <p>复制请求，在 Agent 对话里粘贴并发送。</p>
      </li>
      <li className="guide-step">
        <ResultScene/>
        <div className="guide-step-heading"><span className="guide-number">3</span><h2>在 Agent 看结果</h2><Help label="在哪里看回复和文件？">在你发送请求的 Agent 对话里查看回复和文件位置，也可以继续提问或修改。客户端不会接收这段对话；如果助手资料有更新，再回客户端重新读取。</Help></div>
        <p>在同一段对话里查看回复、文件和下一步。</p>
      </li>
    </ol>
    <div className="guide-ending">
      <div className="guide-refresh-note"><RefreshCw size={18}/><span>助手资料更新后，回客户端重新读取。</span><Help label="怎样更新客户端显示的资料？">回到“我的积累”等资料页面，点击“重新读取”。这里会展示 Agent 已经保存到助手文件夹的内容；重新读取不会替你执行任务。</Help></div>
      <Primary onClick={home}>去选一件事</Primary>
    </div>
  </section></Page>;
}
