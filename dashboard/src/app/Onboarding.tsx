import {useState} from 'react';
import {ArrowLeft,Check,Compass,HelpCircle,MessageCircle,UserRound,BriefcaseBusiness,Zap} from 'lucide-react';
import {type Ask,Help,Page,Primary,Reveal} from './shared';
const experience=[
  {id:'step-by-step',title:'第一次接触 Agent',description:'请一步步讲解，尽量不用术语。',Icon:UserRound},
  {id:'balanced',title:'已经用过一些',description:'把关键步骤讲清楚，必要时再解释。',Icon:MessageCircle},
  {id:'direct',title:'经常使用 Agent',description:'基础操作不用细讲，直接讨论怎么做。',Icon:Zap}
];
const directions=[
  {id:'general',title:'通用个人助手',description:'处理不同事情，记住你的习惯和常用方法。',Icon:Compass},
  {id:'domain',title:'专业领域助手',description:'围绕你的职业或领域，积累更专门的方法。',Icon:BriefcaseBusiness},
  {id:'help-decide',title:'先帮我判断',description:'让 Agent 了解你的需要，再一起选方向。',Icon:HelpCircle}
];
export default function Onboarding({ask,home}:{ask:Ask;home:()=>void}){
  const [step,setStep]=useState(0),[exp,setExp]=useState(''),[direction,setDirection]=useState(''),[movement,setMovement]=useState(1);
  const requestBody=`我想用 AI Carry 创建一个助手。
${exp==='step-by-step'?'我第一次使用 Agent，请一步步引导我。':exp==='balanced'?'我用过一些 Agent，请讲清关键步骤，必要时再解释。':'我经常使用 Agent，基础操作不用细讲。'}
${direction==='help-decide'?'我还没有确定通用还是专业方向，请了解我的工作和需要，再帮我比较，由我来选。':direction==='domain'?'我想创建专业领域助手，请先了解我从事的领域和要做的事情。':'我想创建通用个人助手，处理不同事情，记住我的习惯和常用方法。'}
请先给出创建方案，等我确认后再创建。不要把示例内容当成我的记忆或经验。

交流设置：${exp}。`;
  const options=step===0?experience:directions,current=step===0?exp:direction;
  const changeStep=(to:number)=>{setMovement(to>step?1:-1);setStep(to);};
  return <Page><button className="text-button back-home" onClick={home}><ArrowLeft size={18}/>返回总览</button><div className="create-layout"><aside className="create-aside"><span className="create-symbol"><Compass size={40} strokeWidth={1.3}/></span><h1>创建你的<br/>AI 助手。</h1><p>先选使用经验和大致用途，<br/>再让 Agent 帮你完善创建方案。</p><ol className="create-progress">{['使用经验','助手方向','核对选择'].map((s,i)=><li key={s} className={step===i?'current':i<step?'complete':''} aria-current={step===i?'step':undefined}><span>{i<step?<Check size={16}/>:i+1}</span>{s}</li>)}</ol></aside><section className="create-sheet"><Reveal key={step} kind="step" direction={movement}>{step<2?<><div className="section-label"><h2>{step===0?'你对 Agent 熟悉吗？':'你希望助手主要帮什么忙？'}</h2><Help label={step===0?'这会影响什么？':'还没想好可以选什么？'}>{step===0?'Agent 会据此调整讲解的详细程度。不会限制功能，创建后也能改。':'选“先帮我判断”，让 Agent 先了解你的工作和需要，再帮你比较通用助手与专业助手。方向由你决定。'}</Help></div><p className="muted">{step===0?'选最接近你现在情况的一项。':'选一个大致方向就好，还没想清楚也没关系。'}</p><div className="create-options">{options.map(o=><button key={o.id} className={current===o.id?'selected':''} aria-pressed={current===o.id} onClick={()=>step===0?setExp(o.id):setDirection(o.id)}><span className="option-icon"><o.Icon size={24}/></span><span><strong>{o.title}</strong><small>{o.description}</small></span><span className="choice-circle">{current===o.id&&<Check size={15}/>}</span></button>)}</div><div className="create-actions"><button className="text-button" onClick={()=>step===0?home():changeStep(step-1)}><ArrowLeft size={17}/>{step===0?'先不创建':'上一步'}</button><Primary disabled={!current} onClick={()=>changeStep(step+1)}>下一步</Primary></div></>:<><h2>确认这两项选择</h2><div className="review-choice"><small>使用经验</small><strong>{experience.find(o=>o.id===exp)?.title}</strong><button className="text-button" onClick={()=>changeStep(0)}>修改</button></div><div className="review-choice"><small>助手方向</small><strong>{directions.find(o=>o.id===direction)?.title}</strong><button className="text-button" onClick={()=>changeStep(1)}>修改</button></div><div className="create-next"><MessageCircle size={23}/><div><strong>把这些选择发给 Agent</strong><p>Agent 会继续了解你的需要，<br/>给出创建方案，确认后再创建。</p></div></div><Primary onClick={()=>ask({actionId:'instance.instantiate',title:'请 Agent 引导创建助手',body:requestBody})}>查看并复制创建请求</Primary><p className="preview-boundary">点击后可预览请求，再复制到 Agent 对话中发送。</p></>}</Reveal></section></div></Page>;
}
