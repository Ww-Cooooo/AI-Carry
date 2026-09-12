import {useEffect,useId,useRef,useState} from 'react';
import gsap from 'gsap';
import {useGSAP} from '@gsap/react';
import {Sparkles} from 'lucide-react';
import {useReducedMotion} from './shared';
import approvedBag from './assets/knowledge-bag.png';
import './knowledge-bag.css';

// Preserve the approved illustration. Only its foreground is clipped for layering;
// the source bitmap is unchanged. Card lettering is live, locally bundled MiSans.
const frontOutline='M267 494 Q278 515 352 541 Q391 556 441 565 Q448 541 475 548 Q520 553 548 590 Q610 609 683 616 Q708 600 753 590 Q787 581 802 608 Q914 597 987 555 L1004 548 Q1009 570 994 627 Q975 684 995 743 Q1034 819 1007 888 Q1027 952 1052 993 Q1074 1035 1055 1043 L991 1080 Q967 1102 902 1086 L797 1075 Q678 1097 549 1080 L420 1061 Q325 1069 288 1068 Q262 1067 241 1038 L213 1013 Q196 996 211 960 L265 859 Q259 813 258 790 Q258 760 287 698 Q302 664 292 627 L271 551 Q261 512 267 494 Z';
const cards=[
  {id:'memory',kind:'memories',label:'记忆',x:352,y:254,angle:-14,width:298,height:408,ink:'#2658b9',stroke:'#4e7cda',from:'#eef5ff',to:'#dbe9ff'},
  {id:'sop',kind:'sops',label:'SOP',x:684,y:212,angle:12.5,width:288,height:402,ink:'#7052a8',stroke:'#9a7cc8',from:'#f2edff',to:'#e4ddf8'},
  {id:'capability',kind:'capabilities',label:'能力',x:331,y:409,angle:-13,width:307,height:351,ink:'#33775c',stroke:'#669b81',from:'#eaf6ef',to:'#d9ece3'},
  {id:'experience',kind:'experiences',label:'经验',x:699,y:372,angle:12.5,width:290,height:351,ink:'#916522',stroke:'#c29a51',from:'#fff4df',to:'#f4e3c7'},
];

function CardIcon({kind}:{kind:string}){
  if(kind==='memory')return <path d="M4 0 H41 Q46 0 46 6 V64 L24 50 2 64 V6 Q2 0 4 0Z" fill="currentColor" opacity=".78"/>;
  if(kind==='sop')return <g fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round"><path d="M40 6 H23 C1 6 2 34 23 34 H34 C56 34 55 62 32 62 H18"/><circle cx="52" cy="4" r="12" fill="currentColor" stroke="none"/><circle cx="6" cy="64" r="12" fill="currentColor" stroke="none"/></g>;
  if(kind==='capability')return <path d="M35 -9 2 39 Q-1 44 6 44 H25 L17 78 Q17 83 21 76 L58 27 Q62 22 55 22 H35 L41 -7 Q41 -14 35 -9Z" fill="currentColor"/>;
  return <g fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round"><path d="M14 44 C-7 14 7 -3 27 -3 C47 -3 61 16 41 44 L37 52 H17Z" fill="currentColor" stroke="none"/><path d="M18 60 H36 M22 68 H32 M27 -20 V-30 M-3 -9 -10 -17 M57 -9 64 -17 M-10 17 H-19 M65 17 H73"/></g>;
}

export default function KnowledgeBag({active}:{active:boolean}){
  const root=useRef<HTMLDivElement>(null),timeline=useRef<gsap.core.Timeline|null>(null);
  const enabled=useRef(active),held=useRef({pointer:false,focus:false}),reduced=useReducedMotion(),[imageFailed,setImageFailed]=useState(false);
  const uid=useId().replace(/:/g,''),clipId=`bag-front-${uid}`,washId=`card-wash-${uid}`;
  enabled.current=active;
  const syncMotion=()=>{
    const tl=timeline.current;if(!tl)return;
    // Let the brief entrance finish before pointer dwell pauses the scene.
    tl.paused(!enabled.current||document.hidden||((held.current.pointer||held.current.focus)&&tl.time()>=2.4));
  };
  useEffect(()=>{
    syncMotion();document.addEventListener('visibilitychange',syncMotion);
    return()=>document.removeEventListener('visibilitychange',syncMotion);
  },[active]);
  useGSAP(()=>{
    if(reduced)return;
    const tl=gsap.timeline({paused:!enabled.current||document.hidden});timeline.current=tl;
    tl.fromTo('.carry-card',{y:-154,opacity:0},{y:0,opacity:1,stagger:.17,duration:1.45,ease:'power3.out'},.25)
      .fromTo('.bag-emphasis path',{strokeDashoffset:1},{strokeDashoffset:0,stagger:.09,duration:.42,ease:'power2.out'},1.4)
      .from('.bag-thread path,.bag-doodle-arrow path',{strokeDashoffset:1,stagger:.13,duration:1.6,ease:'power2.inOut'},.7)
      .to('.bag-star',{scale:.74,rotation:16,transformOrigin:'50% 50%',duration:2.4,stagger:.4,repeat:-1,yoyo:true,ease:'sine.inOut'},1.7)
      .call(syncMotion,[],2.4);
    const pack=gsap.timeline({repeat:-1,repeatDelay:5.5});
    pack.to('.carry-card',{y:-34,stagger:.12,duration:.95,ease:'sine.inOut'})
      .to('.carry-card',{y:30,stagger:.12,duration:1.25,ease:'power2.inOut'},1.05)
      .to('.carry-card',{y:0,stagger:.12,duration:.9,ease:'sine.out'},2.5);
    tl.add(pack,5.5);
    return()=>{tl.kill();timeline.current=null;};
  },{scope:root,dependencies:[reduced],revertOnUpdate:true});

  return <div ref={root} className="knowledge-bag" data-art="selected-a"
    onPointerEnter={()=>{held.current.pointer=true;syncMotion();}}
    onPointerLeave={()=>{held.current.pointer=false;syncMotion();}}
    onFocusCapture={()=>{held.current.focus=true;if(timeline.current&&timeline.current.time()<2.4)timeline.current.time(2.4);syncMotion();}}
    onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node)){held.current.focus=false;syncMotion();}}}>
    <div className="bag-signature" aria-hidden="true"><span>Made of</span><strong>your days.</strong><svg viewBox="0 0 120 19" fill="none"><path d="M3 12Q43 2 113 7M9 16Q57 8 102 11"/></svg></div>
    <svg className="knowledge-bag-art" viewBox="150 100 960 1040" role="group" aria-label="点击卡片，查看对应的积累" focusable="false">
      <defs>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse"><path d={frontOutline}/></clipPath>
        {cards.map(card=><linearGradient key={card.id} id={`${washId}-${card.id}`} x1="0" y1="0" x2="1" y2="1"><stop stopColor={card.from}/><stop offset="1" stopColor={card.to}/></linearGradient>)}
      </defs>
      <g className="bag-thread" transform="translate(46 76)" fill="none" aria-hidden="true"><path pathLength="1" d="M217 409C99 390 124 251 242 212"/><path pathLength="1" d="M205 422C82 391 111 251 205 221"/></g>
      <g className="bag-doodle-arrow" fill="none" aria-hidden="true"><path pathLength="1" d="M96 839C-7 850-13 731 88 723Q155 713 202 753M180 730 203 756 210 727"/><path pathLength="1" d="M94 850C19 855 4 781 41 751"/></g>
      <g className="bag-star" aria-hidden="true"><Sparkles x="1025" y="260" width="64" height="64" strokeWidth="1.3"/></g>
      <g className="bag-star bag-star--small" aria-hidden="true"><Sparkles x="164" y="581" width="39" height="39" strokeWidth="1.4"/></g>
      <g fill="none" stroke="#336dff" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M318 477 Q321 393 374 351 M270 497 Q310 474 365 463 M947 526 Q991 536 998 553"/>
      </g>
      {cards.map(card=><g className="carry-card" data-card={card.id} key={card.id}>
        <g transform={`translate(${card.x} ${card.y}) rotate(${card.angle})`}>
          <a className="carry-card-link" href={`#library?kind=${card.kind}`} aria-label={`查看${card.label}`} style={{color:card.ink}}>
            <title>查看{card.label}</title>
            <g className="carry-card-face">
              <rect className="carry-card-border" width={card.width} height={card.height} rx="39" fill="#fafbff" stroke={card.stroke} strokeWidth="5.5"/>
              <rect x="17" y="18" width={card.width-34} height={card.height-32} rx="30" fill={`url(#${washId}-${card.id})`}/>
              <g transform="translate(48 60)"><CardIcon kind={card.id}/></g>
              <text x={card.id==='sop'?129:124} y="111" className="carry-card-label">{card.label}</text>
              <rect className="carry-card-focus" x="-8" y="-8" width={card.width+16} height={card.height+16} rx="47" fill="none"/>
            </g>
          </a>
        </g>
      </g>)}
      {imageFailed?<g className="knowledge-bag-front" fill="#fafaf6" stroke="#336dff" strokeWidth="5.5" strokeLinejoin="round"><path d={frontOutline}/><path d="M446 565 C382 719 639 1057 775 1000 C875 958 820 674 790 608" fill="none"/></g>:<image className="knowledge-bag-front" href={approvedBag} x="0" y="0" width="1254" height="1254" clipPath={`url(#${clipId})`} onError={()=>setImageFailed(true)}/>}
      <g className="bag-emphasis" fill="none" stroke="#2868ff" strokeWidth="5.5" strokeLinecap="round" aria-hidden="true">
        <path d="M342 186 364 227" pathLength="1"/><path d="M291 239 333 262" pathLength="1"/><path d="M273 313 319 304" pathLength="1"/>
      </g>
      <text className="bag-card-hint" x="626" y="1156" textAnchor="middle">点卡片，看积累</text>
    </svg>
  </div>;
}
